import crypto from 'node:crypto';
import http from 'node:http';
import { config } from '../config.js';
import { formatAud } from '../utils/permissions.js';
import { getBuyer } from '../services/buyerService.js';
import { createScheduledEvent, eventUrl, removeSaleEvent, syncSaleEvent } from '../services/discordEventService.js';
import { getClaimedTotals, getClaimsForProduct, getLifetimeTotals } from '../services/orderService.js';
import { logToStaff } from '../services/staffLog.js';
import {
  createProduct,
  findProductByName,
  listAllProducts,
  setProductActive,
  setProductCost,
  setProductDescription,
  setProductMaxPerBuyer,
  setProductPrice,
  setProductShipping,
  updateProductStock,
} from '../services/productService.js';
import { PERIODS, money, profitFor } from '../services/profitService.js';
import { handleDashboard } from '../dashboard/dashboard.js';
import { syncWise } from '../services/wiseService.js';
import { untaggedPayments } from '../services/moneyService.js';
import { latestOrderSheet } from '../services/orderSheet.js';
import { getStreamLink, planStream, postLive, setStreamLink } from '../services/streamService.js';
import { checkChat, verifySignature } from '../services/zernioService.js';
import { getOrderByToken, openWholesaleOrders, orderCode } from '../services/wholesaleOrders.js';
import {
  handleInstagramDm, postFormAlert, startOrderFromText, startOrderFromWebsite,
} from '../handlers/wholesaleCards.js';
import { renderMissingPage, renderQuotePage } from './quotePage.js';
import {
  addProductToSale,
  cancelScheduledSale,
  createScheduledSale,
  findPendingSaleAt,
  isProductInOpenSale,
  listUpcomingSales,
  productsFor,
} from '../services/scheduledSaleService.js';
import {
  cancelScheduled,
  cleanupAttachments,
  formatMelbourne,
  listPending,
  melbourneToUtc,
  parseDate,
  readAttachments,
  saveAttachment,
  scheduleMessage,
} from '../services/scheduleService.js';

/**
 * A private door into the bot, so Claude can do what the staff slash
 * commands do from a plain-English request: queue a sale night, schedule a
 * post, make a Discord event, read what has been claimed.
 *
 * It only exists when OPS_SECRET is set, and every request must carry that
 * secret as a bearer token. Nothing here is reachable from Discord, and it
 * goes through the same services the slash commands use, so a sale queued
 * from here is indistinguishable from one queued with /newsale.
 *
 * The sale-night logic mirrors handleNewSale in commands/handlers.js. If one
 * changes, change the other.
 */

const MAX_BODY_BYTES = 1024 * 1024;
const CREATED_BY = 'claude';

class OpsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function fail(message, status = 400) {
  throw new OpsError(message, status);
}

/** Constant time, so the secret can't be guessed a character at a time. */
function authorised(req) {
  const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const wanted = Buffer.from(config.opsSecret);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

/**
 * Wrong secrets are counted per address, and an address that keeps getting
 * it wrong is shut out for a while. The secret is too long to guess anyway;
 * this stops anyone hammering the door and keeps the logs quiet if they try.
 */
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 15 * 60000;
const failures = new Map();

function clientAddress(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function lockedOut(address) {
  const entry = failures.get(address);
  if (!entry) return false;
  if (Date.now() - entry.first > FAIL_WINDOW_MS) {
    failures.delete(address);
    return false;
  }
  return entry.count >= FAIL_LIMIT;
}

function recordFailure(address) {
  const entry = failures.get(address);
  if (!entry || Date.now() - entry.first > FAIL_WINDOW_MS) failures.set(address, { first: Date.now(), count: 1 });
  else entry.count += 1;
}

/**
 * Pinging the whole server from here takes an explicit `ping: true`, so a
 * message can never @everyone 3,000 people by accident or by someone who
 * should not have the secret.
 */
function checkPings(message, ping) {
  if (/@(everyone|here)/.test(message) && ping !== true) {
    fail('That message pings @everyone or @here. Send ping: true if that is really wanted.');
  }
}

/** The body exactly as sent: a signature is checked against these bytes. */
function readRaw(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new OpsError('Request too big.', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Zernio retries a delivery it isn't sure arrived; each event runs once.
const seenZernioEvents = new Set();

/**
 * Zernio's DM alerts for wholesale orders. Signed with ZERNIO_WEBHOOK_SECRET
 * rather than the ops secret, and answered at once so Zernio never retries a
 * DM the bot is still working on.
 */
async function handleZernioHook(client, req, res) {
  const reply = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  let raw;
  try {
    raw = await readRaw(req);
  } catch {
    return reply(413, { ok: false });
  }
  if (!verifySignature(raw, req.headers['x-zernio-signature'])) return reply(401, { ok: false, error: 'Bad signature.' });
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return reply(400, { ok: false, error: 'Not JSON.' });
  }
  reply(200, { ok: true });
  if (payload.id) {
    if (seenZernioEvents.has(payload.id)) return undefined;
    seenZernioEvents.add(payload.id);
    if (seenZernioEvents.size > 1000) seenZernioEvents.delete(seenZernioEvents.values().next().value);
  }
  return handleInstagramDm(client, payload).catch((err) => console.error('Instagram DM failed:', err));
}

// Send order on the price page: at most this many new orders an hour from one
// address. Only orders actually made count, so a shop fixing a typo isn't
// held back, and if Netlify ever stops passing the shopper's address (so every
// order looks like it came from Netlify) real orders still get through.
const ORDER_LIMIT_PER_HOUR = 10;
const orderAttempts = new Map();
// Netlify can deliver one form submission twice; it alerts once.
const seenForms = new Set();

function signedWith(secret, raw, signature) {
  if (!secret || !signature) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(raw).digest('hex'));
  const given = Buffer.from(String(signature).trim().toLowerCase());
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/**
 * The website's doors into the bot, all public:
 *
 *   GET  /q/<token>               a shop's quote page (tcgpackbot.com/q/... via Netlify)
 *   POST /public/wholesale-order  Send order on the price page (tcgpackbot.com/api/wholesale-order)
 *   POST /public/form             the site's forms, passed on by its Netlify function, signed
 *
 * Returns true when it answered the request.
 */
async function handleWebsite(client, req, res, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const json = (status, payload, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(payload));
  };

  if (req.method === 'GET' && /^\/q\/[^/]+$/.test(path)) {
    const order = getOrderByToken(path.slice(3));
    res.writeHead(order ? 200 : 404, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
    });
    res.end(order ? renderQuotePage(order) : renderMissingPage());
    return true;
  }

  if (path === '/public/wholesale-order') {
    const origin = req.headers.origin;
    const cors = origin && config.siteOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
      res.end();
      return true;
    }
    if (req.method !== 'POST') return false;
    if (origin && !cors['Access-Control-Allow-Origin']) {
      json(403, { ok: false, error: 'Orders come through tcgpackbot.com.' });
      return true;
    }
    const from = String(req.headers['x-nf-client-connection-ip'] || clientAddress(req));
    const recent = (orderAttempts.get(from) || []).filter((t) => Date.now() - t < 3600000);
    orderAttempts.set(from, recent);
    if (recent.length >= ORDER_LIMIT_PER_HOUR) {
      json(429, { ok: false, error: 'Lots of orders from here in the last hour. Message us on Instagram instead.' }, cors);
      return true;
    }
    let body;
    try {
      body = JSON.parse((await readRaw(req, 64 * 1024)) || '{}');
    } catch {
      json(400, { ok: false, error: 'That order didn\'t come through properly. Try again.' }, cors);
      return true;
    }
    try {
      const result = await startOrderFromWebsite(client, body);
      if (result.error) json(400, { ok: false, error: result.error }, cors);
      else {
        if (!result.duplicate && !result.ignored) orderAttempts.set(from, [...recent, Date.now()]);
        json(200, { ok: true, code: result.code, quoteUrl: result.quoteUrl, contactMethod: result.contactMethod }, cors);
      }
    } catch (err) {
      console.error('Website order failed:', err);
      json(500, { ok: false, error: 'Something went wrong on our end. Tap Copy my order and message it to us instead.' }, cors);
    }
    return true;
  }

  if (req.method === 'POST' && path === '/public/form') {
    let raw;
    try {
      raw = await readRaw(req, 256 * 1024);
    } catch {
      json(413, { ok: false });
      return true;
    }
    if (!signedWith(config.formsSecret, raw, req.headers['x-forms-signature'])) {
      json(401, { ok: false, error: 'Bad signature.' });
      return true;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      json(400, { ok: false });
      return true;
    }
    json(200, { ok: true });
    if (payload.id) {
      if (seenForms.has(payload.id)) return true;
      seenForms.add(payload.id);
      if (seenForms.size > 500) seenForms.delete(seenForms.values().next().value);
    }
    postFormAlert(client, { form: payload.form, data: payload.data || {} })
      .catch((err) => console.error('Website form alert failed:', err));
    return true;
  }
  return false;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new OpsError('Request too big. Send image links, not the images themselves.', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new OpsError('Body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Images arrive as links (a Canva export, a Drive link). They are copied to
 * the volume straight away, for the same reason the slash commands do it:
 * the link may be dead by the night the post goes out.
 */
async function saveImages(urls) {
  const list = (Array.isArray(urls) ? urls : urls ? [urls] : []).slice(0, 3);
  const files = [];
  for (const url of list) {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'image.png');
    const saved = await saveAttachment({ url, name, size: 0 });
    if (saved) files.push(saved);
  }
  return files;
}

/**
 * Finds a text channel by id, mention, or name. An exact name wins; a
 * partial match is only used when exactly one channel fits, so "claim"
 * never quietly picks the wrong one of two.
 */
async function resolveChannel(client, input) {
  const raw = String(input ?? '').trim().replace(/^<#(\d+)>$/, '$1').replace(/^#/, '');
  if (!raw) fail('Say which channel.');

  const guild = await client.guilds.fetch(config.guildId);
  if (/^\d+$/.test(raw)) {
    const byId = await guild.channels.fetch(raw).catch(() => null);
    if (byId?.isTextBased?.()) return byId;
  }

  const text = [...(await guild.channels.fetch()).values()].filter((c) => c?.isTextBased?.());
  const wanted = raw.toLowerCase();
  const exact = text.find((c) => c.name.toLowerCase() === wanted);
  if (exact) return exact;

  const partial = text.filter((c) => c.name.toLowerCase().includes(wanted));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) fail(`"${input}" could be ${partial.map((c) => `#${c.name}`).join(', ')}. Say which.`);
  fail(`No text channel called "${input}".`);
}

function productSummary(p) {
  return {
    name: p.name,
    display: p.display_name || null,
    price: formatAud(p.price_cents),
    unit: p.unit || 'box',
    stock: p.quantity_available,
    live: Boolean(p.active),
  };
}

function saleSummary(sale) {
  return {
    id: sale.id,
    status: sale.status,
    prices_posted: sale.announce_at ? formatMelbourne(sale.announce_at) : null,
    opens: formatMelbourne(sale.start_at),
    closes: formatMelbourne(sale.end_at),
    images: readAttachments(sale).length,
    products: productsFor(sale).map(productSummary),
  };
}

/** Start, end and price-post times for one night, in Melbourne time. */
function saleTimes({ date, start = '20:00', end = '00:00', announce = '19:00' }) {
  const day = parseDate(date);
  if (!day) fail(`Could not read the date "${date}". Use something like 18/10 or sat.`);

  const startAt = melbourneToUtc(day, start);
  let endAt = melbourneToUtc(day, end);
  if (!startAt || !endAt) fail('Could not read those times. Use something like 8pm.');

  // Midnight is the next day, not four hours before the sale starts.
  if (endAt.getTime() <= startAt.getTime()) {
    const [y, m, d] = day.split('-').map(Number);
    endAt = melbourneToUtc(new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10), end);
  }
  if (endAt.getTime() <= Date.now()) fail('That sale would already be over. Pick a later night.');

  let announceAt = melbourneToUtc(day, announce);
  if (!announceAt || announceAt.getTime() >= startAt.getTime()) announceAt = null;
  return { startAt, endAt, announceAt };
}

const routes = {
  'GET /ops/health': async () => ({ text: 'Bot is up.' }),

  'GET /ops/products': async () => ({ products: listAllProducts().map(productSummary) }),

  'GET /ops/sales': async () => {
    const sales = listUpcomingSales().map(saleSummary);
    return { text: sales.length ? `${sales.length} queued.` : 'No sales queued.', sales };
  },

  /** Same as /newsale: make or update the product and queue its night (and its event). */
  'POST /ops/sales': async (client, body) => {
    const name = String(body.name ?? '').trim();
    const price = Number(body.price);
    const quantity = Number(body.quantity);
    if (!name) fail('Give the product a short name (what people type to claim).');
    if (!(price > 0)) fail('Give a price.');
    if (!Number.isInteger(quantity) || quantity <= 0) fail('Give how many are in stock.');
    const shipping = body.shipping === undefined ? null : Number(body.shipping);
    const limit = body.limit === undefined ? null : Number(body.limit);

    const { startAt, endAt, announceAt } = saleTimes(body);

    let product = findProductByName(name);
    const isNew = !product;
    if (product) {
      setProductPrice(product.id, Math.round(price * 100));
      updateProductStock(product.id, quantity, { reactivate: false });
      if (shipping !== null) setProductShipping(product.id, Math.round(shipping * 100));
      if (limit !== null) setProductMaxPerBuyer(product.id, limit);
      // A night still to come doesn't open claims now: the sale switches it on at the start.
      if (startAt.getTime() > Date.now() && !isProductInOpenSale(product.id)) setProductActive(product.id, false);
    } else {
      product = createProduct({
        name,
        priceCents: Math.round(price * 100),
        quantity,
        shippingCents: Math.round((shipping ?? config.standardShippingCents / 100) * 100),
        maxPerBuyer: limit,
      });
      // The scheduled sale decides when claims open, not the product.
      setProductActive(product.id, false);
    }
    // What one cost, landed, so /profit knows without anyone typing it later.
    if (body.cost !== undefined && body.cost !== null) {
      const cost = Number(body.cost);
      if (!(cost >= 0)) fail('cost must be a number of dollars, e.g. 101.50.');
      setProductCost(product.id, Math.round(cost * 100));
    }

    const lines = Array.isArray(body.lines) ? body.lines.filter(Boolean).slice(0, 3) : [];
    product = setProductDescription(product.id, {
      displayName: body.display ?? undefined,
      details: lines.length ? lines.join('\n') : undefined,
      unit: body.unit ?? undefined,
    });

    const files = await saveImages(body.images);
    const existing = findPendingSaleAt(startAt.toISOString());
    const sale = existing
      ? addProductToSale(existing.id, product.id, files)
      : createScheduledSale({
        attachments: files,
        productIds: [product.id],
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        channelId: config.claimsChannelId,
        createdBy: CREATED_BY,
        announceAt: config.announceChannelId && announceAt ? announceAt.toISOString() : null,
        announceChannelId: announceAt ? config.announceChannelId : null,
        note: body.note ?? null,
        title: body.title ?? null,
      });

    const guild = await client.guilds.fetch(config.guildId);
    const event = await syncSaleEvent(guild, sale);
    return {
      text: `${isNew ? 'Created' : 'Updated'} ${product.name} and `
        + `${existing ? 'added it to the sale already queued that night' : 'scheduled the sale'}.`
        + (event.ok
          ? ` Event ${event.kept ? 'already there (made by hand, left alone)' : event.updated ? 'updated' : 'made'}.`
          : ` No Discord event: ${event.reason}`),
      sale: saleSummary(sale),
      event: event.ok ? eventUrl(guild.id, event.event.id) : null,
    };
  },

  'POST /ops/sales/cancel': async (client, body) => {
    const result = cancelScheduledSale(Number(body.id));
    if (!result.ok) fail('That sale has already finished or been cancelled.', 404);
    const guild = await client.guilds.fetch(config.guildId);
    const removed = await removeSaleEvent(guild, result.sale);
    return {
      text: `Cancelled the sale set for ${formatMelbourne(result.sale.start_at)}.`
        + (result.sale.status === 'open' ? ' It was already live, so run /endsale to close it properly.' : '')
        + (!removed.ok ? ` Could not delete its event: ${removed.reason}`
          : removed.kept ? ' Its event was made by hand, so delete it yourself.'
            : removed.found ? ' Its event is deleted too.' : ''),
    };
  },

  'GET /ops/messages': async () => ({
    messages: listPending().map((r) => ({
      id: r.id,
      sends: formatMelbourne(r.send_at),
      channel_id: r.channel_id,
      repeats: r.repeat_every || null,
      images: readAttachments(r).length,
      message: r.content,
    })),
  }),

  /** Same as /schedule. */
  'POST /ops/messages': async (client, body) => {
    const message = String(body.message ?? '').trim();
    if (!message) fail('Say what the message should say.');
    const when = melbourneToUtc(body.date, body.time);
    if (!when) fail('Could not read that date and time. Use something like 18/10 and 7pm.');
    if (when.getTime() <= Date.now()) fail(`${formatMelbourne(when.toISOString())} is in the past.`);
    if (body.repeat && !['daily', 'weekly'].includes(body.repeat)) fail('Repeat can only be daily or weekly.');
    checkPings(message, body.ping);

    const channel = await resolveChannel(client, body.channel);
    const row = scheduleMessage({
      channelId: channel.id,
      content: message,
      sendAt: when.toISOString(),
      repeatEvery: body.repeat || null,
      createdBy: CREATED_BY,
      attachments: await saveImages(body.images),
    });
    return { text: `Scheduled for ${formatMelbourne(row.send_at)} in #${channel.name}.`, id: row.id };
  },

  'POST /ops/messages/cancel': async (_client, body) => {
    const result = cancelScheduled(Number(body.id));
    if (!result.ok) fail('That one has already been sent or cancelled.', 404);
    cleanupAttachments(result.row);
    return { text: `Cancelled the message set for ${formatMelbourne(result.row.send_at)}.` };
  },

  /** Posts straight away rather than queueing. */
  'POST /ops/post': async (client, body) => {
    const message = String(body.message ?? '').trim();
    const urls = (Array.isArray(body.images) ? body.images : body.images ? [body.images] : []).slice(0, 3);
    if (!message && !urls.length) fail('Nothing to post.');
    checkPings(message, body.ping);
    const channel = await resolveChannel(client, body.channel);
    const sent = await channel.send({
      content: message || undefined,
      files: urls,
      allowedMentions: { parse: body.ping === true ? ['everyone', 'roles', 'users'] : ['users'] },
    });
    return { text: `Posted in #${channel.name}.`, url: sent.url };
  },

  /** Same as /event: a Discord event at the top of the server. */
  'POST /ops/events': async (client, body) => {
    const title = String(body.title ?? '').trim();
    if (!title) fail('Give the event a title.');
    const start = melbourneToUtc(body.date, body.time);
    if (!start) fail('Could not read that date and time. Use something like 18/10 and 8pm.');

    const guild = await client.guilds.fetch(config.guildId);
    const hours = Number(body.hours) || 4;
    const result = await createScheduledEvent(guild, {
      title,
      start,
      hours,
      where: body.where || 'Discord',
      details: body.details || null,
      image: body.image ? { url: body.image } : null,
    });
    if (!result.ok) fail(result.reason);

    return {
      text: `${title} is up: ${formatMelbourne(start.toISOString())} to ${formatMelbourne(result.end.toISOString())}.`
        + (result.imageSkipped ? ' Could not fetch the picture, so it has no cover image.' : ''),
      url: eventUrl(guild.id, result.event.id),
    };
  },

  /** Same as /cost: what one unit of a product cost, landed. */
  'POST /ops/cost': async (_client, body) => {
    const product = findProductByName(String(body.name ?? '').trim());
    if (!product) fail('No product by that name. GET /ops/products lists them.');
    const cost = Number(body.cost);
    if (!(cost >= 0)) fail('cost must be a number of dollars, e.g. 101.50.');
    const actual = body.actual !== false;
    setProductCost(product.id, Math.round(cost * 100), { actual, fix: body.fix === true });
    return { text: `${product.name} now costs ${money(Math.round(cost * 100))} each (${actual ? 'real cost' : 'estimate'}).` };
  },

  /** Same as /profit: sales, costs and profit for a period (?period=week&product=storm). */
  'GET /ops/profit': async (_client, _body, query) => {
    const period = query.get('period') || 'week';
    if (!PERIODS[period]) fail(`period must be one of: ${Object.keys(PERIODS).join(', ')}.`);
    return profitFor(period, { product: query.get('product') || null });
  },

  /** Same as /stream plan: the show's event, and its "we're live" post queued for the start. */
  'POST /ops/stream/plan': async (client, body) => {
    const guild = await client.guilds.fetch(config.guildId);
    const result = await planStream(client, guild, {
      date: body.date, time: body.time, title: body.title || null, hours: Number(body.hours) || 2, ping: body.ping === true,
    });
    if (result.error) fail(result.error.replace(/`/g, ''));
    return {
      text: `Show planned for ${formatMelbourne(result.start.toISOString())}; "we're live" posts then.`,
      event: eventUrl(guild.id, result.event.id),
      postId: result.postId,
    };
  },

  /** Same as /stream live: "we're live" in announcements now. */
  'POST /ops/stream/live': async (client, body) => {
    const result = await postLive(client, { title: body.title || null, ping: body.ping === true });
    if (result.error) fail(result.error.replace(/`/g, ''));
    return { text: 'Posted.', url: result.url };
  },

  'GET /ops/stream': async () => ({ link: getStreamLink() }),

  /** Open wholesale orders, and where each is up to. */
  'GET /ops/wholesale': async () => ({
    orders: openWholesaleOrders().map((o) => ({
      code: orderCode(o), customer: o.customer_name, instagram: o.customer_username, status: o.status,
      boxes: o.boxes_cents / 100, shipping: o.shipping_cents == null ? null : o.shipping_cents / 100, lines: o.lines,
    })),
  }),

  /**
   * Checks ZERNIO_API_KEY by reading the @tcgpackbot inbox (it sends
   * nothing), and says until when the bot can ask the supplier for shipping.
   */
  'GET /ops/zernio': async () => {
    const supplier = `@${config.wholesaleSupplier}`;
    const check = await checkChat(config.wholesaleSupplier).catch((err) => fail(`Zernio turned the key down: ${err.message}`, 502));
    if (!check.key) fail('ZERNIO_API_KEY is not set on Railway yet.');
    if (!check.chat) return { ...check, text: `The key works, but there is no chat with ${supplier} on @tcgpackbot yet.` };
    const text = check.open
      ? `The key works. ${supplier} last messaged ${formatMelbourne(check.lastFromThem)}, so the bot can message them until ${formatMelbourne(check.canMessageUntil)}.`
      : `The key works, but ${supplier} hasn't messaged in the last 24 hours, so the bot can't message them until they do.`;
    return { ...check, text };
  },

  /** Same as /wholesale new: an order card from what a shop asked for. */
  'POST /ops/wholesale': async (client, body) => {
    const result = await startOrderFromText(client, { username: String(body.instagram || '').replace(/^@/, ''), items: String(body.items || ''), name: body.name || null });
    if (result.error) fail(result.error);
    return { text: `${orderCode(result.order)} is up for @${result.order.customer_username}.`, url: result.url };
  },

  /** Same as /stream link. */
  'POST /ops/stream/link': async (_client, body) => {
    const result = setStreamLink(body.url);
    if (result.error) fail(result.error);
    return { text: `Saved ${result.link}.`, platform: result.platform };
  },

  /** Same as /ordersheet: the last sale night's order, with today's numbers. */
  'GET /ops/ordersheet': async () => {
    const latest = latestOrderSheet();
    if (!latest) fail('No sale has closed since the order sheet was added.');
    return { title: latest.title, text: latest.text, closed: latest.entry.closedAt, sheet: latest.sheet };
  },

  /**
   * Syncs Wise now and says what came back: counts, errors and the five
   * newest payments still to tag. For checking the read-only token works.
   */
  'GET /ops/wise': async () => {
    const result = await syncWise();
    const waiting = untaggedPayments(200);
    return {
      ...result,
      untagged: waiting.length,
      newest: waiting.slice(0, 5).map((p) => ({
        when: p.happened_at, direction: p.direction, who: p.counterparty, amount: `${(p.amount / 100).toFixed(2)} ${p.currency}`,
        aud: p.aud_cents == null ? null : (p.aud_cents / 100).toFixed(2), status: p.status,
      })),
    };
  },

  /** Lifetime sales and the member count, for the website's trust numbers. */
  'GET /ops/stats': async (client, _body, query) => {
    const exclude = String(query.get('exclude') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const guild = await client.guilds.fetch(config.guildId);
    return { members: guild.memberCount, ...getLifetimeTotals(exclude) };
  },

  /**
   * Every message in one channel, oldest first, with its attachments. Made
   * for pulling the testimonials onto the website. Discord signs attachment
   * links and they expire within about a day, so whatever reads this has to
   * save the images straight away rather than keep the links.
   */
  'GET /ops/channel-messages': async (client, _body, query) => {
    const channel = await resolveChannel(client, query.get('channel'));
    const limit = Math.min(Number(query.get('limit')) || 500, 2000);
    const messages = [];
    let before;
    while (messages.length < limit) {
      const batch = await channel.messages.fetch({ limit: 100, before });
      if (!batch.size) break;
      messages.push(...batch.values());
      before = batch.last().id;
      if (batch.size < 100) break;
    }

    return {
      channel: channel.name,
      count: Math.min(messages.length, limit),
      messages: messages.slice(0, limit).reverse().map((m) => ({
        id: m.id,
        at: m.createdAt.toISOString(),
        author: m.member?.displayName || m.author.globalName || m.author.username,
        author_is_bot: m.author.bot,
        text: m.content,
        reactions: [...m.reactions.cache.values()].reduce((n, r) => n + r.count, 0),
        attachments: [...m.attachments.values()].map((a) => ({
          url: a.url, name: a.name, type: a.contentType, width: a.width, height: a.height, size: a.size,
        })),
      })),
    };
  },

  /** Same as /claimed: what to order, or who claimed one product. */
  'GET /ops/claimed': async (_client, _body, query) => {
    const hours = Number(query.get('since_hours')) || null;
    const sinceIso = hours ? new Date(Date.now() - hours * 3600000).toISOString() : null;
    const product = query.get('product');

    if (product) {
      const rows = getClaimsForProduct(product, sinceIso);
      return {
        product,
        total: rows.reduce((n, r) => n + r.quantity, 0),
        claims: rows.map((r) => ({
          buyer: getBuyer(r.buyer_id)?.name || r.buyer_id,
          quantity: r.quantity,
          paid: r.status !== 'pending',
          claimed: r.claimed_at ? r.claimed_at.slice(0, 10) : null,
        })),
      };
    }

    const totals = getClaimedTotals(sinceIso);
    return {
      total: totals.reduce((n, t) => n + t.total, 0),
      products: totals.map((t) => ({
        product: t.product_name, total: t.total, paid: t.paid, unpaid: t.pending, buyers: t.buyers, oldest: t.oldest,
      })),
    };
  },
};

/*
 * The website's sale banner and "next claim sales" list read GET /public/sales.
 * It needs no secret on purpose and only ever shows what anyone in the server
 * can already see: which products are on, and when the sale opens and closes.
 * No prices (those go out at 7pm), no stock, no buyers. Kept for 30 seconds so
 * every page view doesn't touch the database.
 */
const PUBLIC_MAX_AGE_MS = 30000;
let publicCache = { at: 0, body: null };

export function publicSales() {
  if (publicCache.body && Date.now() - publicCache.at < PUBLIC_MAX_AGE_MS) return publicCache.body;
  const sales = listUpcomingSales()
    .map((s) => {
      const names = productsFor(s).map((p) => p.display_name || p.name);
      return {
        title: s.title || names.join(' + '),
        products: names,
        live: s.status === 'open',
        start: s.start_at,
        end: s.end_at,
      };
    })
    .filter((s) => s.products.length)
    .slice(0, 6);
  publicCache = { at: Date.now(), body: { sales, now: new Date().toISOString() } };
  return publicCache.body;
}

export function startOpsServer(client) {
  if (!config.opsSecret) return;

  const server = http.createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    const url = new URL(req.url, 'http://ops');
    const key = `${req.method} ${url.pathname.replace(/\/+$/, '')}`;

    // Public, before any secret check, and never counted as a failed attempt.
    if (key === 'GET /public/sales') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=30',
      });
      try {
        return res.end(JSON.stringify(publicSales()));
      } catch (err) {
        console.error('Public sales feed failed:', err);
        return res.end(JSON.stringify({ sales: [], now: new Date().toISOString() }));
      }
    }

    if (key === 'POST /hooks/zernio') return handleZernioHook(client, req, res);
    if (await handleWebsite(client, req, res, url)) return undefined;

    // The profit dashboard has its own sign-in (a link from /dashboard, then a cookie).
    if (url.pathname === '/dash' || url.pathname.startsWith('/dash/')) {
      return handleDashboard(client, req, res, url);
    }

    const address = clientAddress(req);
    if (lockedOut(address)) return send(429, { ok: false, error: 'Too many wrong attempts. Try later.' });
    if (!authorised(req)) {
      recordFailure(address);
      return send(401, { ok: false, error: 'Not authorised.' });
    }
    failures.delete(address);

    const route = routes[key];
    if (!route) return send(404, { ok: false, error: `Nothing at ${key}.`, routes: Object.keys(routes) });

    try {
      const body = req.method === 'POST' ? await readJson(req) : {};
      const result = await route(client, body, url.searchParams);
      console.log(`Ops ${key} ok`);
      // Every change made through here is posted to the staff log, so one
      // that nobody asked for stands out straight away.
      if (req.method === 'POST') {
        logToStaff(client, {
          title: 'Done through Claude',
          description: `${result.text || key}${result.url ? `\n${result.url}` : ''}`.slice(0, 4000),
          color: 0x5865f2,
        });
      }
      send(200, { ok: true, ...result });
    } catch (err) {
      const status = err instanceof OpsError ? err.status : 500;
      if (status === 500) console.error(`Ops ${key} failed:`, err);
      send(status, { ok: false, error: err.message });
    }
  });

  server.listen(config.opsPort, () => console.log(`Ops door listening on ${server.address().port}`));
  return server;
}

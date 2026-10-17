import crypto from 'node:crypto';
import http from 'node:http';
import { config } from '../config.js';
import { formatAud } from '../utils/permissions.js';
import { getBuyer } from '../services/buyerService.js';
import { createScheduledEvent, eventUrl } from '../services/discordEventService.js';
import { getClaimedTotals, getClaimsForProduct } from '../services/orderService.js';
import { logToStaff } from '../services/staffLog.js';
import {
  createProduct,
  findProductByName,
  listAllProducts,
  setProductActive,
  setProductDescription,
  setProductMaxPerBuyer,
  setProductPrice,
  setProductShipping,
  updateProductStock,
} from '../services/productService.js';
import {
  addProductToSale,
  cancelScheduledSale,
  createScheduledSale,
  findPendingSaleAt,
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

  /** Same as /newsale: make or update the product and queue its night. */
  'POST /ops/sales': async (_client, body) => {
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
      updateProductStock(product.id, quantity);
      if (shipping !== null) setProductShipping(product.id, Math.round(shipping * 100));
      if (limit !== null) setProductMaxPerBuyer(product.id, limit);
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

    return {
      text: `${isNew ? 'Created' : 'Updated'} ${product.name} and `
        + `${existing ? 'added it to the sale already queued that night' : 'scheduled the sale'}.`,
      sale: saleSummary(sale),
    };
  },

  'POST /ops/sales/cancel': async (_client, body) => {
    const result = cancelScheduledSale(Number(body.id));
    if (!result.ok) fail('That sale has already finished or been cancelled.', 404);
    return {
      text: `Cancelled the sale set for ${formatMelbourne(result.sale.start_at)}.`
        + (result.sale.status === 'open' ? ' It was already live, so run /endsale to close it properly.' : ''),
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

export function startOpsServer(client) {
  if (!config.opsSecret) return;

  const server = http.createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    const url = new URL(req.url, 'http://ops');
    const key = `${req.method} ${url.pathname.replace(/\/+$/, '')}`;
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

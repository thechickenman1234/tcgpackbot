import crypto from 'node:crypto';
import { config } from '../config.js';
import { logToStaff } from '../services/staffLog.js';
import { getProductById, listAllProducts, setProductCost } from '../services/productService.js';
import {
  PERIODS,
  addExpense,
  deleteExpense,
  estimatedCosts,
  listExpenses,
  money,
  periodRange,
  profitFor,
  soldOrders,
  summarise,
} from '../services/profitService.js';
import { ZONE } from '../services/scheduleService.js';
import { statsFor } from '../services/statsService.js';
import { addWholesaleSale, moneySummary, tagPayment, untagPayment } from '../services/moneyService.js';
import { syncWise } from '../services/wiseService.js';
import { batchView, getStockBatch, setStep, stockBoard } from '../services/stockTracker.js';
import { healthReport } from '../services/healthService.js';
import { refreshStockCard } from '../handlers/stockCard.js';
import {
  addToLabelList, makeLabels, remakeLabels, searchBuyers, shipOrders, shippingBoard, unshipFromBoard,
} from '../services/shippingBoard.js';
import { pushToSheetInBackground } from '../services/sheetService.js';
import { postTrackingToThread } from '../services/trackingService.js';
import { grantBuyerRole } from '../services/buyerRoleService.js';
import {
  addCodes, matchCode, readCodesFromFiles, readCodesFromText, sendCodes, shipTicked, skipCode, summaryText, unmatchCode,
} from '../services/trackingCodes.js';
import { connectUrl, disconnectEbay, ebayConnected, ebayKeys } from '../services/ebayService.js';
import {
  adjustShelf, checkMarket, pushListings, saveEbaySettings, setListing, turnOnOutOfStockControl,
} from '../services/ebayListings.js';
import { markHandled, replyToMessage } from '../services/ebayInbox.js';
import { ebayBoard } from '../services/ebayBoard.js';
import { kickEbay, runEbaySync } from '../jobs/ebaySync.js';
import { renderDashboardPage, renderMessagePage } from './page.js';

/**
 * The profit dashboard: costs and expenses typed in on a phone instead of
 * slash commands, and the profit they make, served by the bot itself on the
 * same port as the ops door.
 *
 * Getting in: staff run /dashboard and get a link that works once, for 15
 * minutes. Opening it leaves a cookie that keeps that phone signed in for
 * 30 days. Both are signed with a key made from OPS_SECRET, so rotating that
 * secret signs everyone out. Changes need the cookie plus an X-Dash header,
 * which another website can't send, and each one is posted to the staff log.
 */

const COOKIE = 'tpb_dash';
let lastManualSync = 0;
let lastEbaySync = 0;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const LINK_TTL_MS = 15 * 60000;
const SESSION_TTL_MS = 30 * 86400000;
const MAX_BODY_BYTES = 64 * 1024;
// Label PDFs for a whole post office run, as base64.
const UPLOAD_MAX_BYTES = 35 * 1024 * 1024;
const usedLinks = new Map();

const signingKey = () => crypto.createHmac('sha256', config.opsSecret).update('tcgpackbot-dashboard-v1').digest();

function sign(data) {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', signingKey()).update(body).digest('base64url')}`;
}

function verify(token, kind) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(crypto.createHmac('sha256', signingKey()).update(body).digest('base64url'));
  const given = Buffer.from(sig);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return data.k === kind && data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

export function dashboardUrl() {
  return config.publicUrl ? `${config.publicUrl}/dash` : null;
}

/** A one-time sign-in link for one staff member, or null if the dashboard can't run. */
export function loginLink(userId) {
  if (!config.publicUrl || !config.opsSecret) return null;
  const token = sign({ k: 'link', u: userId, exp: Date.now() + LINK_TTL_MS, n: crypto.randomBytes(9).toString('base64url') });
  return `${config.publicUrl}/dash/login?t=${token}`;
}

function session(req) {
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  return verify(cookies[COOKIE], 'session');
}

function readJson(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('That\'s too much at once. Upload up to 25 MB of labels at a time.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

/** "101.50", "$101.50" or a total over units, "3524/40", as cents for one unit. */
export function parseUnitCost(input) {
  const text = String(input ?? '').replace(/[$,\s]/g, '');
  const m = text.match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
  if (!m) return null;
  const cents = Math.round((Number(m[1]) / (m[2] ? Number(m[2]) : 1)) * 100);
  return Number.isFinite(cents) && cents >= 0 && cents < 10_000_000 ? cents : null;
}

function todayInMelbourne() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const tile = (key) => {
  const s = profitFor(key);
  return {
    key, label: s.label, sales: s.sales, profit: s.profit, net: s.net, expenses: s.expenses,
    margin: s.margin, estimated: s.estimatedSales > 0, missing: s.missing.length,
  };
};

/** Everything the page shows, in one go. */
export function dashboardData(period = 'month') {
  const key = PERIODS[period] ? period : 'month';
  const detail = profitFor(key);
  const now = Date.now();
  const recent = summarise(soldOrders({ sinceIso: new Date(now - 60 * 86400000).toISOString() }));
  const sold90 = new Map(summarise(soldOrders({ sinceIso: new Date(now - 90 * 86400000).toISOString() }))
    .products.map((p) => [p.productId, p]));

  const productRow = (p) => ({
    id: p.id,
    name: p.name,
    display: p.display_name || null,
    cost: p.cost_cents,
    actual: Boolean(p.cost_actual),
    sold90: sold90.get(p.id)?.units || 0,
    active: Boolean(p.active),
  });

  return {
    tiles: ['week', 'month', 'last_month'].map(tile),
    period: key,
    periods: PERIODS,
    detail: {
      label: detail.label,
      sales: detail.sales,
      stock: detail.stock,
      postage: detail.postage,
      fees: detail.fees,
      profit: detail.profit,
      expenses: detail.expenses,
      net: detail.net,
      margin: detail.margin,
      orders: detail.orders,
      units: detail.units,
      estimatedSales: detail.estimatedSales,
      uncountedSales: detail.sales - detail.costedSales,
      products: detail.products,
    },
    money: moneySummary(key),
    todo: {
      noCost: recent.missing.map((m) => ({ id: m.productId, name: m.product, units: m.units })),
      estimated: estimatedCosts().map((p) => {
        const product = getProductById(p.productId);
        return { id: p.productId, name: p.product, units: p.units, cost: product?.cost_cents ?? null };
      }),
    },
    products: listAllProducts()
      .map(productRow)
      .sort((a, b) => b.sold90 - a.sold90 || Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)),
    expenses: listExpenses({ sinceIso: periodRange('last_month').sinceIso, limit: 60 }),
    today: todayInMelbourne(),
    labelCosts: { standard: config.labelCostStandardCents, express: config.labelCostExpressCents },
  };
}

// ---------------------------------------------------------------- stats

const DAY_MS = 86400000;
let memberCache = { at: 0, data: null };
const userNames = new Map();

/** Who's in the server and when they joined, from Discord, at most every 10 minutes. */
async function memberSnapshot(client) {
  if (memberCache.data && Date.now() - memberCache.at < 10 * 60000) return memberCache.data;
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const members = await guild.members.fetch();
    const humans = members.filter((m) => !m.user.bot);
    const cutoff = (d) => Date.now() - d * DAY_MS;
    memberCache = {
      at: Date.now(),
      data: {
        total: guild.memberCount,
        ids: new Set(humans.map((m) => m.id)),
        joined30: humans.filter((m) => m.joinedTimestamp >= cutoff(30)).size,
        joined60: humans.filter((m) => m.joinedTimestamp >= cutoff(60)).map((m) => m.id),
      },
    };
  } catch (err) {
    console.error('Dashboard: could not read members:', err.message);
  }
  return memberCache.data;
}

async function nameOf(client, id) {
  if (!id) return null;
  if (!userNames.has(id)) {
    const user = await client.users.fetch(id).catch(() => null);
    userNames.set(id, user ? user.globalName || user.username : null);
  }
  return userNames.get(id);
}

const statsCache = new Map();

/** The stats for one period, worked out at most once a minute. */
export async function dashboardStats(client, period = 'month') {
  const key = PERIODS[period] ? period : 'month';
  const cached = statsCache.get(key);
  if (cached && Date.now() - cached.at < 60000) return cached.data;
  const members = client ? await memberSnapshot(client) : null;
  const data = statsFor(key, { members });
  for (const link of data.community.invites.links.slice(0, 15)) link.inviter = await nameOf(client, link.inviterId);
  statsCache.set(key, { at: Date.now(), data });
  return data;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(html);
}

const audit = (client, who, text) => logToStaff(client, {
  title: 'Changed on the dashboard',
  description: `${text}\nby <@${who}>`.slice(0, 4000),
  color: 0x5865f2,
});

/** An eBay change: runs it, and turns eBay's refusal into words on the page rather than a 500. */
async function viaEbay(fn) {
  if (!ebayConnected()) return { status: 400, error: 'eBay isn\'t connected. Press Connect eBay first.' };
  try {
    return await fn();
  } catch (err) {
    console.error('Dashboard eBay action failed:', err);
    return { status: 502, error: `eBay said: ${err.message}` };
  }
}

const pushedText = (r) => (r.failed.length ? ` eBay didn't take it: ${r.failed[0]}` : r.pushed ? ' eBay is updated.' : '');

const actions = {
  'POST /dash/api/ebay/listing': async (client, who, body) => viaEbay(async () => {
    const r = setListing(String(body.itemId || ''), body);
    if (r.error) return { status: 400, error: r.error };
    const p = await pushListings({ itemIds: [r.row.item_id] });
    audit(client, who, `eBay listing **${r.row.title}** changed: ${Object.keys(body).filter((k) => k !== 'itemId').join(', ')}.`);
    return { text: `Saved.${pushedText(p)}` };
  }),
  'POST /dash/api/ebay/shelf': async (client, who, body) => viaEbay(async () => {
    const r = adjustShelf(String(body.itemId || ''), body.delta);
    if (r.error) return { status: 400, error: r.error };
    const p = await pushListings({ itemIds: [r.row.item_id] });
    audit(client, who, `eBay shelf, **${r.row.title}**: ${Number(body.delta) > 0 ? '+' : ''}${Number(body.delta)}, now ${r.onHand}.`);
    return { text: `${r.onHand} on the shelf.${pushedText(p)}` };
  }),
  'POST /dash/api/ebay/price': async (client, who, body) => viaEbay(async () => {
    const p = await pushListings({ itemIds: [String(body.itemId || '')], acceptHeld: true });
    audit(client, who, `eBay price change OK'd for listing ${String(body.itemId || '')}.`);
    return p.pushed ? { text: 'New price is on eBay.' } : { status: 400, error: p.failed[0] || 'Nothing to change. Reload the page.' };
  }),
  'POST /dash/api/ebay/market': async (client, who, body) => viaEbay(async () => {
    const found = await checkMarket(String(body.itemId || ''));
    if (!found) return { status: 404, error: 'That listing is gone. Press Sync now.' };
    return { text: found.length ? `Cheapest in Australia: ${money(found[0].cents)} delivered.` : 'Nobody else in Australia has it listed new right now.' };
  }),
  'POST /dash/api/ebay/settings': async (client, who, body) => {
    const r = saveEbaySettings(body);
    if (r.error) return { status: 400, error: r.error };
    audit(client, who, `eBay settings changed: ${Object.keys(body).join(', ')}.`);
    if (!ebayConnected()) return { text: 'Saved.' };
    const p = await pushListings().catch((err) => ({ pushed: 0, failed: [err.message] }));
    return { text: `Saved.${pushedText(p)}` };
  },
  'POST /dash/api/ebay/oos': async (client, who) => viaEbay(async () => {
    await turnOnOutOfStockControl();
    audit(client, who, 'eBay out-of-stock control turned on.');
    const p = await pushListings();
    return { text: `Out-of-stock control is on: a listing at 0 stays up, hidden, until you restock.${pushedText(p)}` };
  }),
  'POST /dash/api/ebay/reply': async (client, who, body) => viaEbay(async () => {
    const r = await replyToMessage(String(body.id || ''), body.text);
    if (r.error) return { status: 400, error: r.error };
    audit(client, who, `eBay reply sent: "${String(body.text || '').slice(0, 300)}"`);
    return { text: r.text };
  }),
  'POST /dash/api/ebay/handled': async (client, who, body) => {
    const r = markHandled(String(body.id || ''));
    return r.error ? { status: 400, error: r.error } : { text: r.text };
  },
  'POST /dash/api/ebay/sync': async (client) => viaEbay(async () => {
    if (Date.now() - lastEbaySync < 30000) return { status: 429, error: 'Synced under a minute ago. Try again shortly.' };
    lastEbaySync = Date.now();
    const r = await runEbaySync(client, { full: true });
    const o = r.orders || {};
    return { text: r.errors.length ? `Synced, with problems: ${r.errors.join('; ')}` : `Synced${o.added ? `: ${plural(o.added, 'new order')}` : ''}.` };
  }),
  'POST /dash/api/ebay/disconnect': async (client, who) => {
    disconnectEbay();
    audit(client, who, 'eBay disconnected from the bot.');
    return { text: 'eBay is disconnected. Nothing changes on eBay itself.' };
  },
  'POST /dash/api/cost': async (client, who, body) => {
    const product = getProductById(Number(body.productId));
    if (!product) return { status: 404, error: 'That product is gone. Reload the page.' };
    const cents = parseUnitCost(body.value);
    if (cents == null) return { status: 400, error: 'Type a cost like 101.50, or a total over how many, like 3524/40.' };
    const actual = body.actual !== false;
    setProductCost(product.id, cents, { actual, fix: body.fix === true });
    audit(client, who, `**${product.name}** costs ${money(cents)} each (${actual ? 'real cost' : 'estimate'}).`);
    return { text: `${product.name}: ${money(cents)} each, ${actual ? 'real cost' : 'estimate'}.` };
  },
  'POST /dash/api/expense': async (client, who, body) => {
    const cents = parseUnitCost(body.amount);
    const what = String(body.what ?? '').trim().slice(0, 120);
    const spentOn = String(body.date ?? '');
    if (!cents) return { status: 400, error: 'Type how much it cost.' };
    if (!what) return { status: 400, error: 'Say what it was for.' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) return { status: 400, error: 'Pick the date.' };
    addExpense({ spentOn, amountCents: cents, what });
    audit(client, who, `Expense added: ${money(cents)} for ${what} (${spentOn}).`);
    return { text: 'Added.' };
  },
  'POST /dash/api/wise/tag': async (client, who, body) => {
    const result = tagPayment(String(body.id || ''), {
      tag: body.tag, productId: body.productId, units: body.units, setCost: body.setCost !== false, note: body.note ? String(body.note).slice(0, 120) : null,
    });
    if (result.error) return { status: 400, error: result.error };
    audit(client, who, `Wise payment tagged as ${body.tag}: ${result.text}`);
    return { text: result.text };
  },
  'POST /dash/api/wise/untag': async (client, who, body) => {
    const result = untagPayment(String(body.id || ''));
    if (result.error) return { status: 400, error: result.error };
    return { text: result.text };
  },
  'POST /dash/api/wise/sync': async () => {
    if (Date.now() - lastManualSync < 60000) return { status: 429, error: 'Synced under a minute ago. Try again shortly.' };
    lastManualSync = Date.now();
    const r = await syncWise();
    if (!r.connected) return { status: 400, error: r.error };
    const added = r.outNew + r.inNew;
    return { text: r.ok ? `Synced: ${plural(added, 'new payment')}.${r.errors.length ? ` (${r.errors.join('; ')})` : ''}` : `Wise sync failed: ${r.errors.join('; ')}` };
  },
  'POST /dash/api/wholesale': async (client, who, body) => {
    const totalCents = parseUnitCost(body.total);
    const result = addWholesaleSale({
      customer: body.customer, productId: body.productId || null, productName: body.productName || null,
      quantity: Number(body.quantity), totalCents, date: /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? body.date : null,
      sent: body.sent !== false, paymentId: body.paymentId || null,
    });
    if (result.error) return { status: 400, error: result.error };
    audit(client, who, result.text);
    return { text: result.text };
  },
  'POST /dash/api/stock/step': async (client, who, body) => {
    const done = body.done !== false;
    const result = setStep(Number(body.id), String(body.step || ''), done, { note: body.note == null ? null : String(body.note) });
    if (result.error) return { status: 400, error: result.error };
    const batch = getStockBatch(Number(body.id));
    const v = batchView(batch);
    audit(client, who, `Stock, ${v.title}: ${result.text}`);
    // Keep the card in the staff log the same as the dashboard.
    await refreshStockCard(client, v);
    return { text: result.text };
  },
  'POST /dash/api/ship': async (client, who, body) => {
    // A code typed on one parcel is Add tracking; ticked parcels send any
    // uploaded code waiting on them, and the rest go as Mark posted.
    const result = body.tracking ? shipOrders(body.ids, { tracking: body.tracking }) : await shipTicked(client, body.ids);
    if (result.error) return { status: 400, error: result.error };
    if (body.tracking) {
      await postTrackingToThread(client, result.shipped[0]);
      pushToSheetInBackground(result.shipped, 'posted');
    }
    if (result.shipped.some((o) => o.source === 'ebay')) kickEbay(client);
    const names = result.shipped.map((o) => `${o.quantity}x ${o.product_name} (${o.reference_code})`);
    audit(client, who, `Marked shipped: ${names.slice(0, 15).join(', ')}${names.length > 15 ? ` and ${names.length - 15} more` : ''}${body.tracking ? ', tracking sent to the buyer' : result.told ? `, ${result.told} told their tracking` : ''}.`);
    return { text: result.text };
  },
  'POST /dash/api/tracking/upload': async (client, who, body) => {
    const files = Array.isArray(body.files) ? body.files.slice(0, 20) : [];
    const entries = [...readCodesFromText(body.text), ...await readCodesFromFiles(files)];
    if (!entries.length) return { status: 400, error: 'Pick the label files, or paste the codes.' };
    const result = addCodes(entries);
    const text = summaryText(result);
    audit(client, who, `Tracking codes uploaded: ${text}`);
    return { text };
  },
  'POST /dash/api/tracking/match': async (client, who, body) => {
    const result = matchCode(body.id, body.orderId);
    return result.error ? { status: 400, error: result.error } : { text: result.text };
  },
  'POST /dash/api/tracking/unmatch': async (client, who, body) => {
    const result = unmatchCode(body.id);
    return result.error ? { status: 400, error: result.error } : { text: result.text };
  },
  'POST /dash/api/tracking/skip': async (client, who, body) => {
    const result = skipCode(body.id);
    return result.error ? { status: 400, error: result.error } : { text: result.text };
  },
  'POST /dash/api/tracking/send': async (client, who, body) => {
    const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 300);
    if (!ids.length) return { status: 400, error: 'Nothing to send.' };
    const r = await sendCodes(client, ids);
    if (!r.sent.length) return { status: 400, error: 'Those were already sent. Reload the page.' };
    if (r.ebay) kickEbay(client);
    audit(client, who, `Tracking sent for parcels already marked shipped: ${r.sent.map((o) => o.reference_code).join(', ')}.`);
    return { text: `Tracking sent for ${r.sent.length}, ${r.told} told in their ticket.${r.noTicket.length ? ` No ticket: ${r.noTicket.slice(0, 4).join(', ')}.` : ''}` };
  },
  'POST /dash/api/unship': async (client, who, body) => {
    const result = unshipFromBoard(body.id);
    if (result.error) return { status: 400, error: result.error };
    pushToSheetInBackground([result.order], 'unship');
    audit(client, who, `Back on the shipping list: ${result.order.quantity}x ${result.order.product_name} (${result.order.reference_code}).`);
    return { text: result.text };
  },
  'POST /dash/api/labels': async (client, who, body) => {
    const result = body.batchId ? remakeLabels(Number(body.batchId)) : makeLabels(Number(body.productId), who);
    if (result.error) return { status: 400, error: result.error };
    pushToSheetInBackground(result.orders, 'labels');
    audit(client, who, `Labels ${body.batchId ? 'made again' : 'made'}: batch ${result.batchId}, ${result.orders.length} parcels.`);
    const warn = result.missing.length ? ` ${result.missing.length} have no address yet: ${result.missing.slice(0, 5).join(', ')}.` : '';
    return { text: `Labels for ${result.orders.length} parcels downloaded.${warn}`, csv: result.csv, filename: result.filename };
  },
  'POST /dash/api/label-person': async (client, who, body) => {
    const result = addToLabelList(body);
    if (result.error) return { status: 400, error: result.error };
    pushToSheetInBackground([result.order], 'logsale');
    await grantBuyerRole(client, result.order.buyer_id).catch(() => false);
    audit(client, who, result.text);
    return { text: result.text };
  },
  'POST /dash/api/expense/delete': async (client, who, body) => {
    if (!deleteExpense(Number(body.id))) return { status: 404, error: 'Already gone. Reload the page.' };
    audit(client, who, `Expense #${Number(body.id)} deleted.`);
    return { text: 'Deleted.' };
  },
};

/** Handles everything under /dash. The ops server hands these over before its own secret check. */
export async function handleDashboard(client, req, res, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/dash';
  try {
    if (!config.opsSecret) return sendHtml(res, 503, renderMessagePage('The dashboard is switched off.'));

    if (req.method === 'GET' && path === '/dash/login') {
      const link = verify(url.searchParams.get('t'), 'link');
      if (!link || usedLinks.has(link.n)) {
        return sendHtml(res, 401, renderMessagePage('That link has expired or was already used. Run /dashboard in Discord for a new one.'));
      }
      usedLinks.set(link.n, link.exp);
      for (const [n, exp] of usedLinks) if (exp < Date.now()) usedLinks.delete(n);
      const cookie = sign({ k: 'session', u: link.u, exp: Date.now() + SESSION_TTL_MS });
      res.writeHead(303, {
        Location: '/dash',
        'Set-Cookie': `${COOKIE}=${cookie}; Path=/dash; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`,
        'Cache-Control': 'no-store',
      });
      return res.end();
    }

    const who = session(req);
    if (!who) {
      if (path.startsWith('/dash/api/')) return sendJson(res, 401, { ok: false, error: 'Signed out. Run /dashboard in Discord for a new link.' });
      return sendHtml(res, 401, renderMessagePage('Run /dashboard in Discord to open your dashboard on this phone.'));
    }

    if (req.method === 'GET' && path === '/dash') return sendHtml(res, 200, renderDashboardPage());
    if (req.method === 'GET' && path === '/dash/api/stats') {
      return sendJson(res, 200, { ok: true, ...(await dashboardStats(client, url.searchParams.get('period') || 'month')) });
    }
    if (req.method === 'GET' && path === '/dash/api/data') {
      return sendJson(res, 200, { ok: true, ...dashboardData(url.searchParams.get('period') || 'month') });
    }
    if (req.method === 'GET' && path === '/dash/api/ops') {
      return sendJson(res, 200, { ok: true, stock: stockBoard(), health: await healthReport(), shipping: shippingBoard(), ebay: ebayBoard() });
    }
    if (req.method === 'GET' && path === '/dash/ebay/connect') {
      if (!ebayKeys()) return sendHtml(res, 400, renderMessagePage('The eBay keys aren\'t on Railway yet, so there\'s nothing to connect.', { href: '/dash#ebay', text: 'Back to the dashboard' }));
      res.writeHead(303, { Location: connectUrl({ scopeSet: url.searchParams.get('basic') ? 'core' : 'full' }), 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (req.method === 'GET' && path === '/dash/api/buyers') {
      return sendJson(res, 200, { ok: true, buyers: searchBuyers(url.searchParams.get('q')) });
    }

    const action = actions[`${req.method} ${path}`];
    if (!action) return sendJson(res, 404, { ok: false, error: 'Nothing here.' });
    // A form on another website can't add this header, so it can't make changes.
    if (req.headers['x-dash'] !== '1') return sendJson(res, 403, { ok: false, error: 'Refused.' });
    const result = await action(client, who.u, await readJson(req, path === '/dash/api/tracking/upload' ? UPLOAD_MAX_BYTES : MAX_BODY_BYTES));
    if (result.error) return sendJson(res, result.status || 400, { ok: false, error: result.error });
    statsCache.clear();
    return sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    if (err.status === 413) return sendJson(res, 413, { ok: false, error: err.message });
    console.error(`Dashboard ${req.method} ${path} failed:`, err);
    return sendJson(res, 500, { ok: false, error: 'Something went wrong. Try again.' });
  }
}

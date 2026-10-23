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
const LINK_TTL_MS = 15 * 60000;
const SESSION_TTL_MS = 30 * 86400000;
const MAX_BODY_BYTES = 64 * 1024;
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

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too big'));
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

const actions = {
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

    const action = actions[`${req.method} ${path}`];
    if (!action) return sendJson(res, 404, { ok: false, error: 'Nothing here.' });
    // A form on another website can't add this header, so it can't make changes.
    if (req.headers['x-dash'] !== '1') return sendJson(res, 403, { ok: false, error: 'Refused.' });
    const result = await action(client, who.u, await readJson(req));
    if (result.error) return sendJson(res, result.status || 400, { ok: false, error: result.error });
    statsCache.clear();
    return sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    console.error(`Dashboard ${req.method} ${path} failed:`, err);
    return sendJson(res, 500, { ok: false, error: 'Something went wrong. Try again.' });
  }
}

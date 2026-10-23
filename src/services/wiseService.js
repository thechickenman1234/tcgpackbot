import { getDb } from '../db/database.js';
import { config } from '../config.js';
import { getMeta, setMeta } from './metaService.js';

/**
 * Pulls every payment in and out of Wise, with a read-only API token, into
 * wise_payments for Lachy to tag on the dashboard (moneyService).
 *
 *   out  transfers (GET /v1/transfers): supplier payments, freight, his own
 *        transfers. The AUD side is what left his AUD balance.
 *   in   money received, from the account activity feed. Wise's personal
 *        API is thin on incoming payments, so this part is best effort and
 *        never stops the outgoing side.
 *
 * A payment to or from his own name is tagged "not business" on arrival.
 * Re-syncing only updates what Wise can change (status, amounts); a tag is
 * never touched once it's set.
 */

const BASE = 'https://api.wise.com';
const DEAD = new Set(['cancelled', 'funds_refunded', 'bounced_back', 'charged_back']);

class WiseError extends Error {
  constructor(status, body) {
    super(`Wise said ${status}${body ? `: ${body}` : ''}`);
    this.status = status;
  }
}

async function wise(path) {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${config.wiseToken}`, Accept: 'application/json' } });
  if (!res.ok) throw new WiseError(res.status, (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160));
  return res.json();
}

const hundredths = (n) => Math.round(Number(n) * 100);
const isOwn = (name) => name && config.wiseOwnName
  && name.toLowerCase().replace(/[^a-z]/g, '').includes(config.wiseOwnName.toLowerCase().replace(/[^a-z]/g, ''));

/** "+ 1,234.56 AUD" or "<b>1,234 JPY</b>" as { amount, currency }. */
export function parseAmount(text) {
  const t = String(text || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ');
  const m = t.match(/([+-])?\s*([\d,]+(?:\.\d+)?)\s*([A-Z]{3})/);
  if (!m) return null;
  return { sign: m[1] || '', amount: hundredths(m[2].replace(/,/g, '')), currency: m[3] };
}

const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

function audFor(amount, currency, otherAmount, otherCurrency) {
  if (currency === 'AUD') return { cents: amount, estimated: false };
  if (otherCurrency === 'AUD' && otherAmount != null) return { cents: otherAmount, estimated: false };
  if (currency === 'JPY') return { cents: Math.round(amount / config.jpyPerAud), estimated: true };
  return { cents: null, estimated: false };
}

function upsert(p) {
  const now = new Date().toISOString();
  const db = getDb();
  const existing = db.prepare('SELECT id, tag FROM wise_payments WHERE id = ?').get(p.id);
  const aud = audFor(p.amount, p.currency, p.otherAmount, p.otherCurrency);
  if (existing) {
    db.prepare(`
      UPDATE wise_payments SET status = ?, amount = ?, currency = ?, aud_cents = ?, aud_estimated = ?,
        other_amount = ?, other_currency = ?, counterparty = COALESCE(?, counterparty), synced_at = ?
      WHERE id = ?
    `).run(p.status, p.amount, p.currency, aud.cents, aud.estimated ? 1 : 0, p.otherAmount, p.otherCurrency, p.counterparty, now, p.id);
    return false;
  }
  db.prepare(`
    INSERT INTO wise_payments (id, direction, happened_at, amount, currency, aud_cents, aud_estimated,
      other_amount, other_currency, counterparty, reference, status, tag, tagged_at, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(p.id, p.direction, p.happenedAt, p.amount, p.currency, aud.cents, aud.estimated ? 1 : 0,
    p.otherAmount, p.otherCurrency, p.counterparty, p.reference, p.status,
    isOwn(p.counterparty) ? 'ignore' : null, isOwn(p.counterparty) ? now : null, now);
  return true;
}

const recipients = new Map();

async function recipientName(accountId) {
  if (!accountId) return null;
  if (recipients.has(accountId)) return recipients.get(accountId);
  let name = null;
  try {
    const a = await wise(`/v1/accounts/${accountId}`);
    name = a.accountHolderName || a.name?.fullName || null;
  } catch {
    try {
      const a = await wise(`/v2/accounts/${accountId}`);
      name = a.name?.fullName || a.accountHolderName || null;
    } catch {
      name = null;
    }
  }
  recipients.set(accountId, name);
  return name;
}

/** Wise's "2026-10-18 12:59:08" (UTC) as ISO. */
const wiseTime = (s) => (s ? new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z')).toISOString() : new Date().toISOString());

async function syncTransfers(profileId, since) {
  let added = 0;
  let seen = 0;
  for (let offset = 0; offset < 5000; offset += 100) {
    const list = await wise(`/v1/transfers?profile=${profileId}&limit=100&offset=${offset}&createdDateStart=${since}`);
    if (!Array.isArray(list) || !list.length) break;
    for (const t of list) {
      seen += 1;
      if (upsert({
        id: `transfer:${t.id}`,
        direction: 'out',
        happenedAt: wiseTime(t.created),
        amount: hundredths(t.sourceValue),
        currency: t.sourceCurrency,
        otherAmount: t.targetCurrency !== t.sourceCurrency ? hundredths(t.targetValue) : null,
        otherCurrency: t.targetCurrency !== t.sourceCurrency ? t.targetCurrency : null,
        counterparty: await recipientName(t.targetAccount),
        reference: t.reference || t.details?.reference || null,
        status: t.status,
      })) added += 1;
    }
    if (list.length < 100) break;
  }
  return { seen, added };
}

/** Money received, from the activity feed: anything with a "+" amount that isn't a transfer we already have. */
async function syncIncoming(profileId, since) {
  let added = 0;
  let seen = 0;
  let cursor = null;
  for (let page = 0; page < 50; page += 1) {
    const q = `size=100&since=${encodeURIComponent(new Date(`${since}T00:00:00Z`).toISOString())}${cursor ? `&nextCursor=${encodeURIComponent(cursor)}` : ''}`;
    const data = await wise(`/v1/profiles/${profileId}/activities?${q}`);
    const list = data.activities || [];
    for (const a of list) {
      // Moving money between his own currency balances isn't money in.
      if (/CONVERSION|EXCHANGE/i.test(a.type || '')) continue;
      const amt = parseAmount(a.primaryAmount);
      if (!amt || amt.sign !== '+') continue;
      seen += 1;
      const other = parseAmount(a.secondaryAmount);
      if (upsert({
        id: `activity:${a.id}`,
        direction: 'in',
        happenedAt: a.createdOn ? new Date(a.createdOn).toISOString() : new Date().toISOString(),
        amount: amt.amount,
        currency: amt.currency,
        otherAmount: other && other.currency !== amt.currency ? other.amount : null,
        otherCurrency: other && other.currency !== amt.currency ? other.currency : null,
        counterparty: stripTags(a.title) || null,
        reference: stripTags(a.description) || null,
        status: String(a.status || '').toLowerCase() || null,
      })) added += 1;
    }
    cursor = data.cursor || data.nextCursor || null;
    if (!cursor || !list.length) break;
  }
  return { seen, added };
}

/** One full sync. Returns what happened; the last result is kept for the dashboard. */
export async function syncWise({ since = config.wiseSince } = {}) {
  if (!config.wiseToken) return { ok: false, connected: false, error: 'No Wise token yet: add WISE_API_TOKEN on Railway.' };
  const result = { ok: true, connected: true, profiles: 0, out: 0, outNew: 0, in: 0, inNew: 0, errors: [] };
  try {
    const profiles = await wise('/v2/profiles');
    for (const p of Array.isArray(profiles) ? profiles : []) {
      result.profiles += 1;
      try {
        const t = await syncTransfers(p.id, since);
        result.out += t.seen;
        result.outNew += t.added;
      } catch (err) {
        result.errors.push(`payments out: ${err.message}`);
      }
      try {
        const i = await syncIncoming(p.id, since);
        result.in += i.seen;
        result.inNew += i.added;
      } catch (err) {
        result.errors.push(`money in: ${err.message}`);
      }
    }
  } catch (err) {
    result.ok = false;
    result.errors.push(err.message);
  }
  setMeta('wise_synced_at', new Date().toISOString());
  setMeta('wise_last_result', JSON.stringify(result));
  return result;
}

export function wiseStatus() {
  let last = null;
  try {
    last = JSON.parse(getMeta('wise_last_result') || 'null');
  } catch {
    last = null;
  }
  return { connected: Boolean(config.wiseToken), syncedAt: getMeta('wise_synced_at'), last };
}

export function isDead(status) {
  return DEAD.has(String(status || '').toLowerCase());
}

export function startWiseSyncJob(intervalMs = 3 * 3600000) {
  if (!config.wiseToken) return null;
  const tick = () => syncWise().catch((err) => console.error('Wise sync failed:', err.message));
  setTimeout(tick, 2 * 60000);
  return setInterval(tick, intervalMs);
}

import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { getMeta, setMeta } from './metaService.js';
import { getProductById } from './productService.js';

/**
 * Each sale night's stock, from claims closing to the last parcel posted:
 *
 *   Claims closed   when the order sheet goes out
 *   Ordered         staff tap it (order sheet card or dashboard)
 *   Supplier paid   a Wise payment tagged as stock for one of its products,
 *                   or a tap until Wise is connected
 *   On its way      a tap, with the tracking or arrival date if known
 *   Arrived         the first labels printed for it, or a tap
 *   Packed          every paid order has a label
 *   All posted      every paid order has gone out, and nobody is left to pay
 *
 * A later step being done means the earlier ones happened, so stock that
 * has arrived never nags about being ordered. A night's orders are its
 * products' claims from when the sale opened until the same product's next
 * sale night, test buyers left out, the same as the order sheet counts.
 */

const DAY = 86400000;
const HOUR = 3600000;
// The order sheet treats a sale that closes twice in one night as one night.
const SAME_NIGHT = 12 * HOUR;
const BACKFILL_DAYS = 45;
const SHOW_DONE_DAYS = 7;

// How long a step can wait before the night shows as stuck.
const LIMITS = { order: 2 * DAY, ship: 7 * DAY, arrive: 14 * DAY, post: 3 * DAY };

export const STEPS = [
  { key: 'closed', label: 'Claims closed' },
  { key: 'ordered', label: 'Ordered', manual: true },
  { key: 'paid', label: 'Supplier paid', manual: true },
  { key: 'onway', label: 'On its way', manual: true },
  { key: 'arrived', label: 'Arrived', manual: true },
  { key: 'packed', label: 'Packed' },
  { key: 'posted', label: 'All posted' },
];

const COLUMN = { ordered: 'ordered_at', paid: 'supplier_paid_at', onway: 'on_way_at', arrived: 'arrived_at' };

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const parseIds = (batch) => {
  try {
    return JSON.parse(batch.product_ids).map(Number).filter(Boolean);
  } catch {
    return [];
  }
};
const latest = (isos) => isos.filter(Boolean).sort().at(-1) || null;
const earliest = (isos) => isos.filter(Boolean).sort()[0] || null;

export function getStockBatch(id) {
  return getDb().prepare('SELECT * FROM stock_batches WHERE id = ?').get(Number(id)) || null;
}

function allBatches() {
  return getDb().prepare('SELECT * FROM stock_batches ORDER BY since_at, id').all();
}

/** One per night: a second close of the same products within 12 hours is the same night. */
export function createStockBatch({ productIds, sinceIso, closedAt }) {
  const ids = [...new Set(productIds.map(Number))].filter(Boolean).sort((a, b) => a - b);
  if (!ids.length || !sinceIso || !closedAt) return null;
  const key = JSON.stringify(ids);
  const same = getDb().prepare('SELECT * FROM stock_batches WHERE product_ids = ? ORDER BY closed_at DESC LIMIT 1').get(key);
  if (same && Math.abs(Date.parse(closedAt) - Date.parse(same.closed_at)) < SAME_NIGHT) return same;
  const r = getDb().prepare('INSERT INTO stock_batches (product_ids, since_at, closed_at, created_at) VALUES (?, ?, ?, ?)')
    .run(key, sinceIso, closedAt, new Date().toISOString());
  return getStockBatch(r.lastInsertRowid);
}

export function setCardLocation(id, channelId, messageId) {
  getDb().prepare('UPDATE stock_batches SET card_channel_id = ?, card_message_id = ? WHERE id = ?').run(channelId, messageId, Number(id));
}

/** Ticks or unticks a step staff tap. Undoing only clears the tap: an automatic tick stays. */
export function setStep(id, step, done, { note = null, now = new Date() } = {}) {
  const column = COLUMN[step];
  if (!column) return { error: 'That step ticks itself.' };
  const batch = getStockBatch(id);
  if (!batch) return { error: 'That stock night is gone.' };
  const db = getDb();
  if (done) {
    db.prepare(`UPDATE stock_batches SET ${column} = COALESCE(${column}, ?) WHERE id = ?`).run(now.toISOString(), batch.id);
    if (step === 'onway' && note != null) db.prepare('UPDATE stock_batches SET on_way_note = ? WHERE id = ?').run(String(note).trim().slice(0, 200) || null, batch.id);
  } else {
    db.prepare(`UPDATE stock_batches SET ${column} = NULL${step === 'onway' ? ', on_way_note = NULL' : ''}, done_at = NULL WHERE id = ?`).run(batch.id);
  }
  const label = STEPS.find((s) => s.key === step).label;
  return { ok: true, text: `${done ? 'Ticked' : 'Unticked'}: ${label}.` };
}

function ordersFor(batch, batches) {
  const ex = config.profitExcludeBuyerIds;
  const notTests = ex.length ? `AND o.buyer_id NOT IN (${ex.map(() => '?').join(', ')})` : '';
  const stmt = getDb().prepare(`
    SELECT o.id, o.status, o.quantity, o.label_batch_id, o.shipped_at, lb.created_at AS printed_at
    FROM orders o LEFT JOIN label_batches lb ON lb.id = o.label_batch_id
    WHERE o.product_id = ? AND o.claimed_at >= ? AND (? IS NULL OR o.claimed_at < ?)
      AND o.source IN ('claim', 'late') AND o.status != 'cancelled' ${notTests}
  `);
  return parseIds(batch).flatMap((productId) => {
    const next = batches.find((b) => b.id !== batch.id && b.since_at > batch.since_at && parseIds(b).includes(productId));
    const until = next ? next.since_at : null;
    return stmt.all(productId, batch.since_at, until, until, ...ex);
  });
}

function wisePaidAt(batch) {
  const ids = parseIds(batch);
  if (!ids.length) return null;
  return getDb().prepare(`
    SELECT MIN(happened_at) AS at FROM wise_payments
    WHERE tag = 'stock' AND product_id IN (${ids.map(() => '?').join(', ')}) AND happened_at >= ?
  `).get(...ids, batch.since_at)?.at || null;
}

function titleOf(batch) {
  return parseIds(batch).map((id) => getProductById(id)).filter(Boolean)
    .map((p) => p.display_name || p.name).join(' + ') || 'Products since removed';
}

/** Where one night's stock is up to, and whether it's stuck. */
export function batchView(batch, { batches = allBatches(), now = new Date() } = {}) {
  const orders = ordersFor(batch, batches);
  const units = (xs) => xs.reduce((n, o) => n + o.quantity, 0);
  const sold = orders.filter((o) => o.status !== 'pending');
  const pending = orders.filter((o) => o.status === 'pending');
  const posted = sold.filter((o) => o.status === 'shipped' || o.status === 'archived');
  const packed = sold.filter((o) => o.label_batch_id || o.status === 'shipped' || o.status === 'archived');
  const firstOut = earliest(sold.map((o) => o.printed_at || o.shipped_at));
  const wise = batch.supplier_paid_at ? null : wisePaidAt(batch);

  const at = {
    closed: batch.closed_at,
    ordered: batch.ordered_at,
    paid: batch.supplier_paid_at || wise,
    onway: batch.on_way_at,
    arrived: batch.arrived_at || firstOut,
    packed: sold.length && packed.length === sold.length ? latest(packed.map((o) => o.printed_at || o.shipped_at)) || firstOut : null,
    posted: sold.length && !pending.length && posted.length === sold.length ? latest(posted.map((o) => o.shipped_at)) : null,
  };
  const lastDone = STEPS.map((s) => Boolean(at[s.key])).lastIndexOf(true);
  const steps = STEPS.map((s, i) => ({
    key: s.key,
    label: s.label,
    manual: Boolean(s.manual),
    at: at[s.key] || null,
    done: Boolean(at[s.key]),
    implied: !at[s.key] && i < lastDone,
    tapped: Boolean(COLUMN[s.key] && batch[COLUMN[s.key]]),
    auto: (s.key === 'paid' && !batch.supplier_paid_at && Boolean(wise)) || (s.key === 'arrived' && !batch.arrived_at && Boolean(firstOut)),
  }));
  const stage = steps.find((s) => !s.done && !s.implied)?.key || null;

  // Nothing paid and nobody left to pay: there's no stock to track.
  const empty = !sold.length && !pending.length;
  const done = empty || !stage;
  if (done && !batch.done_at) {
    const doneAt = at.posted || batch.closed_at;
    getDb().prepare('UPDATE stock_batches SET done_at = ? WHERE id = ?').run(doneAt, batch.id);
    batch.done_at = doneAt;
  }

  let stuck = null;
  const since = (key) => (at[key] ? now.getTime() - Date.parse(at[key]) : 0);
  const days = (ms) => plural(Math.floor(ms / DAY), 'day');
  const toPost = units(sold) - units(posted);
  if (!done) {
    if (stage === 'ordered' && since('closed') > LIMITS.order) {
      stuck = { level: 'bad', text: `Not marked ordered, ${days(since('closed'))} after the sale` };
    } else if ((stage === 'paid' || stage === 'onway') && at.ordered && since('ordered') > LIMITS.ship) {
      stuck = { level: 'warn', text: `Ordered ${days(since('ordered'))} ago, not marked on its way` };
    } else if (stage === 'arrived' && at.onway && since('onway') > LIMITS.arrive) {
      stuck = { level: 'bad', text: `On its way for ${days(since('onway'))}` };
    } else if ((stage === 'packed' || stage === 'posted') && at.arrived && since('arrived') > LIMITS.post && toPost > 0) {
      stuck = { level: 'bad', text: `Arrived ${days(since('arrived'))} ago, ${plural(toPost, 'unit')} still to post` };
    }
  }

  return {
    id: batch.id,
    title: titleOf(batch),
    closedAt: batch.closed_at,
    note: batch.on_way_note || null,
    units: { claimed: units(orders), paid: units(sold), toPay: units(pending), packed: units(packed), posted: units(posted) },
    steps,
    stage,
    done,
    empty,
    doneAt: batch.done_at || null,
    stuck,
    card: batch.card_message_id ? { channelId: batch.card_channel_id, messageId: batch.card_message_id } : null,
  };
}

/** Every night still in progress, oldest first, plus the ones finished in the last week. */
export function stockBoard({ now = new Date() } = {}) {
  const batches = allBatches();
  const recent = batches.filter((b) => !b.done_at || now.getTime() - Date.parse(b.done_at) < SHOW_DONE_DAYS * DAY);
  const views = recent.map((b) => batchView(b, { batches, now }));
  return {
    active: views.filter((v) => !v.done),
    done: views.filter((v) => v.done && !v.empty).sort((a, b) => Date.parse(b.doneAt) - Date.parse(a.doneAt)),
  };
}

/** The nights that are stuck, worst first. */
export function stuckStock({ now = new Date() } = {}) {
  const rank = { bad: 0, warn: 1 };
  return stockBoard({ now }).active.filter((v) => v.stuck).sort((a, b) => rank[a.stuck.level] - rank[b.stuck.level]);
}

/**
 * Once, when the tracker first runs: the sale nights of the last 45 days,
 * so stock bought before it existed is tracked too. Nights already posted
 * finish straight away and never show.
 */
export function backfillStockBatches({ now = new Date() } = {}) {
  if (getMeta('stock_backfilled_at')) return 0;
  setMeta('stock_backfilled_at', now.toISOString());
  const since = new Date(now.getTime() - BACKFILL_DAYS * DAY).toISOString();
  const sales = getDb().prepare(`
    SELECT * FROM scheduled_sales
    WHERE status = 'closed' AND COALESCE(closed_at, end_at) >= ?
    ORDER BY start_at
  `).all(since);
  let made = 0;
  for (const sale of sales) {
    let ids = [];
    try {
      ids = JSON.parse(sale.product_ids);
    } catch {
      continue;
    }
    if (createStockBatch({ productIds: ids, sinceIso: sale.opened_at || sale.start_at, closedAt: sale.closed_at || sale.end_at })) made += 1;
  }
  stockBoard({ now });
  return made;
}

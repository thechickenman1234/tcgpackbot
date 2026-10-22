import { getDb } from '../db/database.js';
import { getOrderById, markShipped, setLabelReference, setTrackingCode, unshipOrder } from './orderService.js';

/**
 * Parcels read off dropped labels, matched to orders.
 *
 * One order can go out in more than one parcel when only part of it has
 * arrived: each parcel is a row here with its own tracking code and how many
 * units it holds. The order counts as shipped once its parcels hold all of
 * it; until then it stays paid, its label reads "(rest)" for what's left and
 * it's back on Print labels.
 */

const DAY = 86400000;

/** Orders a label could be for: paid and not all sent, or posted in the last 2 weeks without a code. */
export function ordersAwaitingParcels(now = Date.now()) {
  const recent = new Date(now - 14 * DAY).toISOString();
  return getDb().prepare(`
    SELECT o.*, b.name AS buyer_name,
      COALESCE((SELECT SUM(quantity) FROM order_parcels p WHERE p.order_id = o.id), 0) AS sent
    FROM orders o LEFT JOIN buyers b ON b.discord_id = o.buyer_id
    WHERE o.status = 'paid'
       OR (o.status = 'shipped' AND o.tracking_code IS NULL AND o.shipped_at >= ?)
    ORDER BY o.paid_at ASC, o.id ASC
  `).all(recent).filter((o) => o.sent < o.quantity);
}

export function parcelsForOrder(orderId) {
  return getDb().prepare('SELECT * FROM order_parcels WHERE order_id = ? ORDER BY id').all(orderId);
}

export function getParcel(id) {
  return getDb().prepare('SELECT * FROM order_parcels WHERE id = ?').get(id);
}

export function parcelByTracking(code) {
  return getDb().prepare('SELECT * FROM order_parcels WHERE tracking_code = ?').get(code);
}

// ---------------------------------------------------------------- matching

/**
 * References are six hex characters, so a letter OCR reads that isn't hex is
 * a misread digit (O for 0, I for 1, S for 5): fold those back before comparing.
 */
const fold = (s) => String(s).toUpperCase()
  .replace(/[OQ]/g, '0').replace(/[IL|]/g, '1').replace(/S/g, '5').replace(/Z/g, '2').replace(/G/g, '6');

const normName = (s) => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length];
}

/** "TCG-6D8F15: 2x storm" as read by OCR, give or take a character. */
export function parseRef(text) {
  const m = String(text || '').match(/T\s*[CG(]\s*G\s*[-–—_.:\s]?\s*([0-9A-Z]{6})/i);
  if (!m) return null;
  const qty = String(text).slice(m.index + m[0].length).match(/\b(\d{1,3})\s*[x×]/i);
  return { code: m[1].toUpperCase(), qty: qty ? Number(qty[1]) : null };
}

/**
 * Which waiting order a label is for. The reference wins when it reads (one
 * character of OCR slack, and only if no other order is as close); then the
 * name, exactly or within two letters. Two orders for the same name is a
 * question for staff, never a guess.
 */
export function matchLabel({ name, ref }, awaiting = ordersAwaitingParcels()) {
  const parsed = parseRef(ref);
  if (parsed) {
    const want = fold(parsed.code);
    const scored = awaiting
      .map((o) => ({ o, d: distance(want, fold(o.reference_code.replace(/^TCG-/, ''))) }))
      .filter((x) => x.d <= 1)
      .sort((a, b) => a.d - b.d);
    if (scored.length && (scored.length === 1 || scored[0].d < scored[1].d)) {
      return { order: scored[0].o, how: 'reference', qty: parsed.qty };
    }
  }

  const n = normName(name);
  const qty = parsed?.qty ?? null;
  if (n) {
    let same = awaiting.filter((o) => normName(o.buyer_name) === n);
    if (!same.length && n.length >= 6) same = awaiting.filter((o) => o.buyer_name && distance(normName(o.buyer_name), n) <= 2);
    if (same.length === 1) return { order: same[0], how: 'name', qty };
    if (same.length > 1) return { candidates: same, qty };
  }

  const suggestions = [...awaiting]
    .sort((a, b) => distance(normName(a.buyer_name), n) - distance(normName(b.buyer_name), n))
    .slice(0, 25);
  return { candidates: [], suggestions, qty };
}

// ---------------------------------------------------------------- recording

/** Puts what's left back on Print labels, with a label that says so. */
function reopenForRest(order, remaining) {
  setLabelReference(order.id, `${order.reference_code}: ${remaining}x ${order.product_name} (rest)`);
  getDb().prepare('UPDATE orders SET label_batch_id = NULL WHERE id = ?').run(order.id);
}

/**
 * Records one parcel for an order. `qty` comes from the label when it says
 * fewer than are left; otherwise the parcel holds everything still to send.
 */
export function recordParcel(orderId, tracking, qty = null) {
  const db = getDb();
  const order = getOrderById(orderId);
  if (!order) return { error: 'no_order' };
  const existing = parcelByTracking(tracking);
  if (existing) return { duplicate: true, order: getOrderById(existing.order_id), parcel: existing };

  const sentBefore = parcelsForOrder(orderId).reduce((s, p) => s + p.quantity, 0);
  const left = Math.max(order.quantity - sentBefore, 1);
  const quantity = qty && qty > 0 && qty < left ? qty : left;
  const result = db.prepare(`
    INSERT INTO order_parcels (order_id, tracking_code, quantity, posted_at) VALUES (?, ?, ?, ?)
  `).run(orderId, tracking, quantity, new Date().toISOString());

  const sent = sentBefore + quantity;
  const complete = sent >= order.quantity;
  let updated;
  if (complete) {
    updated = order.status === 'paid' ? markShipped(orderId, tracking).order : setTrackingCode(orderId, tracking);
    if (order.label_reference?.endsWith('(rest)')) setLabelReference(orderId, null);
  } else {
    if (order.status === 'shipped') unshipOrder(orderId);
    setTrackingCode(orderId, tracking);
    reopenForRest(order, order.quantity - sent);
    updated = getOrderById(orderId);
  }
  return { order: updated, parcel: getParcel(result.lastInsertRowid), quantity, sentBefore, sent, complete };
}

/** Staff said a parcel held fewer than assumed: fix it and reopen the rest. */
export function setParcelQuantity(parcelId, quantity) {
  const parcel = getParcel(parcelId);
  if (!parcel) return { error: 'no_parcel' };
  const order = getOrderById(parcel.order_id);
  getDb().prepare('UPDATE order_parcels SET quantity = ? WHERE id = ?').run(quantity, parcelId);
  const sent = parcelsForOrder(order.id).reduce((s, p) => s + p.quantity, 0);
  if (sent < order.quantity) {
    if (order.status === 'shipped') unshipOrder(order.id);
    reopenForRest(order, order.quantity - sent);
  }
  return { order: getOrderById(order.id), parcel: getParcel(parcelId), sent, left: Math.max(order.quantity - sent, 0) };
}

// ---------------------------------------------------------------- buyer messages

const trackLine = (code) => `Tracking: \`${code}\`\nTrack it at https://auspost.com.au/mypost/track/search?id=${code}`;

/** What the buyer reads in their ticket: what's in this parcel, and what's still to come. */
export function parcelMessage(order, { quantity, sentBefore, complete }, tracking) {
  const item = order.product_name;
  let head;
  if (!sentBefore && complete) {
    head = `📦 **${order.quantity}x ${item}** is on its way.`;
  } else if (!sentBefore) {
    head = `📦 Part of your order is on its way: **${quantity} of your ${order.quantity}x ${item}**. `
      + `The other ${order.quantity - quantity} will follow in its own parcel, and you'll get that tracking here too.`;
  } else if (complete) {
    head = `📦 The rest of your order is on its way: **${quantity}x ${item}**. That's everything.`;
  } else {
    head = `📦 More of your order is on its way: **${quantity}x ${item}** (${sentBefore + quantity} of ${order.quantity} sent). The rest will follow.`;
  }
  return `<@${order.buyer_id}> ${head}\n${trackLine(tracking)}`;
}

export function partCorrectionMessage(order, parcel, left) {
  return `<@${order.buyer_id}> Heads up: the parcel with tracking \`${parcel.tracking_code}\` has **${parcel.quantity} of your ${order.quantity}x ${order.product_name}**. `
    + `The other ${left} will follow in its own parcel, and you'll get that tracking here too.`;
}

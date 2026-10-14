import { getDb } from '../db/database.js';
import { config } from '../config.js';

/**
 * What goes in one box.
 *
 * The rule, from Lachy on 14 Oct 2026: every order ships on its own, unless
 * it came from the same claim sale as another order of the same buyer.
 *
 * It used to be "everything a buyer has waiting goes in one parcel". That
 * glued a box from one drop to a box from a drop weeks later, and the first
 * one sat on the shelf until the second arrived. Now a parcel can only ever
 * hold one sale's worth of stock.
 *
 * A sale is a scheduled sale's window: from when it opened until its late
 * claim window closed. Sales run by hand before scheduling existed left no
 * window, so for those the sale is the night: claims from the same evening
 * (8pm through to 6am) count as one sale. Orders logged by hand (Facebook,
 * DMs, wholesale) are never part of a sale and always ship alone.
 */

const HOUR = 3600000;

/**
 * The night a claim belongs to, for sales with no recorded window: the
 * Melbourne date six hours earlier, so a claim at 12:30am still counts as
 * the evening before.
 */
function saleNight(claimedAt) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.parse(claimedAt) - 6 * HOUR));
}

function parseIds(json) {
  try {
    return new Set(JSON.parse(json || '[]').map(Number));
  } catch {
    return new Set();
  }
}

/**
 * Returns a function that names the sale an order belongs to. The sale list
 * is read once, so grouping a hundred orders is one query, not a hundred.
 */
export function saleKeyer() {
  const windows = getDb().prepare(`
    SELECT id, product_ids, start_at, end_at FROM scheduled_sales WHERE status IN ('open', 'closed')
  `).all().map((s) => ({
    id: s.id,
    products: parseIds(s.product_ids),
    from: Date.parse(s.start_at),
    to: Date.parse(s.end_at) + config.lateWindowHours * HOUR,
  }));

  return (order) => {
    // Claims and late claims come from a sale. Anything logged by hand is
    // its own thing and never joins a sale's parcel.
    if (!['claim', 'late'].includes(order.source || 'claim')) return `order:${order.id}`;
    const t = Date.parse(order.claimed_at);
    const open = windows.filter((w) => t >= w.from && t <= w.to);
    // Back-to-back nights overlap: last night's late window is still open
    // when tonight's sale starts. The sale actually selling that product
    // wins, then the most recent one.
    const pick = open.find((w) => w.products.has(order.product_id))
      || open.sort((a, b) => b.from - a.from)[0];
    return pick ? `sale:${pick.id}` : `night:${saleNight(order.claimed_at)}`;
  };
}

/**
 * Names the parcel an order goes in: the same buyer, the same print batch,
 * and the same sale. Two orders share a box only if all three match.
 */
export function parcelKeyer() {
  const sale = saleKeyer();
  return (order) => `${order.buyer_id}|${order.label_batch_id ?? ''}|${sale(order)}`;
}

/** Groups orders into parcels, in the order the orders were given. */
export function groupIntoParcels(orders) {
  const key = parcelKeyer();
  const parcels = new Map();
  for (const o of orders) {
    const k = key(o);
    if (!parcels.has(k)) parcels.set(k, []);
    parcels.get(k).push(o);
  }
  return [...parcels.values()];
}

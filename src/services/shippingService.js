import { getDb } from '../db/database.js';
import { getMeta, setMeta } from './metaService.js';
import { getAllPaidOrders, markShipped } from './orderService.js';

/**
 * Label batches.
 *
 * A batch is one press of Print labels: exactly the orders that went onto
 * that sheet of labels. Recording it is what lets the bot answer the question
 * the Labels tab never could, which is "have I printed this one already?"
 *
 * Printing never marks anything shipped. A printed order stays paid, in plain
 * view under its batch, until it is posted. That is the difference from
 * /export, which hid orders the moment a file was made and lost parcels that
 * way. A batch only remembers which file an order is on.
 */

const LABELS_BATCH_KEY = 'labels_batch_id';
const DAY = 86400000;

function groupByProduct(orders) {
  const map = new Map();
  for (const o of orders) {
    let g = map.get(o.product_id);
    if (!g) {
      g = { productId: o.product_id, product: o.product_name, orders: [], units: 0, buyers: new Set() };
      map.set(o.product_id, g);
    }
    g.orders.push(o);
    g.units += o.quantity;
    g.buyers.add(o.buyer_id);
  }
  return [...map.values()].map((g) => ({
    productId: g.productId,
    product: g.product,
    orders: g.orders,
    units: g.units,
    parcels: g.buyers.size,
    firstClaim: g.orders[0].claimed_at,
    lastClaim: g.orders[g.orders.length - 1].claimed_at,
  }));
}

/** Paid orders that have never been printed through the buttons. */
function unprintedOrders() {
  return getDb().prepare(`
    SELECT * FROM orders WHERE status = 'paid' AND label_batch_id IS NULL
    ORDER BY claimed_at ASC, id ASC
  `).all();
}

/** What is waiting to be printed, one entry per product, oldest claim first. */
export function unprintedByProduct() {
  return groupByProduct(unprintedOrders())
    .sort((a, b) => String(a.firstClaim).localeCompare(String(b.firstClaim)));
}

export function unprintedForProduct(productId) {
  return unprintedOrders().filter((o) => o.product_id === Number(productId));
}

/**
 * The orders a print would cover.
 *
 * With no count, everything waiting for those products. With a count (half a
 * drop turned up), the oldest claims first until the stock runs out. An order
 * is never split across two parcels: one that no longer fits is skipped and
 * waits for the next delivery, and smaller ones behind it still get a go, so
 * every box that arrived goes out.
 */
export function planBatch(productIds, unitsAvailable = null) {
  const ids = new Set(productIds.map(Number));
  const candidates = unprintedOrders().filter((o) => ids.has(o.product_id));
  if (unitsAvailable === null) return { included: candidates, waiting: [], unitsLeft: 0 };

  let left = unitsAvailable;
  const included = [];
  const waiting = [];
  for (const o of candidates) {
    if (o.quantity <= left) {
      included.push(o);
      left -= o.quantity;
    } else {
      waiting.push(o);
    }
  }
  return { included, waiting, unitsLeft: left };
}

export function getBatch(id) {
  return getDb().prepare('SELECT * FROM label_batches WHERE id = ?').get(Number(id));
}

/** Orders on a batch that have not gone out yet. */
export function openOrdersInBatch(batchId) {
  return getDb().prepare(`
    SELECT * FROM orders WHERE label_batch_id = ? AND status = 'paid'
    ORDER BY claimed_at ASC, id ASC
  `).all(Number(batchId));
}

/**
 * Records a print. Only orders still paid and still unprinted are taken, so
 * two presses in quick succession can never put one order on two batches.
 * Returns the batch with the orders it actually got.
 */
export function createBatch(orders, title, createdBy = null) {
  const db = getDb();
  const run = db.transaction(() => {
    const info = db.prepare(
      'INSERT INTO label_batches (title, created_at, created_by) VALUES (?, ?, ?)',
    ).run(title, new Date().toISOString(), createdBy);
    const id = Number(info.lastInsertRowid);
    const stmt = db.prepare(`
      UPDATE orders SET label_batch_id = ?
      WHERE id = ? AND status = 'paid' AND label_batch_id IS NULL
    `);
    for (const o of orders) stmt.run(id, o.id);
    return id;
  });
  const id = run();
  setLabelsBatch(id);
  return { batch: getBatch(id), orders: openOrdersInBatch(id) };
}

/** Batches that still have something to post, newest first. */
export function openBatches(limit = 25) {
  return getDb().prepare(`
    SELECT b.*, COUNT(o.id) AS open_orders, SUM(o.quantity) AS open_units,
           COUNT(DISTINCT o.buyer_id) AS open_parcels
    FROM label_batches b
    JOIN orders o ON o.label_batch_id = b.id AND o.status = 'paid'
    GROUP BY b.id
    ORDER BY b.id DESC
    LIMIT ?
  `).all(limit);
}

/** The batch the Labels tab shows: whichever was printed or reprinted last. */
export function setLabelsBatch(id) {
  setMeta(LABELS_BATCH_KEY, id);
}

/**
 * What the Labels tab should hold.
 *
 * The last printed batch, minus anything already posted, so the tab only ever
 * shows one drop and never has to be printed in full. Before the first batch
 * exists it falls back to every paid order, which is how it always worked.
 */
export function labelOrders() {
  const id = getMeta(LABELS_BATCH_KEY);
  return id ? openOrdersInBatch(id) : getAllPaidOrders();
}

/** Marks orders posted. Anything no longer paid is skipped, not an error. */
export function markPosted(orderIds) {
  const shipped = [];
  for (const id of orderIds) {
    const result = markShipped(Number(id), null);
    if (result.ok) shipped.push(result.order);
  }
  return shipped;
}

export function countParcels(orders) {
  return new Set(orders.map((o) => `${o.buyer_id}:${o.label_batch_id ?? ''}`)).size;
}

export function sumUnits(orders) {
  return orders.reduce((n, o) => n + o.quantity, 0);
}

/**
 * The three numbers that say where everything is, shown at the top of every
 * shipping reply so there is never a question of what has gone out.
 */
export function statusLines(now = Date.now()) {
  const unprinted = unprintedOrders();
  const printed = getDb().prepare(`
    SELECT * FROM orders WHERE status = 'paid' AND label_batch_id IS NOT NULL
  `).all();
  const weekAgo = new Date(now - 7 * DAY).toISOString();
  const posted = getDb().prepare(`
    SELECT * FROM orders WHERE status IN ('shipped', 'archived') AND shipped_at >= ?
  `).all(weekAgo);
  const noTracking = posted.filter((o) => !o.tracking_code);

  return [
    `⏳ **Not printed:** ${countParcels(unprinted)} parcels (${sumUnits(unprinted)} items)`,
    `🏷️ **Printed, not posted:** ${countParcels(printed)} parcels (${sumUnits(printed)} items)`,
    `📦 **Posted this week:** ${countParcels(posted)} parcels`
      + (noTracking.length ? `, **${countParcels(noTracking)} still need tracking**` : ', all tracked'),
  ];
}

import { getDb } from '../db/database.js';
import { getProductById, setProductActive } from './productService.js';

/**
 * Claim sales that open and close themselves.
 *
 * The routine is the same every time: 8pm to midnight, every second day,
 * the same shape of post. The only thing that changes is which product is
 * on. Doing that by hand means being at a keyboard at 8pm and again at
 * midnight, and a sale that opens twenty minutes late is twenty minutes of
 * people asking whether it is on.
 */

export function createScheduledSale({
  productIds, startAt, endAt, channelId, createdBy,
  announceAt = null, announceChannelId = null, note = null, title = null,
}) {
  const result = getDb().prepare(`
    INSERT INTO scheduled_sales (
      product_ids, start_at, end_at, channel_id, created_by, created_at,
      announce_at, announce_channel_id, note, title
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    JSON.stringify(productIds),
    startAt,
    endAt,
    channelId,
    createdBy,
    new Date().toISOString(),
    announceAt,
    announceChannelId,
    note,
    title,
  );
  return getScheduledSaleById(result.lastInsertRowid);
}

/** Sales whose price announcement is due but hasn't gone out. */
export function getSalesToAnnounce() {
  return getDb().prepare(`
    SELECT * FROM scheduled_sales
    WHERE status = 'pending'
      AND announce_at IS NOT NULL
      AND announced_at IS NULL
      AND announce_at <= ?
    ORDER BY announce_at ASC
  `).all(new Date().toISOString());
}

export function markAnnounced(id) {
  getDb().prepare('UPDATE scheduled_sales SET announced_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
}

export function getScheduledSaleById(id) {
  return getDb().prepare('SELECT * FROM scheduled_sales WHERE id = ?').get(id);
}

export function listUpcomingSales() {
  return getDb().prepare(`
    SELECT * FROM scheduled_sales
    WHERE status IN ('pending', 'open')
    ORDER BY start_at ASC
  `).all();
}

/** Sales that should be open by now but are not. */
export function getSalesToOpen() {
  return getDb().prepare(`
    SELECT * FROM scheduled_sales
    WHERE status = 'pending' AND start_at <= ?
    ORDER BY start_at ASC
  `).all(new Date().toISOString());
}

/** Sales that are open and have run past their end time. */
export function getSalesToClose() {
  return getDb().prepare(`
    SELECT * FROM scheduled_sales
    WHERE status = 'open' AND end_at <= ?
    ORDER BY end_at ASC
  `).all(new Date().toISOString());
}

export function productsFor(sale) {
  let ids = [];
  try {
    ids = JSON.parse(sale.product_ids);
  } catch {
    return [];
  }
  return ids.map((id) => getProductById(id)).filter(Boolean);
}

/**
 * Opens the sale. Returns the products that were actually switched on, so
 * a product deleted between scheduling and 8pm does not silently become an
 * empty sale with nothing in it.
 */
export function openSale(sale) {
  const products = productsFor(sale);
  if (!products.length) return { ok: false, reason: 'no_products' };

  for (const product of products) setProductActive(product.id, true);

  getDb().prepare("UPDATE scheduled_sales SET status = 'open', opened_at = ? WHERE id = ?")
    .run(new Date().toISOString(), sale.id);

  return { ok: true, products };
}

export function markClosed(id) {
  getDb().prepare("UPDATE scheduled_sales SET status = 'closed', closed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
}

export function markSaleFailed(id, error) {
  getDb().prepare("UPDATE scheduled_sales SET status = 'failed', last_error = ? WHERE id = ?")
    .run(String(error).slice(0, 400), id);
}

export function cancelScheduledSale(id) {
  const sale = getScheduledSaleById(id);
  if (!sale || !['pending', 'open'].includes(sale.status)) return { ok: false };
  getDb().prepare("UPDATE scheduled_sales SET status = 'cancelled' WHERE id = ?").run(id);
  return { ok: true, sale };
}

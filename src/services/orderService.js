import { getDb } from '../db/database.js';
import { generateOrderReference } from '../utils/orderRef.js';
import { addDaysIso, addHoursIso, nowIso } from '../utils/permissions.js';
import { config } from '../config.js';
import { ensureBuyer } from './buyerService.js';
import { releaseStock, reserveStock } from './productService.js';

export function getOrderById(id) {
  return getDb().prepare('SELECT * FROM orders WHERE id = ?').get(id);
}

export function getOrderByReference(referenceCode) {
  return getDb().prepare('SELECT * FROM orders WHERE reference_code = ?').get(referenceCode);
}

export function getOrderByThreadId(threadId) {
  return getDb().prepare('SELECT * FROM orders WHERE thread_id = ?').get(threadId);
}

export function hasOpenOrderForBuyerProduct(buyerId, productId) {
  return getDb().prepare(`
    SELECT * FROM orders
    WHERE buyer_id = ? AND product_id = ? AND status IN ('pending', 'paid')
    LIMIT 1
  `).get(buyerId, productId);
}

export function createClaimOrder({ buyerId, product, quantity, claimMessageId }) {
  ensureBuyer(buyerId);

  const duplicate = hasOpenOrderForBuyerProduct(buyerId, product.id);
  if (duplicate) {
    return { ok: false, reason: 'duplicate', existing: duplicate };
  }

  const reserved = reserveStock(product.id, quantity);
  if (!reserved) {
    return { ok: false, reason: 'sold_out' };
  }

  const claimedAt = new Date();
  const referenceCode = generateOrderReference();
  const shippingCents = product.shipping_cents || 0;
  const totalCents = product.price_cents * quantity + shippingCents;

  const result = getDb().prepare(`
    INSERT INTO orders (
      reference_code, buyer_id, product_id, product_name, quantity,
      unit_price_cents, shipping_cents, total_cents, status, claim_message_id,
      claimed_at, payment_deadline_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(
    referenceCode,
    buyerId,
    product.id,
    product.name,
    quantity,
    product.price_cents,
    shippingCents,
    totalCents,
    claimMessageId,
    claimedAt.toISOString(),
    addHoursIso(config.paymentDeadlineHours, claimedAt),
  );

  return { ok: true, order: getOrderById(result.lastInsertRowid) };
}

export function attachThread(orderId, threadId) {
  getDb().prepare('UPDATE orders SET thread_id = ? WHERE id = ?').run(threadId, orderId);
}

export function markPaid(orderId) {
  const order = getOrderById(orderId);
  if (!order || order.status !== 'pending') {
    return { ok: false, reason: 'invalid_status', order };
  }

  getDb().prepare(`
    UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?
  `).run(nowIso(), orderId);

  return { ok: true, order: getOrderById(orderId) };
}

export function markShipped(orderId) {
  const order = getOrderById(orderId);
  if (!order || order.status !== 'paid') {
    return { ok: false, reason: 'invalid_status', order };
  }

  const shippedAt = new Date();
  getDb().prepare(`
    UPDATE orders
    SET status = 'shipped', shipped_at = ?, archive_at = ?
    WHERE id = ?
  `).run(
    shippedAt.toISOString(),
    addDaysIso(config.archiveDaysAfterShipped, shippedAt),
    orderId,
  );

  return { ok: true, order: getOrderById(orderId) };
}

export function markArchived(orderId) {
  getDb().prepare(`
    UPDATE orders SET status = 'archived', archived_at = ? WHERE id = ?
  `).run(nowIso(), orderId);
  return getOrderById(orderId);
}

export function cancelOrder(orderId, reason) {
  const order = getOrderById(orderId);
  if (!order || order.status !== 'pending') {
    return { ok: false, reason: 'invalid_status', order };
  }

  getDb().prepare(`
    UPDATE orders
    SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
    WHERE id = ?
  `).run(nowIso(), reason, orderId);

  releaseStock(order.product_id, order.quantity);
  return { ok: true, order: getOrderById(orderId) };
}

export function getExpiredUnpaidOrders() {
  return getDb().prepare(`
    SELECT * FROM orders
    WHERE status = 'pending' AND payment_deadline_at <= ?
  `).all(nowIso());
}

export function getOrdersReadyToArchive() {
  return getDb().prepare(`
    SELECT * FROM orders
    WHERE status = 'shipped' AND archive_at IS NOT NULL AND archive_at <= ?
  `).all(nowIso());
}

export function listOrdersByBuyer(buyerId) {
  return getDb()
    .prepare('SELECT * FROM orders WHERE buyer_id = ? ORDER BY claimed_at DESC')
    .all(buyerId);
}

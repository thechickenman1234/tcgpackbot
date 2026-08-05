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

export function getPendingOrderForBuyerProduct(buyerId, productId) {
  return getDb().prepare(`
    SELECT * FROM orders
    WHERE buyer_id = ? AND product_id = ? AND status = 'pending'
    LIMIT 1
  `).get(buyerId, productId);
}

/** @deprecated use getPendingOrderForBuyerProduct — kept for callers expecting open pending/paid */
export function hasOpenOrderForBuyerProduct(buyerId, productId) {
  return getDb().prepare(`
    SELECT * FROM orders
    WHERE buyer_id = ? AND product_id = ? AND status IN ('pending', 'paid')
    LIMIT 1
  `).get(buyerId, productId);
}

/** Units already claimed by this buyer for the product (excludes cancelled). */
export function getBuyerClaimedQuantity(buyerId, productId) {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(quantity), 0) AS total
    FROM orders
    WHERE buyer_id = ? AND product_id = ? AND status NOT IN ('cancelled')
  `).get(buyerId, productId);
  return row?.total ?? 0;
}

function assertWithinLimit(buyerId, product, quantity) {
  const maxPerBuyer = product.max_per_buyer;
  if (maxPerBuyer == null || maxPerBuyer <= 0) return { ok: true };

  const already = getBuyerClaimedQuantity(buyerId, product.id);
  if (already + quantity > maxPerBuyer) {
    return {
      ok: false,
      reason: 'limit',
      maxPerBuyer,
      already,
      remaining: Math.max(0, maxPerBuyer - already),
    };
  }
  return { ok: true };
}

/**
 * Create a new claim, or top up an existing pending claim for the same product.
 */
export function createClaimOrder({ buyerId, product, quantity, claimMessageId }) {
  ensureBuyer(buyerId);

  const pending = getPendingOrderForBuyerProduct(buyerId, product.id);
  if (pending) {
    return topUpPendingOrder({ order: pending, product, quantity, claimMessageId });
  }

  const limit = assertWithinLimit(buyerId, product, quantity);
  if (!limit.ok) return limit;

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

  return { ok: true, order: getOrderById(result.lastInsertRowid), toppedUp: false };
}

export function topUpPendingOrder({ order, product, quantity, claimMessageId = null }) {
  if (!order || order.status !== 'pending') {
    return { ok: false, reason: 'invalid_status', order };
  }

  const limit = assertWithinLimit(order.buyer_id, product, quantity);
  if (!limit.ok) return limit;

  const reserved = reserveStock(product.id, quantity);
  if (!reserved) {
    return { ok: false, reason: 'sold_out' };
  }

  const newQuantity = order.quantity + quantity;
  const shippingCents = order.shipping_cents || 0;
  const totalCents = product.price_cents * newQuantity + shippingCents;

  getDb().prepare(`
    UPDATE orders
    SET quantity = ?,
        unit_price_cents = ?,
        total_cents = ?,
        product_name = ?,
        claim_message_id = COALESCE(?, claim_message_id)
    WHERE id = ? AND status = 'pending'
  `).run(
    newQuantity,
    product.price_cents,
    totalCents,
    product.name,
    claimMessageId,
    order.id,
  );

  return {
    ok: true,
    order: getOrderById(order.id),
    toppedUp: true,
    added: quantity,
  };
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

export function cancelOrder(orderId, reason, { reactivateStock = true } = {}) {
  const order = getOrderById(orderId);
  if (!order || order.status !== 'pending') {
    return { ok: false, reason: 'invalid_status', order };
  }

  getDb().prepare(`
    UPDATE orders
    SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
    WHERE id = ?
  `).run(nowIso(), reason, orderId);

  releaseStock(order.product_id, order.quantity, { reactivate: reactivateStock });
  return { ok: true, order: getOrderById(orderId) };
}

export function getExpiredUnpaidOrders() {
  return getDb().prepare(`
    SELECT * FROM orders
    WHERE status = 'pending' AND payment_deadline_at <= ?
  `).all(nowIso());
}

/** Pending orders whose deadline is within the reminder window and not yet reminded. */
export function getOrdersNeedingPaymentReminder() {
  const hours = config.paymentReminderHoursBefore;
  if (!hours || hours <= 0) return [];

  const now = new Date();
  const reminderWindowEnd = now.toISOString();
  const reminderWindowStart = new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();

  return getDb().prepare(`
    SELECT * FROM orders
    WHERE status = 'pending'
      AND reminder_sent_at IS NULL
      AND payment_deadline_at > ?
      AND payment_deadline_at <= ?
  `).all(reminderWindowEnd, reminderWindowStart);
}

export function markReminderSent(orderId) {
  getDb().prepare(`
    UPDATE orders SET reminder_sent_at = ? WHERE id = ?
  `).run(nowIso(), orderId);
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

export function listPendingOrdersByBuyer(buyerId) {
  return getDb().prepare(`
    SELECT * FROM orders
    WHERE buyer_id = ? AND status = 'pending'
    ORDER BY claimed_at DESC
  `).all(buyerId);
}

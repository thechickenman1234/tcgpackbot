import { getDb } from '../db/database.js';
import { getBuyer, ensureBuyer, updateBuyerDetails } from './buyerService.js';
import { getOrderById } from './orderService.js';
import { generateOrderReference } from '../utils/orderRef.js';

/**
 * Orders that did not come from a claim message: Facebook, a DM, a shop
 * buying wholesale, someone who caught you at a card show.
 *
 * These used to live in your head and in DM scrollback, which is why they
 * went missing. Once they are ordinary orders they get a reference, a
 * label, tracking, a row in the sheet and combined shipping for free,
 * because every one of those already works off the orders table.
 *
 * Buyers who are not in Discord get a synthetic id. It is prefixed so it
 * can never collide with a real snowflake, and it behaves like any other
 * buyer everywhere else.
 */

export const SOURCES = ['facebook', 'dm', 'wholesale', 'instagram', 'in_person', 'other'];

export function syntheticBuyerId(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `ext:${slug || 'buyer'}`;
}

/**
 * Logs a sale that happened outside Discord.
 *
 * It lands as 'paid' rather than 'pending' on purpose: you only log one of
 * these after the money is in, so there is no deadline to chase and it
 * should appear on the Labels tab immediately.
 */
export function logManualOrder({
  product,
  quantity,
  totalCents,
  shippingCents = 0,
  source = 'other',
  discordId = null,
  name = null,
  phone = null,
  address = null,
  city = null,
  state = null,
  zip = null,
}) {
  if (!product) return { ok: false, reason: 'no_product' };
  if (!Number.isInteger(quantity) || quantity < 1) return { ok: false, reason: 'bad_quantity' };

  const buyerId = discordId || syntheticBuyerId(name || '');
  ensureBuyer(buyerId);

  // Only overwrite details that were actually supplied, so logging a repeat
  // order for someone does not wipe the address they gave you last time.
  const existing = getBuyer(buyerId) || {};
  updateBuyerDetails(buyerId, {
    name: name || existing.name || null,
    phone: phone || existing.phone || null,
    shippingAddress: address || existing.shipping_address || null,
    city: city || existing.city || null,
    state: state || existing.state || null,
    zip: zip || existing.zip || null,
  });

  const goods = Math.max(0, totalCents - shippingCents);
  const unitPriceCents = Math.round(goods / quantity);
  const now = new Date().toISOString();
  const reference = generateOrderReference();

  const result = getDb().prepare(`
    INSERT INTO orders (
      reference_code, buyer_id, product_id, product_name, quantity,
      unit_price_cents, shipping_cents, total_cents, status,
      claimed_at, paid_at, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?)
  `).run(
    reference,
    buyerId,
    product.id,
    product.name,
    quantity,
    unitPriceCents,
    shippingCents,
    totalCents,
    now,
    now,
    source,
  );

  return { ok: true, order: getOrderById(result.lastInsertRowid) };
}

/** Totals by source, so wholesale can be read apart from claim sales. */
export function getTotalsBySource(sinceIso = null) {
  return getDb().prepare(`
    SELECT
      source,
      COUNT(*) AS orders,
      SUM(quantity) AS boxes,
      SUM(total_cents) AS revenue_cents
    FROM orders
    WHERE status IN ('paid', 'shipped', 'archived')
      AND (? IS NULL OR claimed_at >= ?)
    GROUP BY source
    ORDER BY revenue_cents DESC
  `).all(sinceIso, sinceIso);
}

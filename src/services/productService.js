import { getDb } from '../db/database.js';
import { nowIso, slugify } from '../utils/permissions.js';

export function createProduct({
  name,
  priceCents,
  quantity,
  shippingCents = 0,
  maxPerBuyer = null,
  saleWindow = null,
}) {
  const db = getDb();
  const ts = nowIso();
  const slug = slugify(name);

  const result = db.prepare(`
    INSERT INTO products (
      name, slug, price_cents, shipping_cents, quantity_available, max_per_buyer, active, sale_window, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(name, slug, priceCents, shippingCents, quantity, maxPerBuyer, saleWindow, ts, ts);

  return getProductById(result.lastInsertRowid);
}

export function updateProductStock(productId, quantity) {
  getDb().prepare(`
    UPDATE products SET quantity_available = ?, updated_at = ? WHERE id = ?
  `).run(quantity, nowIso(), productId);
}

export function setProductActive(productId, active) {
  getDb().prepare(`
    UPDATE products SET active = ?, updated_at = ? WHERE id = ?
  `).run(active ? 1 : 0, nowIso(), productId);
}

export function setProductPrice(productId, priceCents) {
  getDb().prepare(`
    UPDATE products SET price_cents = ?, updated_at = ? WHERE id = ?
  `).run(priceCents, nowIso(), productId);
}

export function setProductShipping(productId, shippingCents) {
  getDb().prepare(`
    UPDATE products SET shipping_cents = ?, updated_at = ? WHERE id = ?
  `).run(shippingCents, nowIso(), productId);
}

/** null clears the per-buyer limit (unlimited). */
export function setProductMaxPerBuyer(productId, maxPerBuyer) {
  getDb().prepare(`
    UPDATE products SET max_per_buyer = ?, updated_at = ? WHERE id = ?
  `).run(maxPerBuyer, nowIso(), productId);
}

export function getProductMaxPerBuyer(product) {
  const n = product?.max_per_buyer;
  if (n == null || n <= 0) return null;
  return n;
}

export function getProductById(id) {
  return getDb().prepare('SELECT * FROM products WHERE id = ?').get(id);
}

export function findActiveProductByName(productName) {
  const db = getDb();
  const slug = slugify(productName);

  const bySlug = db.prepare(`
    SELECT * FROM products WHERE active = 1 AND slug = ?
  `).get(slug);
  if (bySlug) return bySlug;

  return db.prepare(`
    SELECT * FROM products
    WHERE active = 1 AND lower(name) = lower(?)
  `).get(productName.trim());
}

export function listActiveProducts() {
  return getDb()
    .prepare('SELECT * FROM products WHERE active = 1 ORDER BY name ASC')
    .all();
}

export function listAllProducts() {
  return getDb()
    .prepare('SELECT * FROM products ORDER BY active DESC, name ASC')
    .all();
}

/**
 * Atomically reserve stock. Returns product row if successful, null if insufficient stock.
 */
export function reserveStock(productId, quantity) {
  const db = getDb();
  const result = db.prepare(`
    UPDATE products
    SET quantity_available = quantity_available - ?, updated_at = ?
    WHERE id = ? AND active = 1 AND quantity_available >= ?
  `).run(quantity, nowIso(), productId, quantity);

  if (result.changes === 0) return null;
  return getProductById(productId);
}

export function releaseStock(productId, quantity) {
  getDb().prepare(`
    UPDATE products
    SET quantity_available = quantity_available + ?, updated_at = ?
    WHERE id = ?
  `).run(quantity, nowIso(), productId);
}

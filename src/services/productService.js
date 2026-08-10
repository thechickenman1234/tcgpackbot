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

export function updateProductStock(productId, quantity, { reactivate = true } = {}) {
  getDb().prepare(`
    UPDATE products SET quantity_available = ?, updated_at = ? WHERE id = ?
  `).run(quantity, nowIso(), productId);

  if (reactivate && quantity > 0) {
    setProductActive(productId, true);
  }

  return getProductById(productId);
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

export function releaseStock(productId, quantity, { reactivate = true } = {}) {
  getDb().prepare(`
    UPDATE products
    SET quantity_available = quantity_available + ?, updated_at = ?
    WHERE id = ?
  `).run(quantity, nowIso(), productId);

  const product = getProductById(productId);
  if (reactivate && product?.quantity_available > 0 && !product.active) {
    setProductActive(productId, true);
  }
  return getProductById(productId);
}

export function findProductByName(productName) {
  const db = getDb();
  const slug = slugify(productName);

  const bySlug = db.prepare('SELECT * FROM products WHERE slug = ?').get(slug);
  if (bySlug) return bySlug;

  return db.prepare(`
    SELECT * FROM products WHERE lower(name) = lower(?)
  `).get(productName.trim());
}

// ============ TIERED PRICING ============
// Tiers let a product's per-unit price and flat shipping change based on
// the total quantity a buyer claims. Stored as a JSON array on the product
// row; a product with no tiers set falls back to its flat price_cents /
// shipping_cents exactly as before, so this is fully backwards compatible.

export function setProductTiers(productId, tiersJson) {
  getDb().prepare(`
    UPDATE products SET pricing_tiers = ?, updated_at = ? WHERE id = ?
  `).run(tiersJson, nowIso(), productId);
}

export function clearProductTiers(productId) {
  getDb().prepare(`
    UPDATE products SET pricing_tiers = NULL, updated_at = ? WHERE id = ?
  `).run(nowIso(), productId);
}

export function getProductTiers(product) {
  if (!product?.pricing_tiers) return null;
  try {
    const tiers = JSON.parse(product.pricing_tiers);
    return Array.isArray(tiers) && tiers.length ? tiers : null;
  } catch {
    return null;
  }
}

/**
 * Parse staff-friendly tier syntax, e.g.:
 *   "1-4:200:5,5-9:200:0,10+:197:0"
 * Each segment is  range:pricePerUnit:flatShipping  (dollars, not cents).
 * Range is "min-max", a single number, or "min+" for an unlimited top end.
 * Returns { ok:true, tiers:[...] } or { ok:false, error }.
 */
export function parseTiersInput(input) {
  const segments = input.split(',').map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return { ok: false, error: 'No tiers provided.' };

  const tiers = [];
  for (const seg of segments) {
    const parts = seg.split(':').map((p) => p.trim());
    if (parts.length !== 3) {
      return { ok: false, error: `Bad segment "${seg}" — expected range:price:shipping, e.g. 1-4:200:5` };
    }
    const [range, priceStr, shipStr] = parts;
    let min;
    let max;
    if (range.endsWith('+')) {
      min = Number(range.slice(0, -1));
      max = null;
    } else if (range.includes('-')) {
      const [minStr, maxStr] = range.split('-');
      min = Number(minStr);
      max = Number(maxStr);
    } else {
      min = Number(range);
      max = Number(range);
    }
    const price = Number(priceStr);
    const shipping = Number(shipStr);

    if (!Number.isFinite(min) || min < 1) {
      return { ok: false, error: `Bad range "${range}" — min quantity must be a number ≥ 1.` };
    }
    if (max !== null && (!Number.isFinite(max) || max < min)) {
      return { ok: false, error: `Bad range "${range}" — max must be ≥ min.` };
    }
    if (!Number.isFinite(price) || price <= 0) {
      return { ok: false, error: `Bad price in "${seg}" — must be a number > 0.` };
    }
    if (!Number.isFinite(shipping) || shipping < 0) {
      return { ok: false, error: `Bad shipping in "${seg}" — must be a number ≥ 0.` };
    }

    tiers.push({
      min,
      max,
      priceCents: Math.round(price * 100),
      shippingCents: Math.round(shipping * 100),
    });
  }

  tiers.sort((a, b) => a.min - b.min);
  for (let i = 1; i < tiers.length; i += 1) {
    const prev = tiers[i - 1];
    const cur = tiers[i];
    if (prev.max === null || cur.min <= prev.max) {
      return { ok: false, error: `Tier ranges overlap or are out of order near "${cur.min}".` };
    }
  }

  return { ok: true, tiers };
}

/**
 * Resolve unit price + flat shipping for a given quantity. Uses the
 * product's tiers if set; otherwise falls back to its flat price/shipping.
 */
export function resolveTierPricing(product, quantity) {
  const tiers = getProductTiers(product);
  if (tiers) {
    const match = tiers.find((t) => quantity >= t.min && (t.max === null || quantity <= t.max));
    const chosen = match || tiers[0]; // below lowest tier's min: fall back to the lowest tier
    return { priceCents: chosen.priceCents, shippingCents: chosen.shippingCents, tier: chosen };
  }
  return { priceCents: product.price_cents, shippingCents: product.shipping_cents || 0, tier: null };
}

export function formatTiersForDisplay(product, formatAud) {
  const tiers = getProductTiers(product);
  if (!tiers) return null;
  return tiers
    .map((t) => {
      const range = t.max === null ? `${t.min}+` : (t.min === t.max ? `${t.min}` : `${t.min}-${t.max}`);
      const shipNote = t.shippingCents ? ` + ${formatAud(t.shippingCents)} shipping` : ', free shipping';
      return `${range} boxes: **${formatAud(t.priceCents)}**/ea${shipNote}`;
    })
    .join('\n');
}

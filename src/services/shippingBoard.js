import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { slugify } from '../utils/permissions.js';
import { getBuyer } from './buyerService.js';
import { createProduct, findProductByName, getProductById, setProductActive } from './productService.js';
import { SOURCES, logManualOrder, syntheticBuyerId } from './manualOrderService.js';
import { markShipped, unshipOrder } from './orderService.js';
import { createBatch, getBatch, markPosted, openOrdersInBatch, planBatch, setLabelsBatch } from './shippingService.js';
import { labelRowsByBuyer, labelRowsToCsv } from './sheetService.js';
import { codesForBoard } from './trackingCodes.js';

/**
 * Shipping on the dashboard: everything paid and not posted, grouped the way
 * it goes out (labels made, or not printed yet), ticked off as it ships;
 * label files made or made again; and someone new added to the label list.
 *
 * It goes through the same functions as the shipping panel and /logsale, so
 * a parcel ticked here is the same as one ticked in Discord: shipped with no
 * code tells nobody (like Mark posted), and shipped with a tracking number
 * tells the buyer in their ticket (like Add tracking). Codes uploaded in
 * bulk wait on their parcels (trackingCodes.js) until the parcel is ticked.
 */

const DAY = 86400000;
const SHIPPED_DAYS = 14;
export const STATES = ['VIC', 'NSW', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const hasAddress = (b) => Boolean(b?.shipping_address?.trim() && b?.city?.trim() && b?.state?.trim() && b?.zip?.trim());

/** What's left to post and what went out lately, as the Shipping section shows it. */
export function shippingBoard({ now = new Date() } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT o.id, o.reference_code, o.product_id, o.product_name, o.quantity, o.shipping_method,
      o.paid_at, o.claimed_at, o.label_batch_id, o.source, pr.display_name,
      (SELECT e.ship_by FROM ebay_orders e WHERE e.order_id = o.ebay_order_id) AS ship_by,
      b.name AS buyer_name, b.shipping_address, b.city, b.state, b.zip,
      lb.created_at AS printed_at,
      (SELECT COALESCE(SUM(p.quantity), 0) FROM order_parcels p WHERE p.order_id = o.id) AS units_sent
    FROM orders o
    LEFT JOIN buyers b ON b.discord_id = o.buyer_id
    LEFT JOIN products pr ON pr.id = o.product_id
    LEFT JOIN label_batches lb ON lb.id = o.label_batch_id
    WHERE o.status = 'paid'
    ORDER BY COALESCE(o.paid_at, o.claimed_at), o.id
  `).all();
  const codes = codesForBoard();

  const parcel = (o) => {
    const paidAt = o.paid_at || o.claimed_at;
    return {
      id: o.id,
      ref: o.reference_code,
      buyer: o.buyer_name || 'No name',
      place: [o.city, o.state].filter(Boolean).join(' '),
      address: hasAddress(o),
      product: o.product_name,
      qty: o.quantity,
      express: o.shipping_method === 'express',
      sent: o.units_sent,
      paidAt,
      days: Math.max(0, Math.floor((now.getTime() - Date.parse(paidAt)) / DAY)),
      // An uploaded tracking code waiting for this parcel to be ticked.
      code: codes.byOrder.get(o.id) || null,
      // Sold on eBay: its tracking goes to eBay, and eBay wants it posted by shipBy.
      ebay: o.source === 'ebay',
      shipBy: o.ship_by || null,
    };
  };

  // Groups are titled with the products' long names; a batch can hold several.
  const printed = new Map();
  const unprinted = new Map();
  for (const o of rows) {
    const long = o.display_name || o.product_name;
    if (o.label_batch_id) {
      if (!printed.has(o.label_batch_id)) printed.set(o.label_batch_id, { batchId: o.label_batch_id, names: new Set(), printedAt: o.printed_at, parcels: [] });
      const g = printed.get(o.label_batch_id);
      g.names.add(long);
      g.parcels.push(parcel(o));
    } else {
      if (!unprinted.has(o.product_id)) unprinted.set(o.product_id, { productId: o.product_id, product: long, parcels: [] });
      unprinted.get(o.product_id).parcels.push(parcel(o));
    }
  }

  const shipped = db.prepare(`
    SELECT o.id, o.reference_code, o.product_name, o.quantity, o.shipped_at, o.tracking_code, b.name AS buyer_name
    FROM orders o LEFT JOIN buyers b ON b.discord_id = o.buyer_id
    WHERE o.status = 'shipped' AND o.shipped_at >= ?
    ORDER BY o.shipped_at DESC, o.id DESC
    LIMIT 200
  `).all(new Date(now.getTime() - SHIPPED_DAYS * DAY).toISOString()).map((o) => ({
    id: o.id, ref: o.reference_code, buyer: o.buyer_name || 'No name', product: o.product_name,
    qty: o.quantity, shippedAt: o.shipped_at, tracking: o.tracking_code || null,
  }));

  const all = rows.map(parcel);
  return {
    totals: {
      parcels: all.length,
      units: all.reduce((n, p) => n + p.qty, 0),
      oldestDays: all.length ? Math.max(...all.map((p) => p.days)) : null,
      noAddress: all.filter((p) => !p.address).length,
      express: all.filter((p) => p.express).length,
    },
    printed: [...printed.values()]
      .sort((a, b) => String(a.printedAt).localeCompare(String(b.printedAt)))
      .map(({ names, ...g }) => ({ ...g, title: [...names].join(' + ') })),
    unprinted: [...unprinted.values()],
    shipped,
    codes: { waiting: codes.waiting, ready: codes.byOrder.size, unmatched: codes.unmatched, forShipped: codes.forShipped },
    states: STATES,
    sources: SOURCES,
  };
}

/**
 * Ticks parcels off as posted. With a tracking number (one parcel), it's
 * also stored, and the caller tells the buyer.
 */
export function shipOrders(ids, { tracking = null } = {}) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number))].filter(Number.isInteger);
  if (!list.length) return { error: 'Tick the parcels that went out.' };
  if (list.length > 300) return { error: 'That\'s a lot at once. Do 300 or fewer.' };
  const code = tracking ? String(tracking).replace(/\s+/g, '').toUpperCase() : '';
  if (code) {
    if (list.length !== 1) return { error: 'A tracking number goes on one parcel at a time.' };
    if (!/^[A-Z0-9-]{8,40}$/.test(code)) return { error: 'That doesn\'t look like a tracking number.' };
    const r = markShipped(list[0], code);
    if (!r.ok) return { error: 'That one is already marked as shipped. Reload the page.' };
    return { shipped: [r.order], text: `${r.order.reference_code} shipped, with tracking.` };
  }
  const shipped = markPosted(list);
  if (!shipped.length) return { error: 'Those are already marked as shipped. Reload the page.' };
  return { shipped, text: `${plural(shipped.length, 'parcel')} marked as shipped.` };
}

/** Puts a parcel ticked by mistake back on the list. */
export function unshipFromBoard(id) {
  const r = unshipOrder(Number(id));
  if (!r.ok) return { error: 'That one isn\'t marked as shipped. Reload the page.' };
  return { order: r.order, text: `${r.order.reference_code} is back on the list.` };
}

function labelFileFor(batch, orders) {
  const missing = orders.filter((o) => !hasAddress(getBuyer(o.buyer_id)));
  return {
    batchId: batch.id,
    csv: labelRowsToCsv(labelRowsByBuyer(orders)),
    filename: `labels-batch-${batch.id}-${slugify(batch.title).slice(0, 40) || 'drop'}.csv`,
    orders,
    missing: missing.map((o) => getBuyer(o.buyer_id)?.name || o.reference_code),
  };
}

/** Makes the labels for everything of one product not printed yet: the same as Print labels. */
export function makeLabels(productId, createdBy = null) {
  const { included } = planBatch([Number(productId)]);
  if (!included.length) return { error: 'Those labels are already made. Reload the page.' };
  const { batch, orders } = createBatch(included, included[0].product_name, createdBy);
  if (!orders.length) return { error: 'Those labels were just made by someone else. Reload the page.' };
  return labelFileFor(batch, orders);
}

/** The label file of a batch again, without the parcels already posted. */
export function remakeLabels(batchId) {
  const batch = getBatch(batchId);
  const orders = batch ? openOrdersInBatch(batch.id) : [];
  if (!orders.length) return { error: 'Everything on those labels has been posted. Reload the page.' };
  setLabelsBatch(batch.id);
  return labelFileFor(batch, orders);
}

/** Past buyers by name, newest first, so a repeat buyer's saved address can be used. */
export function searchBuyers(query) {
  const q = text(query, 60).toLowerCase();
  if (q.length < 2) return [];
  return getDb().prepare(`
    SELECT b.discord_id, b.name, b.phone, b.shipping_address, b.city, b.state, b.zip,
      (SELECT MAX(COALESCE(o.paid_at, o.claimed_at)) FROM orders o WHERE o.buyer_id = b.discord_id) AS last_order
    FROM buyers b
    WHERE b.name IS NOT NULL AND LOWER(b.name) LIKE ?
    ORDER BY last_order IS NULL, last_order DESC
    LIMIT 8
  `).all(`%${q}%`).map((b) => ({
    id: b.discord_id,
    name: b.name,
    discord: !b.discord_id.startsWith('ext:'),
    address: hasAddress(b) ? `${b.shipping_address}, ${b.city} ${b.state} ${b.zip}` : null,
    lastOrder: b.last_order,
  }));
}

// Someone new under a name already used for a different address gets their
// own record, so the other person's saved address is never overwritten.
function newBuyerId(name, street) {
  const base = syntheticBuyerId(name);
  const same = (a, b) => String(a || '').toLowerCase().replace(/\W+/g, '') === String(b || '').toLowerCase().replace(/\W+/g, '');
  for (let i = 1; i < 100; i += 1) {
    const id = i === 1 ? base : `${base}-${i}`;
    const b = getBuyer(id);
    if (!b || !b.shipping_address || same(b.shipping_address, street)) return id;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Adds someone to the label list: an order that's already paid (or free, a
 * giveaway or a replacement), ready to print like any other. The same as
 * /logsale. A saved buyer keeps their address unless a new one is typed.
 */
export function addToLabelList(input = {}) {
  const saved = input.buyerId ? getBuyer(String(input.buyerId)) : null;
  if (input.buyerId && !saved) return { error: 'That buyer is gone. Search again.' };
  const name = text(input.name, 80) || saved?.name || '';
  if (!name) return { error: 'Who is it for?' };

  const qty = Number(input.quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 999) return { error: 'How many?' };

  const paidText = String(input.paid ?? '').replace(/[$,\s]/g, '');
  const paid = paidText ? Number(paidText) : 0;
  if (!Number.isFinite(paid) || paid < 0 || paid > 100000) return { error: 'Type what they paid, like 295, or leave it blank if it was free.' };
  const totalCents = Math.round(paid * 100);

  let product = input.productId ? getProductById(Number(input.productId)) : null;
  const typed = text(input.productName, 60);
  if (!product && typed) {
    product = findProductByName(typed);
    if (!product) {
      // Made for the label and the books, never put on sale.
      product = createProduct({ name: typed, priceCents: Math.round(totalCents / qty), quantity: 0 });
      setProductActive(product.id, false);
    }
  }
  if (!product) return { error: 'Pick what they bought, or type it.' };

  const street = text(input.street, 120);
  const suburb = text(input.suburb, 60);
  const state = text(input.state, 3).toUpperCase();
  const postcode = text(input.postcode, 4);
  const address = {
    street: street || saved?.shipping_address || '',
    suburb: suburb || saved?.city || '',
    state: state || saved?.state || '',
    postcode: postcode || saved?.zip || '',
  };
  if (!address.street || !address.suburb || !address.state || !address.postcode) {
    return { error: 'Add their address: street, suburb, state and postcode.' };
  }
  if (!STATES.includes(address.state)) return { error: 'Pick their state.' };
  if (!/^\d{4}$/.test(address.postcode)) return { error: 'The postcode should be 4 numbers.' };

  const method = input.method === 'express' ? 'express' : 'standard';
  const result = logManualOrder({
    product,
    quantity: qty,
    totalCents,
    shippingCents: method === 'express' ? config.expressShippingCents : config.standardShippingCents,
    shippingMethod: method,
    source: SOURCES.includes(input.source) ? input.source : 'other',
    discordId: saved ? saved.discord_id : newBuyerId(name, address.street),
    name,
    phone: text(input.phone, 20) || null,
    address: street || null,
    city: suburb || null,
    state: state || null,
    zip: postcode || null,
  });
  if (!result.ok) return { error: 'Couldn\'t add that. Try again.' };
  const order = result.order;
  return {
    ok: true,
    order,
    text: `Added ${order.reference_code}: ${qty}x ${product.name} for ${name}${method === 'express' ? ', express' : ''}. It's under Not printed yet.`,
  };
}

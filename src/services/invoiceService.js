import { getDb } from '../db/database.js';
import { config } from '../config.js';
import { getMeta, setMeta } from './metaService.js';
import { getBuyer } from './buyerService.js';
import { getOrderById } from './orderService.js';
import { getProductById } from './productService.js';
import { ZONE } from './scheduleService.js';

/**
 * Invoices: numbering, records, and the plain-text form they are typed in.
 *
 * Numbers carry on from the ones made by hand (INV-0001 and INV-0002 came
 * from make_invoice.py), so INVOICE_START says where the bot picks up.
 * Every invoice is stored, so a number is never handed out twice.
 */

const NEXT_KEY = 'invoice_next';

export function dateLong(date) {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: ZONE, day: 'numeric', month: 'long', year: 'numeric',
  }).format(date);
}

/** Who the invoice is from, and how to pay. Set on Railway, never in code. */
export function invoiceSender() {
  const from = (process.env.INVOICE_FROM || 'Lachlan Nguyen\\nlachie@tcgpackbot.com\\n0423 596 688')
    .split(/\\n|\n/).map((l) => l.trim()).filter(Boolean);
  const payment = [
    ['PayID', config.payId],
    ['Account name', process.env.INVOICE_ACCOUNT_NAME],
    ['BSB', process.env.INVOICE_BSB],
    ['Account number', process.env.INVOICE_ACCOUNT_NUMBER],
  ].filter(([, v]) => v && String(v).trim());
  return { from, payment };
}

const cents = (text) => Math.round(Number(String(text).replace(/[$,\s]/g, '')) * 100);

/**
 * One item per line: "6 x 30th Anniversary booster box @ 114". The quantity
 * is optional (means 1), "x" can be left out, "$" and commas are fine.
 * Returns the items, or the lines it could not read so the reply can say.
 */
export function parseItems(text) {
  const items = [];
  const bad = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(?:(\d+)\s*[x×*]?\s+)?(.+?)\s*@\s*\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:each|ea)?$/i);
    if (!m || !Number.isFinite(cents(m[3]))) {
      bad.push(line);
      continue;
    }
    items.push({ qty: m[1] ? Number(m[1]) : 1, description: m[2].trim(), unitCents: cents(m[3]) });
  }
  return { items, bad };
}

/** "10", "$10", "express 10", "standard 5", or blank for none. */
export function parseShipping(text) {
  const t = String(text || '').trim();
  if (!t) return { cents: 0, label: 'Shipping' };
  const m = t.match(/^([a-z][a-z ]*?)?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)$/i);
  if (!m) return null;
  return { cents: cents(m[2]), label: m[1] ? `Shipping (${m[1].trim().toLowerCase()})` : 'Shipping' };
}

export const isYes = (text) => /^\s*(y|yes|paid|yep|yeah)\b/i.test(String(text || ''));

/** What the pop-up starts with when an order was picked. */
export function prefillFromOrder(orderId) {
  const order = getOrderById(orderId);
  if (!order) return null;
  const buyer = getBuyer(order.buyer_id);
  const saved = getDb().prepare('SELECT bill_to FROM invoice_billing WHERE buyer_id = ?').get(order.buyer_id);
  const product = getProductById(order.product_id);
  const name = product?.display_name?.trim() || order.product_name;
  const unit = (order.unit_price_cents / 100).toFixed(2).replace(/\.00$/, '');
  return {
    order,
    billTo: saved?.bill_to || buyer?.name || '',
    items: `${order.quantity} x ${name} @ ${unit}`,
    shipping: `${order.shipping_method || 'standard'} ${(order.shipping_cents / 100).toFixed(2).replace(/\.00$/, '')}`,
    paid: ['paid', 'shipped', 'archived'].includes(order.status) ? 'yes' : 'no',
    note: `Order ${order.reference_code}`,
  };
}

/**
 * Saves an invoice and gives it the next number, in one transaction so two
 * at once can never share a number. Remembers the bill-to for that buyer, so
 * the next invoice for them comes pre-filled with their ABN or business name.
 */
export function recordInvoice({ billTo, items, shipping, paid, note, orderId, createdBy }) {
  const db = getDb();
  const run = db.transaction(() => {
    const start = Number(process.env.INVOICE_START || 3);
    const next = Math.max(Number(getMeta(NEXT_KEY) || start), start);
    setMeta(NEXT_KEY, next + 1);
    const number = `INV-${String(next).padStart(4, '0')}`;
    const total = items.reduce((s, i) => s + i.qty * i.unitCents, 0) + shipping.cents;
    db.prepare(`
      INSERT INTO invoices (number, bill_to, items, shipping_cents, shipping_label, paid, note, order_id, total_cents, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(number, billTo, JSON.stringify(items), shipping.cents, shipping.label, paid ? 1 : 0,
      note || null, orderId || null, total, createdBy || null, new Date().toISOString());
    if (orderId) {
      const order = getOrderById(orderId);
      if (order) {
        db.prepare(`
          INSERT INTO invoice_billing (buyer_id, bill_to) VALUES (?, ?)
          ON CONFLICT(buyer_id) DO UPDATE SET bill_to = excluded.bill_to
        `).run(order.buyer_id, billTo);
      }
    }
    return number;
  });
  return run();
}

/** The orders the dropdown offers, newest first, searchable by name or reference. */
export function invoiceableOrders(typed = '', limit = 25) {
  const rows = getDb().prepare(`
    SELECT * FROM orders WHERE status IN ('pending', 'paid', 'shipped', 'archived')
    ORDER BY claimed_at DESC LIMIT 300
  `).all();
  const t = String(typed || '').toLowerCase();
  const out = [];
  for (const o of rows) {
    const who = getBuyer(o.buyer_id)?.name || 'Unknown';
    const label = `${who} · ${o.quantity}x ${o.product_name} · $${(o.total_cents / 100).toFixed(2)} · `
      + `${o.status === 'pending' ? 'unpaid' : 'paid'} (${o.reference_code})`;
    if (!t || label.toLowerCase().includes(t)) out.push({ name: label.slice(0, 100), value: String(o.id) });
    if (out.length >= limit) break;
  }
  return out;
}

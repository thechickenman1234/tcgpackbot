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

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function melbourneParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(date).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day };
}

/** "29/9/2026", in Melbourne, for the date box. */
export function dateShort(date) {
  const { y, m, d } = melbourneParts(date);
  return `${d}/${m}/${y}`;
}

/**
 * The invoice date box: "today", "29/9/2026", "29/9", "29-09-26", "29 Sep 2026"
 * or "2026-09-29". Day first. No year means this year, because an invoice
 * date is usually now or a few days ago, never next year. Returns a Date at
 * midday UTC, which is the same calendar day in Melbourne, or null.
 */
export function parseInvoiceDate(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || t === 'today') return new Date();
  let y;
  let m;
  let d;
  let hit = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (hit) [, y, m, d] = hit.map(Number);
  hit = hit || t.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (hit && d === undefined) [d, m, y] = [Number(hit[1]), Number(hit[2]), hit[3] ? Number(hit[3]) : undefined];
  if (!hit) {
    const w = t.replace(/^[a-z]+,?\s+/, '').match(/^(\d{1,2})\s*([a-z]{3})[a-z]*\.?(?:\s+(\d{2,4}))?$/);
    if (!w || !MONTHS.includes(w[2])) return null;
    [d, m, y] = [Number(w[1]), MONTHS.indexOf(w[2]) + 1, w[3] ? Number(w[3]) : undefined];
  }
  if (y === undefined) y = melbourneParts(new Date()).y;
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  // Rejects 31/2 and friends, which Date would quietly roll into March.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}

const plain = (centsValue) => (centsValue / 100).toFixed(2).replace(/\.00$/, '');

/** What an order looks like on an invoice. Shared by the pop-up and /paid. */
function orderDetails(order) {
  const buyer = getBuyer(order.buyer_id);
  const saved = getDb().prepare('SELECT bill_to FROM invoice_billing WHERE buyer_id = ?').get(order.buyer_id);
  const product = getProductById(order.product_id);
  const name = product?.display_name?.trim() || order.product_name;
  const method = order.shipping_method || 'standard';
  return {
    billTo: saved?.bill_to || buyer?.name || '',
    item: { qty: order.quantity, description: name, unitCents: order.unit_price_cents },
    itemLine: `${order.quantity} x ${name} @ ${plain(order.unit_price_cents)}`,
    shipping: { cents: order.shipping_cents, label: `Shipping (${method})` },
    shippingLine: `${method} ${plain(order.shipping_cents)}`,
    note: `Order ${order.reference_code}`,
    paid: ['paid', 'shipped', 'archived'].includes(order.status),
  };
}

/** What the pop-up starts with when an order was picked. */
export function prefillFromOrder(orderId) {
  const order = getOrderById(orderId);
  if (!order) return null;
  const o = orderDetails(order);
  return {
    order,
    billTo: o.billTo,
    items: o.itemLine,
    shipping: o.shippingLine,
    paid: o.paid ? 'yes' : 'no',
    // A paid order is invoiced on the day it was paid.
    date: dateShort(o.paid && order.paid_at ? new Date(order.paid_at) : new Date()),
  };
}

/**
 * Everything an invoice for a just-paid order needs, with no typing: used by
 * /paid to drop a PAID invoice into the buyer's ticket.
 */
export function paidInvoiceFor(order, createdBy = null) {
  const o = orderDetails(order);
  const issued = order.paid_at ? new Date(order.paid_at) : new Date();
  const number = recordInvoice({
    billTo: o.billTo, items: [o.item], shipping: o.shipping, paid: true, note: o.note,
    orderId: order.id, createdBy, issuedOn: issued,
  });
  return {
    number, issued, billTo: o.billTo.split('\n').filter(Boolean), items: [o.item], shipping: o.shipping, note: o.note,
  };
}

/**
 * Saves an invoice and gives it the next number, in one transaction so two
 * at once can never share a number. Remembers the bill-to for that buyer, so
 * the next invoice for them comes pre-filled with their ABN or business name.
 */
export function recordInvoice({ billTo, items, shipping, paid, note, orderId, createdBy, issuedOn = new Date() }) {
  const db = getDb();
  const run = db.transaction(() => {
    const start = Number(process.env.INVOICE_START || 3);
    const next = Math.max(Number(getMeta(NEXT_KEY) || start), start);
    setMeta(NEXT_KEY, next + 1);
    const number = `INV-${String(next).padStart(4, '0')}`;
    const total = items.reduce((s, i) => s + i.qty * i.unitCents, 0) + shipping.cents;
    db.prepare(`
      INSERT INTO invoices (number, bill_to, items, shipping_cents, shipping_label, paid, note, order_id, total_cents, created_by, created_at, issued_on)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(number, billTo, JSON.stringify(items), shipping.cents, shipping.label, paid ? 1 : 0,
      note || null, orderId || null, total, createdBy || null, new Date().toISOString(), issuedOn.toISOString());
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

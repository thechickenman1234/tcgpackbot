import { getDb } from '../db/database.js';
import { createProduct, findProductByName, getProductById, setProductActive, setProductCost } from './productService.js';
import { logManualOrder } from './manualOrderService.js';
import { markShipped } from './orderService.js';
import { addExpense, deleteExpense, labelCostFor, periodRange, soldOrders } from './profitService.js';
import { isDead, wiseStatus } from './wiseService.js';
import { melbourneToUtc } from './scheduleService.js';

/**
 * What the Wise payments mean, and wholesale sales made outside the bot.
 *
 * A Wise payment gets one tag on the dashboard:
 *   stock      paid a supplier for N units of a product; sets that
 *              product's real cost per unit (amount / N) unless told not to
 *   freight    shipping for N units of a product; adds amount / N to its
 *              real cost. Without a product it's an expense instead
 *   expense    anything else for the business: becomes an Other expense
 *   wholesale  money in from a wholesale customer: becomes a sale
 *   ignore     not business (his own transfers are tagged this on arrival)
 *
 * Profit stays worked out on what's sold (unit cost x units sold); these
 * tags are what make those unit costs real. The cash check beside it (money
 * in against what left Wise) catches anything that slipped through.
 */

const TAGS = new Set(['stock', 'freight', 'expense', 'wholesale', 'ignore']);

export function getPayment(id) {
  return getDb().prepare('SELECT * FROM wise_payments WHERE id = ?').get(id);
}

function live(rows) {
  return rows.filter((p) => !isDead(p.status));
}

export function untaggedPayments(limit = 50) {
  return live(getDb().prepare('SELECT * FROM wise_payments WHERE tag IS NULL ORDER BY happened_at DESC').all()).slice(0, limit);
}

export function recentlyTagged(limit = 20) {
  return getDb().prepare(`
    SELECT w.*, p.name AS product_name FROM wise_payments w LEFT JOIN products p ON p.id = w.product_id
    WHERE w.tag IS NOT NULL ORDER BY w.tagged_at DESC LIMIT ?
  `).all(limit);
}

function setTag(id, fields) {
  const cols = Object.keys(fields);
  getDb().prepare(`UPDATE wise_payments SET ${cols.map((c) => `${c} = ?`).join(', ')}, tagged_at = ? WHERE id = ?`)
    .run(...cols.map((c) => fields[c]), new Date().toISOString(), id);
  return getPayment(id);
}

const dateOf = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' });

/**
 * Tags a payment. Returns { ok, text } or { error }. The money it moved is
 * the AUD side, or the yen at JPY_PER_AUD when Wise gave no AUD amount.
 */
export function tagPayment(id, { tag, productId = null, units = null, setCost = true, note = null } = {}) {
  const p = getPayment(id);
  if (!p) return { error: 'That payment is gone. Reload the page.' };
  if (p.tag === 'wholesale' && p.order_id) return { error: `That's already the sale for order #${p.order_id}. Change the order instead.` };
  if (!TAGS.has(tag)) return { error: 'Pick what it was.' };
  if (p.aud_cents == null && tag !== 'ignore') return { error: "Wise didn't give an AUD amount for this one, so it can't be costed." };

  // A tag changed from expense loses its expense row.
  if (p.expense_id && tag !== 'expense') deleteExpense(p.expense_id);

  if (tag === 'ignore') {
    setTag(id, { tag, product_id: null, units: null, expense_id: null, note });
    return { ok: true, text: 'Marked not business.' };
  }

  if (tag === 'expense' || (tag === 'freight' && !productId)) {
    const expense = p.expense_id && tag === 'expense' ? { id: p.expense_id } : addExpense({
      spentOn: dateOf(p.happened_at),
      amountCents: p.aud_cents,
      what: note || `${tag === 'freight' ? 'Freight' : 'Wise payment'} to ${p.counterparty || 'unknown'}`,
    });
    setTag(id, { tag, product_id: null, units: null, expense_id: expense.id, note });
    return { ok: true, text: tag === 'freight' ? 'Counted as freight in Other expenses.' : 'Added to Other expenses.' };
  }

  if (tag === 'wholesale') return { error: 'Use Add as a wholesale sale for money in.' };

  const product = getProductById(Number(productId));
  const n = Number(units);
  if (!product) return { error: 'Pick the product.' };
  if (!Number.isInteger(n) || n < 1) return { error: 'Type how many units it was for.' };

  setTag(id, { tag, product_id: product.id, units: n, expense_id: null, note });
  if (!setCost) return { ok: true, text: `Tagged as ${tag} for ${n}x ${product.name}. Its cost wasn't changed.` };
  const cost = landedCostFromWise(product.id);
  if (cost == null) {
    // Freight before any supplier payment is tagged: add it on top of what's there.
    const each = Math.round(p.aud_cents / n);
    setProductCost(product.id, (product.cost_cents ?? 0) + each, { actual: true });
    return { ok: true, text: `Freight: $${(each / 100).toFixed(2)} a unit added to ${product.name}'s cost.` };
  }
  setProductCost(product.id, cost.each, { actual: true });
  return {
    ok: true,
    text: `${product.name} now costs $${(cost.each / 100).toFixed(2)} each, real: $${(cost.stock / 100).toFixed(2)} stock`
      + `${cost.freight ? ` + $${(cost.freight / 100).toFixed(2)} freight` : ''} over ${cost.units} units.`,
  };
}

/**
 * A product's landed cost per unit from what was tagged in Wise: its latest
 * supplier payment (with any others within 3 days, for a split payment)
 * plus freight tagged to it from a week before that on, over the units the
 * supplier payments were for. Null when no supplier payment is tagged yet.
 */
export function landedCostFromWise(productId) {
  const rows = live(getDb().prepare(`
    SELECT * FROM wise_payments WHERE product_id = ? AND tag IN ('stock', 'freight') ORDER BY happened_at
  `).all(productId));
  const stocks = rows.filter((p) => p.tag === 'stock');
  if (!stocks.length) return null;
  const latest = Date.parse(stocks[stocks.length - 1].happened_at);
  const batch = stocks.filter((p) => latest - Date.parse(p.happened_at) <= 3 * 86400000);
  const units = batch.reduce((t, p) => t + (p.units || 0), 0);
  if (!units) return null;
  const stock = batch.reduce((t, p) => t + p.aud_cents, 0);
  const freight = rows.filter((p) => p.tag === 'freight' && Date.parse(p.happened_at) >= latest - 7 * 86400000)
    .reduce((t, p) => t + p.aud_cents, 0);
  return { each: Math.round((stock + freight) / units), stock, freight, units };
}

export function untagPayment(id) {
  const p = getPayment(id);
  if (!p) return { error: 'That payment is gone. Reload the page.' };
  if (p.tag === 'wholesale' && p.order_id) return { error: `That's the sale for order #${p.order_id}. Change the order instead.` };
  if (p.expense_id) deleteExpense(p.expense_id);
  getDb().prepare('UPDATE wise_payments SET tag = NULL, product_id = NULL, units = NULL, expense_id = NULL, note = NULL, tagged_at = NULL WHERE id = ?').run(id);
  return { ok: true, text: 'Back on the to-tag list. A real cost it set stays; change it under Costs if needed.' };
}

/**
 * A wholesale sale made outside the bot. It becomes a paid order (source
 * wholesale), so it counts in sales, profit and the buyer lists like any
 * other, and it's marked sent unless it still needs a label. A product name
 * that doesn't exist yet becomes a product (switched off, never on sale).
 */
export function addWholesaleSale({ customer, productId = null, productName = null, quantity, totalCents, date = null, sent = true, paymentId = null }) {
  const name = String(customer || '').trim().slice(0, 80);
  const qty = Number(quantity);
  if (!name) return { error: 'Who bought it?' };
  if (!Number.isInteger(qty) || qty < 1) return { error: 'How many?' };
  if (!(totalCents > 0)) return { error: 'What did they pay in total?' };

  let product = productId ? getProductById(Number(productId)) : null;
  if (!product && productName) {
    const typed = String(productName).trim().slice(0, 60);
    product = findProductByName(typed);
    if (!product && typed) {
      product = createProduct({ name: typed, priceCents: Math.round(totalCents / qty), quantity: 0 });
      setProductActive(product.id, false);
    }
  }
  if (!product) return { error: 'Pick the product, or type a new one.' };

  const payment = paymentId ? getPayment(paymentId) : null;
  if (paymentId && !payment) return { error: 'That Wise payment is gone. Reload the page.' };
  if (payment?.order_id) return { error: 'That payment already has its sale.' };

  const result = logManualOrder({ product, quantity: qty, totalCents, source: 'wholesale', name });
  if (!result.ok) return { error: "Couldn't save the sale." };
  let order = result.order;

  const when = date || (payment ? dateOf(payment.happened_at) : null);
  if (when) {
    const at = melbourneToUtc(when, '12:00')?.toISOString();
    if (at) getDb().prepare('UPDATE orders SET claimed_at = ?, paid_at = ?, payment_deadline_at = ? WHERE id = ?').run(at, at, at, order.id);
  }
  if (sent) order = markShipped(order.id, null).order || order;
  if (payment) setTag(payment.id, { tag: 'wholesale', product_id: product.id, units: qty, order_id: order.id, expense_id: null });
  return { ok: true, order, product, text: `Wholesale sale saved: ${qty}x ${product.name} to ${name}, $${(totalCents / 100).toFixed(2)} (${order.reference_code}).` };
}

/** The Money section: Wise status, what to tag, what's tagged, and the cash check for a period. */
export function moneySummary(periodKey) {
  const r = periodRange(periodKey);
  const sold = soldOrders(r);
  const sales = sold.reduce((t, o) => t + o.total_cents, 0);
  const postage = sold.reduce((t, o) => t + labelCostFor(o), 0);
  const rows = live(getDb().prepare(`
    SELECT * FROM wise_payments WHERE (? IS NULL OR happened_at >= ?) AND (? IS NULL OR happened_at < ?)
  `).all(r.sinceIso, r.sinceIso, r.untilIso, r.untilIso));
  const total = (filter) => rows.filter(filter).reduce((t, p) => t + (p.aud_cents || 0), 0);
  const byTag = {
    stock: total((p) => p.direction === 'out' && p.tag === 'stock'),
    freight: total((p) => p.direction === 'out' && p.tag === 'freight'),
    expense: total((p) => p.direction === 'out' && p.tag === 'expense'),
    wholesaleIn: total((p) => p.direction === 'in' && p.tag === 'wholesale'),
    untaggedOut: total((p) => p.direction === 'out' && !p.tag),
    untaggedIn: total((p) => p.direction === 'in' && !p.tag),
  };
  const out = byTag.stock + byTag.freight + byTag.expense + postage;
  return {
    status: wiseStatus(),
    untagged: untaggedPayments(),
    recent: recentlyTagged(),
    period: r.label,
    byTag,
    cash: { in: sales, out, net: sales - out, postage },
  };
}

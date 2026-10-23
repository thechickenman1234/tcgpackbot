import { getDb } from '../db/database.js';
import { config } from '../config.js';
import { nowIso } from '../utils/permissions.js';
import { melbourneToUtc, ZONE } from './scheduleService.js';

/**
 * Profit, worked out from what the bot already knows, so nothing gets typed
 * in per order:
 *
 *   sales    each paid order's total, shipping the buyer paid included
 *   stock    the unit cost x quantity (the order's own cost, else its product's)
 *   postage  the Label Pro label it took: standard or express, none for pickups
 *   expenses anything else typed on the dashboard (packaging, fees), by date
 *
 * The one thing to remember is a product's cost. It starts as the estimate
 * from the quote (set when the sale is queued) and becomes actual once the
 * real figure goes in on the dashboard; profit built on estimates says so.
 * Orders whose product has no cost at all are listed apart and left out of
 * the profit, never guessed, and the daily reminder asks for them.
 */

const DAY = 86400000;

export const PERIODS = {
  today: 'Today',
  week: 'This week',
  last_week: 'Last week',
  month: 'This month',
  last_month: 'Last month',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All time',
};

/** "$1,234.50", or "-$12.00". */
export function money(cents) {
  const n = Math.abs(cents) / 100;
  const s = n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${cents < 0 ? '-' : ''}$${s}`;
}

/** Postage for one order: one order is one parcel is one label. */
export function labelCostFor(order) {
  if (!order.shipping_cents) return 0;
  const express = order.shipping_method === 'express'
    || (!order.shipping_method && order.shipping_cents >= config.expressShippingCents);
  return express ? config.labelCostExpressCents : config.labelCostStandardCents;
}

function melbourneToday(now) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now)) parts[p.type] = p.value;
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), weekday: parts.weekday };
}

/** A calendar date as "YYYY-MM-DD", with day and month overflow rolled over. */
function ymd(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

const midnight = (date) => melbourneToUtc(date, '00:00').toISOString();

/** Start (inclusive) and end (exclusive) of a period, in Melbourne days. */
export function periodRange(key, now = new Date()) {
  const { y, m, d, weekday } = melbourneToday(now);
  const sinceMonday = (['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekday) + 7) % 7;
  const label = PERIODS[key] || PERIODS.week;
  switch (key) {
    case 'today':
      return { label, sinceIso: midnight(ymd(y, m, d)), untilIso: null };
    case 'last_week':
      return { label, sinceIso: midnight(ymd(y, m, d - sinceMonday - 7)), untilIso: midnight(ymd(y, m, d - sinceMonday)) };
    case 'month':
      return { label, sinceIso: midnight(ymd(y, m, 1)), untilIso: null };
    case 'last_month':
      return { label, sinceIso: midnight(ymd(y, m - 1, 1)), untilIso: midnight(ymd(y, m, 1)) };
    case '30d':
      return { label, sinceIso: new Date(now.getTime() - 30 * DAY).toISOString(), untilIso: null };
    case '90d':
      return { label, sinceIso: new Date(now.getTime() - 90 * DAY).toISOString(), untilIso: null };
    case 'all':
      return { label, sinceIso: null, untilIso: null };
    default:
      return { label: PERIODS.week, sinceIso: midnight(ymd(y, m, d - sinceMonday)), untilIso: null };
  }
}

/** Every sale paid in the window, tests left out, with its unit cost resolved. */
export function soldOrders({ sinceIso = null, untilIso = null, product = null } = {}) {
  const ex = config.profitExcludeBuyerIds;
  const notTests = ex.length ? `AND o.buyer_id NOT IN (${ex.map(() => '?').join(', ')})` : '';
  return getDb().prepare(`
    SELECT o.*, COALESCE(o.unit_cost_cents, p.cost_cents) AS cost_each,
      CASE WHEN o.unit_cost_cents IS NOT NULL THEN COALESCE(o.unit_cost_actual, 0) ELSE p.cost_actual END AS cost_actual
    FROM orders o LEFT JOIN products p ON p.id = o.product_id
    WHERE o.status IN ('paid', 'shipped', 'archived') ${notTests}
      AND (? IS NULL OR COALESCE(o.paid_at, o.claimed_at) >= ?)
      AND (? IS NULL OR COALESCE(o.paid_at, o.claimed_at) < ?)
      AND (? IS NULL OR LOWER(o.product_name) = LOWER(?))
    ORDER BY o.paid_at ASC
  `).all(...ex, sinceIso, sinceIso, untilIso, untilIso, product, product);
}

/** Adds a list of orders up into sales, costs and profit, overall and per product. */
export function summarise(orders) {
  const t = { orders: 0, units: 0, sales: 0, stock: 0, postage: 0, profit: 0, costedSales: 0, estimatedSales: 0 };
  const products = new Map();
  const missing = new Map();

  for (const o of orders) {
    const postage = labelCostFor(o);
    t.orders += 1;
    t.units += o.quantity;
    t.sales += o.total_cents;

    const p = products.get(o.product_name)
      || { product: o.product_name, productId: o.product_id, units: 0, sales: 0, profit: 0, costed: true, estimated: false };
    p.units += o.quantity;
    p.sales += o.total_cents;
    products.set(o.product_name, p);

    if (o.cost_each == null) {
      const miss = missing.get(o.product_name) || { product: o.product_name, productId: o.product_id, units: 0, orders: 0 };
      miss.units += o.quantity;
      miss.orders += 1;
      missing.set(o.product_name, miss);
      p.costed = false;
      continue;
    }
    const stock = o.cost_each * o.quantity;
    const profit = o.total_cents - stock - postage;
    t.stock += stock;
    t.postage += postage;
    t.profit += profit;
    t.costedSales += o.total_cents;
    p.profit += profit;
    if (!o.cost_actual) {
      t.estimatedSales += o.total_cents;
      p.estimated = true;
    }
  }

  return {
    ...t,
    margin: t.costedSales ? t.profit / t.costedSales : null,
    products: [...products.values()].sort((a, b) => b.sales - a.sales),
    missing: [...missing.values()].sort((a, b) => b.units - a.units),
  };
}

export function profitFor(periodKey, { product = null, now = new Date() } = {}) {
  const range = periodRange(periodKey, now);
  const s = summarise(soldOrders({ ...range, product }));
  // Expenses aren't tied to a product, so a one-product view leaves them out.
  const expenses = product ? 0 : sumExpenses(range);
  return { ...range, ...s, expenses, net: s.profit - expenses };
}

// ---------------------------------------------------------------- expenses

/** spentOn is a Melbourne date, "YYYY-MM-DD"; it counts from that day's midnight. */
export function addExpense({ spentOn, amountCents, what }) {
  const result = getDb().prepare(`
    INSERT INTO expenses (spent_on, amount_cents, what, created_at) VALUES (?, ?, ?, ?)
  `).run(melbourneToUtc(spentOn, '00:00').toISOString(), amountCents, what, nowIso());
  return getDb().prepare('SELECT * FROM expenses WHERE id = ?').get(result.lastInsertRowid);
}

export function deleteExpense(id) {
  return getDb().prepare('DELETE FROM expenses WHERE id = ?').run(id).changes > 0;
}

export function listExpenses({ sinceIso = null, untilIso = null, limit = 100 } = {}) {
  return getDb().prepare(`
    SELECT * FROM expenses
    WHERE (? IS NULL OR spent_on >= ?) AND (? IS NULL OR spent_on < ?)
    ORDER BY spent_on DESC, id DESC LIMIT ?
  `).all(sinceIso, sinceIso, untilIso, untilIso, limit);
}

export function sumExpenses({ sinceIso = null, untilIso = null } = {}) {
  return getDb().prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS total FROM expenses
    WHERE (? IS NULL OR spent_on >= ?) AND (? IS NULL OR spent_on < ?)
  `).get(sinceIso, sinceIso, untilIso, untilIso).total;
}

/** Products sold recently whose cost is still the quote's estimate: the Monday report lists them. */
export function estimatedCosts({ days = 60, now = new Date() } = {}) {
  return summarise(soldOrders({ sinceIso: new Date(now.getTime() - days * DAY).toISOString() }))
    .products.filter((p) => p.costed && p.estimated);
}

/** Products sold recently with no cost yet: what the daily reminder asks for. */
export function missingCosts({ days = 14, now = new Date() } = {}) {
  return summarise(soldOrders({ sinceIso: new Date(now.getTime() - days * DAY).toISOString() })).missing;
}

/** The lines both /profit and the Monday report show. */
export function profitLines(s, { top = 8 } = {}) {
  if (!s.orders) return ['No sales in this period.'];
  const lines = [
    `**Sales** ${money(s.sales)} · ${s.orders} order${s.orders === 1 ? '' : 's'}, ${s.units} unit${s.units === 1 ? '' : 's'}`,
    `**Stock cost** ${money(-s.stock)}`,
    `**Postage** ${money(-s.postage)}`,
    `**Profit** ${money(s.profit)}${s.margin == null ? '' : ` (${(s.margin * 100).toFixed(1)}% margin)`}`,
  ];
  if (s.expenses) lines.push(`**Other expenses** ${money(-s.expenses)}`, `**Profit after expenses** ${money(s.net)}`);
  if (s.estimatedSales) {
    const share = Math.round((s.estimatedSales / s.costedSales) * 100);
    lines.push(`_${share}% of this uses estimated costs. Put the real ones in on the dashboard._`);
  }
  const costed = s.products.filter((p) => p.costed);
  if (costed.length) {
    lines.push('', '**By product**');
    for (const p of costed.slice(0, top)) {
      lines.push(`• ${p.product}: ${p.units} sold · ${money(p.sales)} · profit ${money(p.profit)}${p.estimated ? ' (est.)' : ''}`);
    }
    if (costed.length > top) lines.push(`…and ${costed.length - top} more.`);
  }
  if (s.missing.length) {
    lines.push('', `⚠️ **Not counted yet, no cost set** (${money(s.sales - s.costedSales)} of sales):`);
    for (const m of s.missing.slice(0, top)) lines.push(`• ${m.product}: ${m.units} unit${m.units === 1 ? '' : 's'}`);
    if (s.missing.length > top) lines.push(`…and ${s.missing.length - top} more.`);
    lines.push('Add their costs on the dashboard.');
  }
  return lines;
}

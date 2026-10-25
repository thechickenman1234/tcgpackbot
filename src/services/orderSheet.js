import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { getMeta, setMeta } from './metaService.js';
import { getProductById } from './productService.js';
import { money } from './profitService.js';
import { logToStaff } from './staffLog.js';
import { createStockBatch } from './stockTracker.js';
import { postStockCard } from '../handlers/stockCard.js';

/**
 * The supplier order, worked out the moment claims close, so nobody counts
 * tickets at midnight:
 *
 *   per product  claimed tonight (paid, still to pay), how many to order
 *                with a few spare, and what that costs landed
 *   the night    what the claims bring in, the stock cost, the rough profit
 *   supplier     a message ready to copy, one per supplier language
 *
 * Posted in the staff log when a sale ends, and again once the late window
 * and the payment deadline have passed, by when unpaid claims have either
 * paid or been cancelled. /ordersheet shows the latest one, live, any time.
 * The first one also starts the night's stock tracker, with its card.
 *
 * The nights are kept in bot_meta, not a table of their own: only the last
 * few matter, and only until their final count has gone out.
 */

const KEY = 'order_sheets';
const KEEP = 10;
const HOUR = 3600000;
// A sale that ends twice in one night (sold out at 9pm, then its scheduled
// close at midnight) is still one night.
const SAME_NIGHT = 12 * HOUR;
// Without a scheduled sale to say when it opened, count back this far.
const FALLBACK_LOOKBACK = 18 * HOUR;
const LANGUAGE = /^(japanese|chinese|english|korean|thai)\s+/i;

function loadSheets() {
  try {
    return JSON.parse(getMeta(KEY) || '[]');
  } catch {
    return [];
  }
}

function saveSheets(sheets) {
  setMeta(KEY, JSON.stringify(sheets.slice(-KEEP)));
}

/** When the final count goes out: after late claims shut and unpaid ones are cancelled. */
function finalDelayMs() {
  return Math.max(config.lateWindowHours, config.paymentDeadlineHours) * HOUR + 10 * 60000;
}

/** The numbers for one night, read fresh from the orders. */
export function orderSheet({ productIds, sinceIso }) {
  const exclude = config.profitExcludeBuyerIds;
  const not = exclude.length ? `AND buyer_id NOT IN (${exclude.map(() => '?').join(', ')})` : '';
  // Claim-sale orders only: a wholesale sale logged by hand left with stock
  // that was already here.
  const stmt = getDb().prepare(`
    SELECT
      COALESCE(SUM(quantity), 0) AS claimed,
      COALESCE(SUM(CASE WHEN status != 'pending' THEN quantity ELSE 0 END), 0) AS paid,
      COALESCE(SUM(CASE WHEN status = 'pending' AND proof_at IS NOT NULL THEN quantity ELSE 0 END), 0) AS proof,
      COALESCE(SUM(CASE WHEN source = 'late' THEN quantity ELSE 0 END), 0) AS late,
      COUNT(DISTINCT buyer_id) AS buyers,
      COALESCE(SUM(total_cents - shipping_cents), 0) AS sales
    FROM orders
    WHERE product_id = ? AND claimed_at >= ? AND status != 'cancelled'
      AND source IN ('claim', 'late') ${not}
  `);
  const now = new Date().toISOString();

  const items = productIds.map((id) => getProductById(id)).filter(Boolean).map((p) => {
    const r = stmt.get(p.id, sinceIso, ...exclude);
    const spare = r.claimed ? Math.max(1, Math.ceil((r.claimed * config.orderSparePercent) / 100)) : 0;
    const order = r.claimed + spare;
    return {
      product: p.name,
      display: p.display_name || `${p.name} ${p.unit || 'box'}`,
      ...r,
      toPay: r.claimed - r.paid,
      spare,
      order,
      cost: p.cost_cents,
      costActual: Boolean(p.cost_actual),
      orderCost: p.cost_cents == null ? null : order * p.cost_cents,
      lateUntil: p.late_until && p.late_until > now && p.quantity_available > 0 ? p.late_until : null,
    };
  });

  const costed = items.filter((i) => i.cost != null);
  const sales = costed.reduce((n, i) => n + i.sales, 0);
  const stock = costed.reduce((n, i) => n + i.claimed * i.cost, 0);
  return {
    items,
    claimed: items.reduce((n, i) => n + i.claimed, 0),
    toPay: items.reduce((n, i) => n + i.toPay, 0),
    sales,
    stock,
    profit: sales - stock,
    orderCost: costed.reduce((n, i) => n + i.orderCost, 0),
    uncosted: items.filter((i) => i.cost == null && i.claimed).map((i) => i.product),
  };
}

/** One message per supplier, told apart by the language the product is in. */
export function supplierMessages(items) {
  const groups = new Map();
  for (const item of items.filter((i) => i.order > 0)) {
    const m = item.display.match(LANGUAGE);
    const language = m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : '';
    const name = m ? item.display.slice(m[0].length) : item.display;
    if (!groups.has(language)) groups.set(language, []);
    groups.get(language).push(`• ${item.order} x ${name}`);
  }
  return [...groups].map(([language, lines]) => ({
    language,
    text: [
      'Hi! We\'d like to order:',
      ...lines,
      'Please send the total and payment details, and ship it to the usual address. Thank you!',
    ].join('\n'),
  }));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const stamp = (iso, style = 'f') => `<t:${Math.floor(Date.parse(iso) / 1000)}:${style}>`;

export function sheetTitle(sheet, { final = false } = {}) {
  const names = sheet.items.map((i) => i.product).join(' / ');
  return `📦 ${final ? 'Final order sheet' : 'Order sheet'}: ${names}`.slice(0, 250);
}

export function sheetText(sheet, { final = false, finalAt = null } = {}) {
  const lines = [];
  for (const i of sheet.items) {
    lines.push(`**${i.display}**`);
    if (!i.claimed) {
      lines.push('Nothing claimed.', '');
      continue;
    }
    const proof = i.proof ? ` (${i.proof} with a payment screenshot)` : '';
    lines.push(
      `Claimed **${i.claimed}** by ${plural(i.buyers, 'buyer')}${i.late ? ` (${i.late} late)` : ''}: `
        + `${i.paid} paid, ${i.toPay} to pay${proof}`,
      i.cost == null
        ? `Order **${i.order}** (${i.spare} spare) · no cost set yet, \`/cost ${i.product}\``
        : `Order **${i.order}** (${i.spare} spare) · ${money(i.cost)} each, ${i.costActual ? 'real cost' : 'estimate'} · **${money(i.orderCost)}**`,
      '',
    );
  }

  if (sheet.claimed) {
    lines.push('**The night**');
    if (sheet.sales) {
      lines.push(
        `Claims bring in ${money(sheet.sales)}, their stock costs ${money(sheet.stock)}`,
        `Profit about **${money(sheet.profit)}** (${((sheet.profit / sheet.sales) * 100).toFixed(1)}%) before postage`,
        `The order with spares: **${money(sheet.orderCost)}**`,
      );
    }
    if (sheet.uncosted.length) lines.push(`Leaves out ${sheet.uncosted.join(', ')}: no cost set.`);

    const late = sheet.items.map((i) => i.lateUntil).filter(Boolean).sort()[0];
    if (final) {
      lines.push(sheet.toPay
        ? `${plural(sheet.toPay, 'unit')} still to pay. Anyone past their deadline is cancelled and banned automatically.`
        : 'Everyone has paid.');
    } else if (late) {
      lines.push(`Late claims are open until ${stamp(late)} at +${config.lateMarkupPercent}%, so this can still grow.`
        + (finalAt ? ` The final count posts ${stamp(finalAt, 'R')}.` : ''));
    } else if (finalAt) {
      lines.push(`The final count posts ${stamp(finalAt, 'R')}, once unpaid claims have paid or been cancelled.`);
    }

    for (const m of supplierMessages(sheet.items)) {
      lines.push('', `**Message for the ${m.language ? `${m.language} ` : ''}supplier**`, '```', m.text, '```');
    }
    lines.push('Already have some in hand or on the way? Take them off before sending.');
  }
  return lines.join('\n').trim();
}

async function send(client, entry, final) {
  const sheet = orderSheet({ productIds: entry.ids, sinceIso: entry.sinceIso });
  if (final && !sheet.claimed) return;
  await logToStaff(client, {
    title: sheetTitle(sheet, { final }),
    description: sheetText(sheet, { final, finalAt: entry.finalAt }).slice(0, 4000),
    color: final ? 0x27ae60 : 0x3498db,
  });
}

/**
 * Called when claims close. Every product the sale had counts, so one that
 * sold out at 9pm is still on the midnight sheet. A night only gets one.
 */
export async function postOrderSheet(client, { productIds, sinceIso = null, now = new Date() }) {
  const ids = [...new Set(productIds.map(Number))].filter(Boolean).sort((a, b) => a - b);
  if (!ids.length) return null;

  const sheets = loadSheets();
  const key = ids.join(',');
  if (sheets.some((s) => s.ids.join(',') === key && now - Date.parse(s.closedAt) < SAME_NIGHT)) return null;

  const entry = {
    ids,
    sinceIso: sinceIso || new Date(now - FALLBACK_LOOKBACK).toISOString(),
    closedAt: now.toISOString(),
    finalAt: new Date(now.getTime() + finalDelayMs()).toISOString(),
    finalPostedAt: null,
  };
  sheets.push(entry);
  saveSheets(sheets);
  await send(client, entry, false);
  const batch = createStockBatch({ productIds: ids, sinceIso: entry.sinceIso, closedAt: entry.closedAt });
  if (batch) await postStockCard(client, batch);
  return entry;
}

/** The night that closed last, with its numbers as they are now. */
export function latestOrderSheet() {
  const entry = loadSheets().at(-1);
  if (!entry) return null;
  const sheet = orderSheet({ productIds: entry.ids, sinceIso: entry.sinceIso });
  const final = Boolean(entry.finalPostedAt);
  return { entry, sheet, title: sheetTitle(sheet, { final }), text: sheetText(sheet, { final, finalAt: entry.finalAt }) };
}

export async function runFinalOrderSheets(client, now = new Date()) {
  const sheets = loadSheets();
  const due = sheets.filter((s) => !s.finalPostedAt && Date.parse(s.finalAt) <= now.getTime());
  if (!due.length) return;
  // Stored before posting, so a restart or a failed post can never send it twice.
  for (const s of due) s.finalPostedAt = now.toISOString();
  saveSheets(sheets);
  for (const s of due) await send(client, s, true);
}

export function startOrderSheetJob(client, intervalMs = 5 * 60000) {
  return setInterval(() => {
    runFinalOrderSheets(client).catch((err) => console.error('Order sheet job failed:', err));
  }, intervalMs);
}

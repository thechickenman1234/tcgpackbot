import crypto from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { addWholesaleSale } from './moneyService.js';
import { loadPrices, MIN_BOXES, priceLines, REGION_NAMES } from './wholesalePrices.js';

/**
 * Wholesale orders, from the price page's Send order, an Instagram DM or
 * /wholesale new, start to paid:
 *
 *   new      priced from today's supplier sheet with the volume tiers
 *   asked    the supplier has been asked for shipping; their reply is read
 *            for a figure, which Lachy checks before it's used
 *   quoted   boxes + shipping + PayID sent to the shop (or its quote page
 *            link, for a shop that wanted to hear back off Instagram)
 *   paid     each line recorded as a wholesale sale, so profit counts it
 *
 * Shipping is charged at what the supplier quotes, so it's passed through:
 * the sales recorded are the boxes only, at the supplier's cost.
 */

const now = () => new Date().toISOString();
export const orderCode = (o) => `W-${1000 + o.id}`;
const dollars = (n) => `$${Math.round(n).toLocaleString('en-AU')}`;

function parse(row) {
  if (!row) return null;
  return {
    ...row,
    lines: JSON.parse(row.lines || '[]'),
    unmatched: JSON.parse(row.unmatched || '[]'),
    sale_order_ids: JSON.parse(row.sale_order_ids || '[]'),
  };
}

export function getWholesaleOrder(id) {
  return parse(getDb().prepare('SELECT * FROM wholesale_orders WHERE id = ?').get(Number(id)));
}

export function openWholesaleOrders() {
  return getDb().prepare("SELECT * FROM wholesale_orders WHERE status NOT IN ('paid', 'cancelled') ORDER BY created_at")
    .all().map(parse);
}

function update(id, fields) {
  const cols = Object.keys(fields);
  getDb().prepare(`UPDATE wholesale_orders SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map((c) => fields[c]), Number(id));
  return getWholesaleOrder(id);
}

/**
 * Prices the lines at today's sheet and stores the order. Every order gets
 * a quote page (/q/<token>), which is how a shop on WhatsApp or email sees it.
 */
export async function createWholesaleOrder({
  conversationId = null, username = null, name = null, lines, unmatched = [], sourceText = null,
  business = null, contactMethod = null, contactValue = null, notes = null, source = 'instagram',
}) {
  const priced = priceLines(lines, await loadPrices());
  const clip = (s, n) => (s == null || s === '' ? null : String(s).trim().slice(0, n));
  const result = getDb().prepare(`
    INSERT INTO wholesale_orders (conversation_id, customer_username, customer_name, business, contact_method, contact_value,
      notes, source, quote_token, lines, unmatched, boxes_cents, source_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(conversationId, username ? String(username).replace(/^@/, '') : null, clip(name, 80), clip(business, 80),
    clip(contactMethod, 20), clip(contactValue, 120), clip(notes, 1000), source, crypto.randomBytes(12).toString('hex'),
    JSON.stringify(priced.lines), JSON.stringify(unmatched), Math.round(priced.total * 100), clip(sourceText, 2000), now());
  return getWholesaleOrder(result.lastInsertRowid);
}

export function getOrderByToken(token) {
  if (!/^[0-9a-f]{24}$/.test(String(token || ''))) return null;
  return parse(getDb().prepare('SELECT * FROM wholesale_orders WHERE quote_token = ?').get(token));
}

export const quoteUrl = (order) => `${config.quoteBaseUrl}/q/${order.quote_token}`;

/**
 * The same order sent twice within ten minutes (a double tap on Send order,
 * or a page that timed out and was tried again) is the first one again.
 */
export function findRecentDuplicate({ contactValue, lines }) {
  const since = new Date(Date.now() - 10 * 60000).toISOString();
  const key = (ls) => JSON.stringify(ls.map((l) => [l.region, l.name, l.spec, l.qty]).sort());
  const want = key(lines);
  return getDb().prepare(`
    SELECT * FROM wholesale_orders WHERE source = 'website' AND contact_value = ? AND created_at >= ? ORDER BY id DESC
  `).all(String(contactValue || '').trim().slice(0, 120), since).map(parse).find((o) => key(o.lines) === want) || null;
}

/** Everything priced, nothing unmatched, every country over the minimum: ready to ask about. */
export function isComplete(order) {
  const s = summarise(order);
  return order.lines.length > 0 && !order.unmatched.length && !s.unpriced.length && !s.short.length;
}

/** One line to paste into WhatsApp, Messenger or an email: the page has the rest. */
export function quoteLinkMessage(order) {
  return `Hi${order.customer_name ? ` ${order.customer_name}` : ''}! Your quote for ${orderCode(order)} is ready, with shipping, the total and how to pay: ${quoteUrl(order)}`;
}

export const PRICE_LIST_URL = 'https://tcgpackbot.com/wholesale-pricing';

const firstName = (name) => (name ? String(name).trim().split(/\s+/)[0] : '');

/**
 * What to send anyone asking about wholesale: how to order, the link, and
 * where to message Lachie (he answers messages faster than the Outlook inbox).
 */
export function instructionsMessage(name = null) {
  const first = firstName(name);
  return [
    `Hi${first ? ` ${first}` : ''}! Thanks for reaching out. Here's how to order wholesale:`,
    `1. Open our live price list: ${PRICE_LIST_URL}`,
    '2. Add the boxes you want (minimum 5 per country). Price per box drops at 10 and 20 boxes.',
    '3. Tap Send order and leave your details.',
    '4. We\'ll come back with shipping and your total, usually the same day. Pay by PayID and we order it straight in.',
    'Questions? Message me on WhatsApp +61 423 596 688, on Instagram @tcgpackbot, or add me on Discord (lachiedscord) and DM me.',
    'Cheers, Lachie, TCG Pack Bot',
  ].join('\n');
}

/**
 * The follow-up for a website enquiry. Their thank-you screen already showed
 * the steps, so this is a short personal note from Lachie with the link.
 */
export function followUpMessage(name = null) {
  const first = firstName(name);
  return [
    `Hi${first ? ` ${first}` : ''}, it's Lachie from TCG Pack Bot. Got your wholesale enquiry, thanks!`,
    `Our live prices are here: ${PRICE_LIST_URL}`,
    'Add what you want and tap Send order, or just tell me what you\'re after and I\'ll quote you.',
    'You can reach me on WhatsApp +61 423 596 688, Instagram @tcgpackbot or Discord (lachiedscord).',
  ].join('\n');
}

/** New lines (from Edit boxes), priced again as a whole: the tier can change. */
export async function setLines(id, lines, unmatched = []) {
  const priced = priceLines(lines, await loadPrices());
  return update(id, { lines: JSON.stringify(priced.lines), unmatched: JSON.stringify(unmatched), boxes_cents: Math.round(priced.total * 100) });
}

/** The order as the card and the quote show it: per-country tiers and the minimum. */
export function summarise(order) {
  const by = (region) => order.lines.filter((l) => l.region === region);
  const region = (r) => {
    const ls = by(r);
    const boxes = ls.filter((l) => l.price != null).reduce((t, l) => t + l.qty, 0);
    const tiers = { jp: [[20, '20+ boxes'], [10, '10–19 boxes'], [1, '1–9 boxes']], cn: [[20, '20+ boxes'], [10, '10–19 boxes'], [1, '1–9 boxes']] };
    return { lines: ls, boxes, sub: ls.reduce((t, l) => t + (l.total || 0), 0), tierLabel: (tiers[r].find(([n]) => boxes >= n) || [0, ''])[1] };
  };
  const jp = region('jp');
  const cn = region('cn');
  const boxes = order.boxes_cents / 100;
  const shipping = order.shipping_cents == null ? null : order.shipping_cents / 100;
  return {
    jp,
    cn,
    boxes,
    shipping,
    total: shipping == null ? null : boxes + shipping,
    unpriced: order.lines.filter((l) => l.price == null).map((l) => l.name),
    short: ['jp', 'cn'].filter((r) => ({ jp, cn })[r].boxes > 0 && ({ jp, cn })[r].boxes < MIN_BOXES),
  };
}

const lineText = (l, withPrice) => `${l.qty}x ${l.name}${l.spec && l.spec !== 'Sealed box' ? ` (${l.spec})` : ''}`
  + (withPrice && l.price != null ? ` @ ${dollars(l.price)} = ${dollars(l.total)}` : '');

function regionBlocks(order, withPrice) {
  const s = summarise(order);
  const out = [];
  for (const r of ['jp', 'cn']) {
    if (!s[r].lines.length) continue;
    out.push(withPrice ? `${REGION_NAMES[r]} (${s[r].boxes} boxes, ${s[r].tierLabel} pricing)` : `${REGION_NAMES[r]}:`);
    out.push(...s[r].lines.filter((l) => !withPrice || l.price != null).map((l) => lineText(l, withPrice)));
    out.push('');
  }
  return out;
}

/** What the shop gets. No em dashes, plain enough to read on a phone. */
export function quoteText(order) {
  const s = summarise(order);
  // The whole name: wholesale customers are mostly shops ("hq collectables").
  const name = String(order.customer_name || '').trim();
  const code = orderCode(order);
  return [
    `Hi${name ? ` ${name}` : ''}! Here's your order, ${code}:`,
    '',
    ...regionBlocks(order, true),
    `Boxes: ${dollars(s.boxes)}`,
    `Shipping: ${s.shipping == null ? 'to be quoted' : dollars(s.shipping)}`,
    s.total == null ? null : `Total: ${dollars(s.total)} AUD`,
    '',
    `Pay by PayID to ${config.payId} with ${code} as the reference.`,
    'Once it\'s paid we order it straight in, and we\'ll send tracking when it\'s on its way.',
    order.quote_token ? `Your order any time: ${quoteUrl(order)}` : null,
  ].filter((l) => l !== null).join('\n');
}

/** What the supplier gets when asked for shipping. */
export function supplierAskText(order) {
  return [
    `Hi! Could you quote shipping for this order to Melbourne please? (${orderCode(order)})`,
    '',
    ...regionBlocks(order, false),
    'Thank you!',
  ].join('\n');
}

/** What the supplier gets once the shop has paid. */
export function supplierOrderText(order) {
  return [
    `Hi! Confirming this order please, with the shipping you quoted (${orderCode(order)}):`,
    '',
    ...regionBlocks(order, false),
    'Please send the total to pay. Thank you!',
  ].join('\n');
}

/**
 * A shipping figure from the supplier's reply, in AUD cents. Yuan and yen are
 * converted at CNY_PER_AUD and JPY_PER_AUD; a bare $ is read as AUD. Only a
 * guess: Lachy checks it before the quote goes out.
 */
export function parseShipping(text) {
  const t = String(text || '');
  const num = (s) => Number(String(s).replace(/,/g, ''));
  const tries = [
    [/(?:A\$|AU\$|AUD\s*\$?)\s*([\d,]+(?:\.\d+)?)/i, 'AUD', 1],
    [/([\d,]+(?:\.\d+)?)\s*(?:aud|australian)/i, 'AUD', 1],
    [/(?:¥|￥|rmb|cny)\s*([\d,]+(?:\.\d+)?)/i, 'CNY', config.cnyPerAud],
    [/([\d,]+(?:\.\d+)?)\s*(?:rmb|cny|yuan|元|块)/i, 'CNY', config.cnyPerAud],
    [/([\d,]+(?:\.\d+)?)\s*(?:jpy|yen|円)/i, 'JPY', config.jpyPerAud],
    [/\$\s*([\d,]+(?:\.\d+)?)/, '$', 1],
    [/(?:shipping|freight|postage|delivery|ship|运费|邮费|快递费?)\D{0,25}([\d,]+(?:\.\d+)?)/i, '?', 1],
  ];
  for (const [re, currency, rate] of tries) {
    const m = t.match(re);
    if (!m || !(num(m[1]) > 0)) continue;
    return { cents: Math.round((num(m[1]) / rate) * 100), currency, amount: num(m[1]) };
  }
  return null;
}

export function setCardLocation(id, channelId, messageId) {
  return update(id, { card_channel_id: channelId, card_message_id: messageId });
}

/** Asked the supplier. A quote already sent stays sent: asking again only refreshes the shipping. */
export function markAsked(id) {
  const order = getWholesaleOrder(id);
  return update(id, { status: order?.status === 'new' ? 'asked' : order?.status, asked_at: now(), last_error: null });
}

/**
 * A DM from the supplier. The ask carries the order number (W-1001), so a
 * reply that repeats it goes to that order; any other reply goes to the
 * order asked about most recently that has no shipping yet. Returns that
 * order with the reply and a guess.
 */
export function recordSupplierReply(text) {
  const db = getDb();
  const code = String(text || '').match(/\bW-?\s?(\d{4,})\b/i);
  const named = code ? db.prepare("SELECT * FROM wholesale_orders WHERE id = ? AND status IN ('new', 'asked', 'quoted')")
    .get(Number(code[1]) - 1000) : null;
  const row = named || db.prepare(`
    SELECT * FROM wholesale_orders WHERE status = 'asked' AND shipping_cents IS NULL
    ORDER BY asked_at DESC LIMIT 1
  `).get();
  if (!row) return null;
  const guess = parseShipping(text);
  const replies = [row.supplier_reply, String(text || '').slice(0, 500)].filter(Boolean).join('\n').slice(-1000);
  return { order: update(row.id, { supplier_reply: replies, shipping_guess_cents: guess?.cents ?? row.shipping_guess_cents }), guess };
}

export function setShipping(id, cents) {
  return update(id, { shipping_cents: Math.round(cents) });
}

export function markQuoted(id) {
  return update(id, { status: 'quoted', quoted_at: now(), last_error: null });
}

export function noteError(id, error) {
  return update(id, { last_error: String(error).slice(0, 300) });
}

export function markSupplierOrdered(id) {
  return update(id, { supplier_ordered_at: now() });
}

export function cancelWholesaleOrder(id) {
  return update(id, { status: 'cancelled' });
}

/**
 * Paid: each line becomes a paid wholesale sale at the supplier's cost, so
 * the dashboard and /profit count it. They're kept off the labels list
 * (exported_at set) because the stock hasn't been ordered in yet.
 */
export function markWholesalePaid(id) {
  const order = getWholesaleOrder(id);
  if (!order) return { error: 'That order is gone.' };
  if (order.status === 'paid') return { error: `${orderCode(order)} is already paid.` };
  if (order.status === 'cancelled') return { error: `${orderCode(order)} was cancelled.` };
  const customer = order.customer_name || order.business || (order.customer_username ? `@${order.customer_username}` : 'Wholesale');
  const db = getDb();
  // All the lines or none: a sale half-recorded would be recorded twice on the next tap.
  const record = db.transaction(() => {
    const ids = [];
    for (const l of order.lines.filter((x) => x.price != null)) {
      const r = addWholesaleSale({ customer, productName: l.name, quantity: l.qty, totalCents: Math.round(l.total * 100), sent: false });
      if (r.error) throw new Error(`${l.name}: ${r.error}`);
      db.prepare(`
        UPDATE orders SET exported_at = ?, label_reference = ?, unit_cost_cents = COALESCE(?, unit_cost_cents), unit_cost_actual = 0
        WHERE id = ?
      `).run(now(), `${orderCode(order)}: waiting on stock`, l.cost != null ? Math.round(l.cost * 100) : null, r.order.id);
      ids.push(r.order.id);
    }
    return update(id, { status: 'paid', paid_at: now(), sale_order_ids: JSON.stringify(ids) });
  });
  try {
    return { ok: true, order: record() };
  } catch (err) {
    return { error: `Nothing was recorded: ${err.message}` };
  }
}

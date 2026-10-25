import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { getMeta, setMeta } from './metaService.js';
import { logManualOrder } from './manualOrderService.js';
import { getOrderById } from './orderService.js';
import { createProduct, findProductByName, getProductById, setProductActive } from './productService.js';
import { parcelsForOrder } from './labelParcels.js';
import { markPosted } from './shippingService.js';
import { pushToSheetInBackground } from './sheetService.js';
import { logToStaff } from './staffLog.js';
import { ebayAccount, ebayApi, ebayBuyerId, forgetWaitingUsers, hasExtras } from './ebayService.js';
import { ebaySettings, getListing, putBack, takeSold } from './ebayListings.js';

/**
 * eBay orders, posted with his own labels like every other order.
 *
 * Every few minutes the bot reads eBay's orders. A new paid one becomes an
 * ordinary paid order (source 'ebay', one per line item) with the buyer's
 * eBay address, so it sits on the dashboard's Shipping list, prints on the
 * same Label Pro sheet and has its tracking read the same way. When its
 * parcel is ticked as shipped with tracking, the code goes back to eBay:
 * that's what marks it shipped there and keeps the seller rating up.
 *
 * Cancelled on eBay before it's posted: the order is cancelled here and the
 * box goes back on the eBay shelf. Marked shipped in eBay instead: it's
 * ticked off here too.
 *
 * Once it's had time to arrive, the buyer gets one thank-you through eBay
 * messages (the text is on the dashboard). Only orders placed after eBay
 * was connected: nobody from before hears from us out of the blue.
 */

const DAY = 86400000;
const HOUR = 3600000;
const STATE_KEY = 'ebay_orders_state';
const FIRST_LOOK_DAYS = 14;
const THANKS_PER_RUN = 10;

const AU_STATES = {
  victoria: 'VIC', 'new south wales': 'NSW', queensland: 'QLD', 'western australia': 'WA',
  'south australia': 'SA', tasmania: 'TAS', 'australian capital territory': 'ACT', 'northern territory': 'NT',
};
export function auState(value) {
  const v = String(value || '').trim();
  if (/^(VIC|NSW|QLD|WA|SA|TAS|ACT|NT)$/i.test(v)) return v.toUpperCase();
  return AU_STATES[v.toLowerCase()] || v.toUpperCase().slice(0, 3) || null;
}

const toCents = (v) => (v === undefined || v === null || v === '' ? 0 : Math.round(Number(v) * 100));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function loadState() {
  try {
    return JSON.parse(getMeta(STATE_KEY) || '{}');
  } catch {
    return {};
  }
}

export const getEbayOrder = (orderId) => getDb().prepare('SELECT * FROM ebay_orders WHERE order_id = ?').get(orderId);
const linesOf = (row) => {
  try {
    return JSON.parse(row.lines || '[]');
  } catch {
    return [];
  }
};
const saveLines = (orderId, lines) => getDb().prepare('UPDATE ebay_orders SET lines = ? WHERE order_id = ?').run(JSON.stringify(lines), orderId);

/** A listing nobody has linked yet still needs a product for its label: a hidden one named after it. */
function standInProduct(lineItem) {
  const name = `ebay ${lineItem.legacyItemId || lineItem.lineItemId}`;
  let product = findProductByName(name);
  if (!product) {
    product = createProduct({ name, priceCents: toCents(lineItem.lineItemCost?.value) || 0, quantity: 0 });
    setProductActive(product.id, false);
    getDb().prepare('UPDATE products SET display_name = ? WHERE id = ?').run(String(lineItem.title || name).slice(0, 120), product.id);
    product = getProductById(product.id);
  }
  return product;
}

async function tellStaff(client, embed) {
  if (!client) return;
  try {
    await logToStaff(client, embed);
  } catch (err) {
    console.error('eBay: could not post to the staff log:', err.message);
  }
}

/** Turns one new paid eBay order into bot orders. Returns the ebay_orders row. */
function importOrder(o, now) {
  const db = getDb();
  const step = o.fulfillmentStartInstructions?.[0] || {};
  const ship = step.shippingStep || {};
  const to = ship.shipTo || {};
  const addr = to.contactAddress || {};
  const username = o.buyer?.username || null;
  const street = [addr.addressLine1, addr.addressLine2].filter(Boolean).join(', ');
  const express = /express/i.test(ship.shippingServiceCode || '');
  const items = o.lineItems || [];
  const totals = items.map((li) => toCents(li.total?.value) || toCents(li.lineItemCost?.value));
  const sum = totals.reduce((a, b) => a + b, 0);
  const fee = toCents(o.totalMarketplaceFee?.value);
  const when = o.creationDate || now.toISOString();
  const lines = [];
  let feeLeft = fee;
  items.forEach((li, i) => {
    const listing = li.legacyItemId ? getListing(li.legacyItemId) : null;
    const product = listing?.product_id ? getProductById(listing.product_id) : standInProduct(li);
    const r = logManualOrder({
      product,
      quantity: Number(li.quantity) || 1,
      totalCents: totals[i],
      shippingCents: 0,
      shippingMethod: express ? 'express' : 'standard',
      source: 'ebay',
      discordId: ebayBuyerId(username),
      name: to.fullName || username,
      phone: to.primaryPhone?.phoneNumber || null,
      address: street || null,
      city: addr.city || null,
      state: auState(addr.stateOrProvince),
      zip: addr.postalCode || null,
    });
    if (!r.ok) throw new Error(`Couldn't add eBay order ${o.orderId}: ${r.reason}`);
    const share = i === items.length - 1 ? feeLeft : Math.round(fee * (sum ? totals[i] / sum : 1 / items.length));
    feeLeft -= share;
    // Dated when it was bought on eBay, so profit lands on the right day.
    db.prepare('UPDATE orders SET fee_cents = ?, ebay_order_id = ?, claimed_at = ?, paid_at = ? WHERE id = ?')
      .run(share, o.orderId, when, when, r.order.id);
    takeSold(li.legacyItemId, Number(li.quantity) || 1);
    lines.push({
      lineItemId: li.lineItemId,
      itemId: li.legacyItemId || null,
      qty: Number(li.quantity) || 1,
      orderId: r.order.id,
      title: String(li.title || '').slice(0, 120),
      linked: Boolean(listing?.product_id),
      pushed: [],
    });
  });
  const shipBy = items.map((li) => li.lineItemFulfillmentInstructions?.shipByDate).filter(Boolean).sort()[0] || null;
  const deliverBy = step.maxEstimatedDeliveryDate || items.map((li) => li.lineItemFulfillmentInstructions?.maxEstimatedDeliveryDate).filter(Boolean).sort().pop() || null;
  const overseas = addr.countryCode && addr.countryCode !== 'AU' ? `Overseas order to ${addr.countryCode}: make this label by hand.` : null;
  db.prepare(`
    INSERT INTO ebay_orders (order_id, buyer, lines, total_cents, fee_cents, created_at, ship_by, deliver_by, status, cancel_state, imported, last_error, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(o.orderId, username, JSON.stringify(lines), toCents(o.pricingSummary?.total?.value) || sum, fee, when, shipBy, deliverBy,
    o.orderFulfillmentStatus || null, o.cancelStatus?.cancelState || null, overseas, now.toISOString());
  const orders = lines.map((l) => getOrderById(l.orderId));
  pushToSheetInBackground(orders, 'ebay');
  return { row: getEbayOrder(o.orderId), orders };
}

/** An order from before the bot knew about it (or not paid yet), noted so it's never imported later. */
function noteOnly(o, now, { shipped }) {
  getDb().prepare(`
    INSERT INTO ebay_orders (order_id, buyer, lines, total_cents, fee_cents, created_at, status, cancel_state, imported, shipped_at, synced_at)
    VALUES (?, ?, '[]', ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(o.orderId, o.buyer?.username || null, toCents(o.pricingSummary?.total?.value), toCents(o.totalMarketplaceFee?.value),
    o.creationDate || now.toISOString(), o.orderFulfillmentStatus || null, o.cancelStatus?.cancelState || null,
    shipped ? (o.lastModifiedDate || now.toISOString()) : null, now.toISOString());
}

/** Cancelled on eBay: whatever isn't posted yet is cancelled here and goes back on the shelf. */
function cancelHere(row) {
  const db = getDb();
  const stopped = [];
  for (const line of linesOf(row)) {
    const order = line.orderId ? getOrderById(line.orderId) : null;
    if (!order || order.status !== 'paid') continue;
    db.prepare("UPDATE orders SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'Cancelled on eBay' WHERE id = ? AND status = 'paid'")
      .run(new Date().toISOString(), order.id);
    putBack(line.itemId, line.qty);
    stopped.push(getOrderById(order.id));
  }
  if (stopped.length) pushToSheetInBackground(stopped, 'ebay-cancel');
  return stopped;
}

const buyerName = (order) => getDb().prepare('SELECT name FROM buyers WHERE discord_id = ?').get(order.buyer_id)?.name || 'eBay buyer';
const shipByText = (iso) => (iso ? new Date(iso).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null);

/**
 * Reads orders changed since the last look (the first look goes back two
 * weeks): new paid ones in, cancellations and buyer cancel requests out,
 * and anything marked shipped in eBay ticked off here.
 */
export async function syncOrders(client, { now = new Date() } = {}) {
  const state = loadState();
  const since = state.syncedAt
    ? new Date(Date.parse(state.syncedAt) - 2 * HOUR)
    : new Date(now.getTime() - FIRST_LOOK_DAYS * DAY);
  const out = { added: [], cancelled: [], requests: [], shippedThere: [] };
  for (let offset = 0; offset < 2000; offset += 50) {
    const page = await ebayApi('GET', '/sell/fulfillment/v1/order', {
      query: { filter: `lastmodifieddate:[${since.toISOString()}..]`, limit: 50, offset },
    });
    for (const o of page.orders || []) {
      const row = getEbayOrder(o.orderId);
      const cancel = o.cancelStatus?.cancelState || null;
      const gone = cancel === 'CANCELED' || o.orderPaymentStatus === 'FULLY_REFUNDED';
      if (!row) {
        if (gone) continue;
        if (o.orderPaymentStatus !== 'PAID' && o.orderPaymentStatus !== 'PARTIALLY_REFUNDED') continue;
        if (o.orderFulfillmentStatus === 'FULFILLED') {
          noteOnly(o, now, { shipped: true });
          continue;
        }
        const r = importOrder(o, now);
        out.added.push(r);
        continue;
      }
      getDb().prepare('UPDATE ebay_orders SET status = ?, cancel_state = ?, synced_at = ? WHERE order_id = ?')
        .run(o.orderFulfillmentStatus || row.status, cancel, now.toISOString(), o.orderId);
      if (!row.imported) continue;
      if (gone && row.cancel_state !== 'CANCELED') {
        getDb().prepare("UPDATE ebay_orders SET cancel_state = 'CANCELED' WHERE order_id = ?").run(o.orderId);
        const stopped = cancelHere(row);
        if (stopped.length) out.cancelled.push({ row, stopped });
      } else if (cancel === 'IN_PROGRESS' && !row.alerted_at) {
        getDb().prepare('UPDATE ebay_orders SET alerted_at = ? WHERE order_id = ?').run(now.toISOString(), o.orderId);
        out.requests.push(row);
      }
      if (o.orderFulfillmentStatus === 'FULFILLED' && !row.shipped_at) {
        // Marked shipped in eBay itself: tick it off the Shipping list too.
        const open = linesOf(row).map((l) => getOrderById(l.orderId)).filter((x) => x && x.status === 'paid');
        const posted = markPosted(open.map((x) => x.id));
        if (posted.length) {
          pushToSheetInBackground(posted, 'posted');
          out.shippedThere.push(row);
        }
        const lines = linesOf(row).map((l) => ({ ...l, inEbay: true }));
        saveLines(row.order_id, lines);
        getDb().prepare('UPDATE ebay_orders SET shipped_at = ? WHERE order_id = ?').run(now.toISOString(), row.order_id);
      }
    }
    if (!page.next || (page.orders || []).length < 50) break;
  }
  setMeta(STATE_KEY, JSON.stringify({ ...state, syncedAt: now.toISOString() }));
  forgetWaitingUsers();

  for (const { row, orders } of out.added) {
    const o = orders[0];
    const unlinked = linesOf(row).some((l) => !l.linked);
    await tellStaff(client, {
      title: '🛒 New eBay order',
      description: [
        `**${orders.map((x) => `${x.quantity}x ${x.product_name}`).join(', ')}** for ${buyerName(o)}${row.buyer ? ` (${row.buyer})` : ''}, ${(row.total_cents / 100).toFixed(2)} dollars.`,
        `It's on the dashboard's Shipping list${row.ship_by ? `. Post by **${shipByText(row.ship_by)}**` : ''}.`,
        unlinked ? 'This listing isn\'t linked to a product yet: link it in the eBay section so stock and profit count it.' : null,
        row.last_error,
      ].filter(Boolean).join('\n'),
      color: 0x2f6f4f,
    });
  }
  for (const { row, stopped } of out.cancelled) {
    await tellStaff(client, {
      title: '↩️ eBay order cancelled',
      description: `${stopped.map((x) => `${x.quantity}x ${x.product_name} (${x.reference_code})`).join(', ')} for ${row.buyer || 'a buyer'} was cancelled on eBay. **Don't post it.** It's off the Shipping list and back on the eBay shelf.`,
      color: 0xa15c00,
    });
  }
  for (const row of out.requests) {
    await tellStaff(client, {
      title: '✋ eBay buyer wants to cancel',
      description: `${row.buyer || 'A buyer'} asked to cancel eBay order ${row.order_id}. **Hold that parcel** and accept or decline in eBay (Seller Hub, Orders) first.`,
      color: 0xa15c00,
    });
  }
  return out;
}

// ---------------------------------------------------------------- tracking back to eBay

const already = (msg) => /already|fulfilled|shipped/i.test(String(msg));

/**
 * Sends the tracking of every eBay parcel ticked as shipped. A parcel ticked
 * without a code waits (the dashboard asks for it): eBay's rating counts
 * tracking, so it isn't marked shipped there without one.
 */
export async function syncFulfilments({ now = new Date() } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM ebay_orders WHERE imported = 1 AND shipped_at IS NULL AND (cancel_state IS NULL OR cancel_state != 'CANCELED')
  `).all();
  const out = { sent: 0, waiting: [], failed: [] };
  for (const row of rows) {
    const lines = linesOf(row);
    let changed = false;
    for (const line of lines) {
      const order = line.orderId ? getOrderById(line.orderId) : null;
      if (!order || !['shipped', 'archived'].includes(order.status)) continue;
      const parcels = parcelsForOrder(order.id);
      const codes = parcels.length
        ? parcels.map((p) => ({ code: p.tracking_code, qty: Math.min(p.quantity, line.qty), at: p.posted_at }))
        : order.tracking_code ? [{ code: order.tracking_code, qty: line.qty, at: order.shipped_at }] : [];
      if (!codes.length) {
        if (!line.noTracking) {
          line.noTracking = true;
          changed = true;
        }
        out.waiting.push(order);
        continue;
      }
      if (line.noTracking) {
        line.noTracking = false;
        changed = true;
      }
      for (const c of codes) {
        if (line.pushed.includes(c.code)) continue;
        try {
          await ebayApi('POST', `/sell/fulfillment/v1/order/${encodeURIComponent(row.order_id)}/shipping_fulfillment`, {
            body: {
              lineItems: [{ lineItemId: line.lineItemId, quantity: c.qty }],
              shippedDate: new Date(c.at || now).toISOString(),
              shippingCarrierCode: config.ebayCarrier,
              trackingNumber: c.code,
            },
          });
          line.pushed.push(c.code);
          line.error = null;
          out.sent += 1;
        } catch (err) {
          if (already(err.message)) line.pushed.push(c.code);
          else {
            line.error = String(err.message).slice(0, 200);
            out.failed.push(`${row.order_id}: ${err.message}`);
          }
        }
        changed = true;
      }
    }
    if (changed) saveLines(row.order_id, lines);
    const done = lines.length && lines.every((l) => l.inEbay || l.pushed.length > 0);
    if (done) db.prepare('UPDATE ebay_orders SET shipped_at = ?, last_error = NULL WHERE order_id = ?').run(now.toISOString(), row.order_id);
    else {
      const err = lines.map((l) => l.error).find(Boolean) || null;
      if (err !== row.last_error && !String(row.last_error || '').startsWith('Overseas')) db.prepare('UPDATE ebay_orders SET last_error = ? WHERE order_id = ?').run(err, row.order_id);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the thank-you

function firstName(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  return /^[A-Za-z][A-Za-z'-]{1,20}$/.test(first) ? first[0].toUpperCase() + first.slice(1).toLowerCase() : 'there';
}

export function thankYouText(row, settings = ebaySettings()) {
  const line = linesOf(row)[0];
  const order = line?.orderId ? getOrderById(line.orderId) : null;
  const product = order ? getProductById(order.product_id) : null;
  const item = (product?.display_name || line?.title || 'order').replace(/\s+/g, ' ').trim().slice(0, 70);
  const name = order ? firstName(buyerName(order)) : 'there';
  return settings.thankText.replace(/\{name\}/g, name).replace(/\{item\}/g, item).slice(0, 2000);
}

/**
 * The one thank-you per order, a day after eBay's latest delivery estimate
 * (or 4 days after posting when there's none). Only orders placed since
 * eBay was connected, three tries at most.
 */
export async function sendThanks({ now = new Date() } = {}) {
  const settings = ebaySettings();
  const account = ebayAccount();
  if (!settings.thankYou || !account?.connectedAt || !hasExtras()) return { sent: 0 };
  const rows = getDb().prepare(`
    SELECT * FROM ebay_orders WHERE imported = 1 AND shipped_at IS NOT NULL AND thanked_at IS NULL AND thank_tries < 3
      AND buyer IS NOT NULL AND created_at >= ? AND (cancel_state IS NULL OR cancel_state != 'CANCELED')
    ORDER BY shipped_at LIMIT 50
  `).all(account.connectedAt);
  const out = { sent: 0, failed: [] };
  for (const row of rows) {
    if (out.sent >= THANKS_PER_RUN) break;
    const due = row.deliver_by ? Date.parse(row.deliver_by) + DAY : Date.parse(row.shipped_at) + 4 * DAY;
    if (!Number.isFinite(due) || now.getTime() < due) continue;
    const line = linesOf(row)[0];
    try {
      await ebayApi('POST', '/commerce/message/v1/send_message', {
        body: {
          otherPartyUsername: row.buyer,
          messageText: thankYouText(row, settings),
          ...(line?.itemId ? { reference: { referenceType: 'LISTING', referenceId: String(line.itemId) } } : {}),
        },
      });
      getDb().prepare('UPDATE ebay_orders SET thanked_at = ? WHERE order_id = ?').run(now.toISOString(), row.order_id);
      out.sent += 1;
    } catch (err) {
      getDb().prepare('UPDATE ebay_orders SET thank_tries = thank_tries + 1, last_error = ? WHERE order_id = ?')
        .run(`Thank-you not sent: ${String(err.message).slice(0, 160)}`, row.order_id);
      out.failed.push(`${row.order_id}: ${err.message}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- for the dashboard and the brief

/** Recent eBay orders and what each still needs. */
export function ordersView({ now = new Date(), days = 21 } = {}) {
  const rows = getDb().prepare(`
    SELECT * FROM ebay_orders WHERE imported = 1 AND created_at >= ? ORDER BY created_at DESC LIMIT 60
  `).all(new Date(now.getTime() - days * DAY).toISOString());
  const list = rows.map((row) => {
    const lines = linesOf(row);
    const orders = lines.map((l) => (l.orderId ? getOrderById(l.orderId) : null)).filter(Boolean);
    const posted = orders.length && orders.every((x) => ['shipped', 'archived'].includes(x.status));
    let stage = 'to-post';
    if (row.cancel_state === 'CANCELED') stage = 'cancelled';
    else if (row.thanked_at) stage = 'thanked';
    else if (row.shipped_at) stage = 'on-ebay';
    else if (lines.some((l) => l.noTracking)) stage = 'no-tracking';
    else if (posted) stage = 'sending';
    const named = (x) => getProductById(x.product_id)?.display_name || x.product_name;
    return {
      id: row.order_id,
      buyer: row.buyer,
      name: orders[0] ? buyerName(orders[0]) : row.buyer,
      what: orders.map((x) => `${x.quantity}x ${named(x)}`).join(', ') || lines.map((l) => `${l.qty}x ${l.title}`).join(', '),
      total: row.total_cents,
      fee: row.fee_cents,
      createdAt: row.created_at,
      shipBy: row.ship_by,
      late: !posted && row.ship_by && now.getTime() > Date.parse(row.ship_by),
      cancelRequest: row.cancel_state === 'IN_PROGRESS',
      unlinked: lines.some((l) => !l.linked),
      stage,
      error: row.last_error,
      refs: orders.map((x) => x.reference_code),
    };
  });
  return {
    list,
    toPost: list.filter((o) => o.stage === 'to-post').length,
    late: list.filter((o) => o.late && o.stage === 'to-post').length,
    dueToday: list.filter((o) => o.stage === 'to-post' && o.shipBy && Date.parse(o.shipBy) - now.getTime() < DAY).length,
    noTracking: list.filter((o) => o.stage === 'no-tracking'),
    cancelRequests: list.filter((o) => o.cancelRequest && o.stage !== 'cancelled'),
    errors: list.filter((o) => o.error && o.stage !== 'cancelled'),
  };
}

/** The eBay orders a set of bot orders came from, for the "tracking goes to eBay" line. */
export const ebayOrderCount = (orders) => orders.filter((o) => o.source === 'ebay').length;

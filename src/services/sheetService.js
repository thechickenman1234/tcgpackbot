import { config } from '../config.js';
import { getBuyer } from './buyerService.js';
import { getAllPaidOrders } from './orderService.js';
import { listAllProducts } from './productService.js';

/**
 * Pushes orders into the accounting spreadsheet.
 *
 * Two tabs, two very different behaviours on the Google side:
 *
 *   Sales  - upserted, matched on Order Ref. Partial pushes are fine, so a
 *            single order can be sent the moment it changes state.
 *   Labels - wiped and rewritten on every single call. That means every
 *            push has to carry the COMPLETE paid-and-unshipped list, not
 *            just what changed, or the rest of the labels disappear.
 *
 * The blank Payment and Bank columns are deliberate: Lachy types those in
 * by hand and the script preserves whatever is already in the sheet.
 *
 * Google answers a POST with a 302 pointing at a GET-only URL. fetch follows
 * that the same way `curl -L` does. Do not force the method on the redirect
 * or the request breaks - this is the same trap as `curl -X POST`.
 */

function salesRow(order) {
  const buyer = getBuyer(order.buyer_id);
  return {
    ref: order.reference_code,
    date: (order.paid_at || order.claimed_at || '').slice(0, 10),
    buyer: buyer?.name || '',
    product: order.product_name,
    qty: order.quantity,
    revenue: (order.total_cents / 100).toFixed(2),
    status: order.status,
    tracking: order.tracking_code || '',
  };
}

function labelRow(order) {
  const buyer = getBuyer(order.buyer_id);
  return {
    to_name: buyer?.name || '',
    to_business_name: '',
    to_street: buyer?.shipping_address || '',
    to_street2: '',
    to_city: buyer?.city || '',
    to_state: buyer?.state || '',
    to_postcode: buyer?.zip || '',
    from_name: config.fromName,
    from_business_name: config.fromBusinessName,
    from_street: config.fromStreet,
    from_street2: config.fromStreet2,
    from_city: config.fromCity,
    from_state: config.fromState,
    from_postcode: config.fromPostcode,
    phone: buyer?.phone || '',
    reference: `${order.reference_code} — ${order.quantity}x ${order.product_name}`,
    type: order.shipping_method === 'express' ? 'EXPRESS' : 'STANDARD',
  };
}

export function isSheetConfigured() {
  return Boolean(config.sheetUrl && config.sheetSecret);
}

/**
 * Sends the given orders to the Sales tab and rebuilds Labels from whatever
 * is currently paid and unshipped. Throws if the sheet rejects the push.
 */
export async function pushToSheet(orders) {
  if (!isSheetConfigured()) {
    throw new Error('SHEET_URL and SHEET_SECRET are not set');
  }

  const payload = {
    secret: config.sheetSecret,
    orders: orders.map(salesRow),
    labels: getAllPaidOrders().map(labelRow),
    // The bot's product list is the master spelling. Stock Purchases picks
    // from it, so a purchase and a sale of the same thing finally match.
    products: listAllProducts().map((p) => p.name),
  };

  // Apps Script answers a POST with a 302 to a one-shot result URL. Sending
  // the body as text/plain keeps Google from preflighting it, which is the
  // usual reason a POST quietly arrives as a GET and runs doGet instead.
  const response = await fetch(config.sheetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `Sheet replied with something that wasn't JSON (${response.status}, ended at ${response.url}): ${text.slice(0, 300)}`,
    );
  }
  if (!body.ok) throw new Error(body.error || 'Sheet rejected the push');

  // doGet also answers { ok: true }, so a reply with no counts means the
  // POST was downgraded to a GET and nothing was actually written.
  if (typeof body.salesRows !== 'number') {
    throw new Error(
      `Reached doGet instead of doPost — nothing was written. Ended at ${response.url}. Reply: ${text.slice(0, 200)}`,
    );
  }
  return body;
}

/**
 * Same push, but it never throws and never makes anyone wait. Used on the
 * path a buyer is standing in - Google being slow or down must not stop an
 * order being marked paid.
 */
export function pushToSheetInBackground(orders, context = 'sync') {
  if (!isSheetConfigured() || !orders.length) return;
  pushToSheet(orders).catch((err) => {
    console.error(`Sheet ${context} failed:`, err.message);
  });
}

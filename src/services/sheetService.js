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

/**
 * One label per buyer, not one per order.
 *
 * Somebody who claims twice in the same sale gets two orders but only ever
 * one parcel, and printing both means paying for a label that never gets
 * used. Every order a buyer has waiting goes onto a single label, with the
 * contents listed so packing still knows what belongs in the box.
 *
 * Express wins for the whole parcel: if any order in it was paid as
 * express, the parcel goes express rather than downgrading what someone
 * paid extra for.
 */
function labelRowsByBuyer(orders) {
  const byBuyer = new Map();
  for (const order of orders) {
    const existing = byBuyer.get(order.buyer_id);
    if (existing) existing.push(order);
    else byBuyer.set(order.buyer_id, [order]);
  }

  return [...byBuyer.values()].map((group) => {
    const buyer = getBuyer(group[0].buyer_id);
    const contents = group.map((o) => `${o.quantity}x ${o.product_name}`).join(' + ');
    const reference = group.length === 1
      ? `${group[0].reference_code} — ${contents}`
      : `COMBO ${group.map((o) => o.reference_code).join('+')} — ${contents}`;

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
      reference,
      type: group.some((o) => o.shipping_method === 'express') ? 'EXPRESS' : 'STANDARD',
      // Last column on purpose: the label printer reads the ones it knows
      // by name and ignores the rest. This is here so you can see at a
      // glance which wave a parcel belongs to.
      claimed: (group.map((o) => o.claimed_at).filter(Boolean).sort()[0] || '').slice(0, 10),
    };
  });
}

export function isSheetConfigured() {
  return Boolean(config.sheetUrl && config.sheetSecret);
}

/**
 * Orders per request on a big push.
 *
 * The script reads and writes each Sales row on its own, so a request's run
 * time grows with the number of orders in it. A full /sync of ~300 orders ran
 * past 40 seconds and Google answered with a 404 page instead of the result.
 * Fifty keeps every request to a few seconds, and because Sales is matched on
 * Order Ref, a batch that fails can simply be sent again.
 */
const SALES_BATCH = 50;

/**
 * Every push waits for the one before it.
 *
 * Several /paid in a row used to fire overlapping requests, each one wiping
 * and rewriting the Labels tab while the others were mid-write, and they
 * failed together with the same 404. One at a time costs a few seconds and
 * removes the overlap entirely.
 */
let queue = Promise.resolve();

/**
 * Sends the given orders to the Sales tab and rebuilds Labels from whatever
 * is currently paid and unshipped. Throws if the sheet rejects the push.
 *
 * Big pushes go in batches. Each batch carries the full label and product
 * lists, because the script rebuilds those tabs from whatever each request
 * contains and an empty list would wipe them.
 */
export function pushToSheet(orders) {
  const run = queue.then(() => pushInBatches(orders));
  queue = run.catch(() => {});
  return run;
}

async function pushInBatches(orders) {
  if (!isSheetConfigured()) {
    throw new Error('SHEET_URL and SHEET_SECRET are not set');
  }

  let salesRows = 0;
  let last = null;
  for (let i = 0; i < Math.max(orders.length, 1); i += SALES_BATCH) {
    const batch = orders.slice(i, i + SALES_BATCH);
    try {
      last = await pushOnce(batch);
    } catch (err) {
      // Say how far it got, so a failure halfway is not mistaken for nothing.
      if (i > 0) err.message = `${err.message} (the first ${i} of ${orders.length} orders did sync)`;
      throw err;
    }
    salesRows += last.salesRows;
  }
  return { ...last, salesRows };
}

async function pushOnce(orders) {
  const payload = {
    secret: config.sheetSecret,
    orders: orders.map(salesRow),
    labels: labelRowsByBuyer(getAllPaidOrders()),
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

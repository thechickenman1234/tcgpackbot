import { getDb } from '../db/database.js';
import { findBuyersByName } from './buyerService.js';
import { getOrderByReference, markShipped, setTrackingCode } from './orderService.js';

/**
 * Pasted tracking codes, turned into shipped orders and buyer messages.
 *
 * Shared by /tracking and the Add tracking button so both behave exactly the
 * same. Adding a code also marks the parcel posted, so pasting codes is the
 * whole job after a post office run: there is no separate step to forget.
 */

const DAY = 86400000;

/**
 * Legacy guard for orders printed before label batches existed. Weeks apart
 * is not one parcel, it is an older order that went out and was never marked
 * shipped, and messaging that buyer about a parcel they received last month
 * is the exact mistake this exists to stop.
 */
export const STALE_SPAN_DAYS = 14;

/** Tell the buyer their tracking number in their own ticket. */
export async function postTrackingToThread(client, order) {
  if (!order.thread_id || !order.tracking_code) return false;
  try {
    const thread = await client.channels.fetch(order.thread_id);
    await thread.send(
      `<@${order.buyer_id}> 📦 **${order.quantity}x ${order.product_name}** is on its way.\n`
      + `Tracking: \`${order.tracking_code}\`\n`
      + `Track it at https://auspost.com.au/mypost/track/search?id=${order.tracking_code}`,
    );
    return true;
  } catch (err) {
    console.error(`Failed to post tracking to thread ${order.thread_id}:`, err);
    return false;
  }
}

export function ordersInOneParcel(orders) {
  if (orders.length <= 1) return orders;
  const dates = orders.map((o) => o.claimed_at).filter(Boolean).sort();
  if (dates.length < 2) return orders;
  const spanDays = (new Date(dates[dates.length - 1]) - new Date(dates[0])) / DAY;
  return spanDays > STALE_SPAN_DAYS ? null : orders;
}

/**
 * One line of a paste. A TCG reference anywhere in the line wins, because the
 * label printer often copies the reference column along with the name. The
 * tracking code is the last long run of letters and digits.
 */
export function parseTrackingLine(line) {
  const m = line.match(/^(.*?)[\s:,=]+([A-Za-z0-9-]{8,})\s*$/);
  if (!m) return null;
  // "Ben Broadhurst TCG-08CF31" with no code is not a reference as tracking.
  if (/^TCG-[0-9A-Z]{6}$/i.test(m[2])) return null;
  const ref = m[1].match(/TCG-[0-9A-Z]{6}/i)?.[0]?.toUpperCase() || null;
  return { who: m[1].trim().replace(/[\s:,=—-]+$/, ''), ref, code: m[2].trim() };
}

/** Everything still going in the same box as this order. */
function parcelForOrder(order) {
  if (!order.label_batch_id) return [order];
  return getDb().prepare(`
    SELECT * FROM orders
    WHERE buyer_id = ? AND label_batch_id = ?
      AND (status = 'paid' OR (status = 'shipped' AND tracking_code IS NULL) OR id = ?)
    ORDER BY id
  `).all(order.buyer_id, order.label_batch_id, order.id);
}

/**
 * Which parcel a name means, when someone has more than one thing going on.
 *
 * In order of preference:
 *   1. a printed parcel already marked posted that has no code yet
 *   2. a printed parcel that hasn't been marked posted
 *   3. orders printed before batches existed, with the old date guard
 *
 * Only one candidate at the first level that has any is a match. Two is a
 * real ambiguity and comes back as a question rather than a guess.
 */
function parcelForBuyer(buyerId, now = Date.now()) {
  const recent = new Date(now - 7 * DAY).toISOString();
  const rows = getDb().prepare(`
    SELECT * FROM orders
    WHERE buyer_id = ?
      AND (status = 'paid'
        OR (status = 'shipped' AND tracking_code IS NULL AND label_batch_id IS NOT NULL AND shipped_at >= ?))
    ORDER BY claimed_at ASC, id ASC
  `).all(buyerId, recent);

  const groups = new Map();
  for (const o of rows) {
    const key = o.label_batch_id ?? 'none';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }

  const printed = [...groups.entries()].filter(([k]) => k !== 'none');
  const tiers = [
    printed.filter(([, os]) => os.some((o) => o.status === 'shipped')),
    printed.filter(([, os]) => os.some((o) => o.status === 'paid')),
  ];
  for (const tier of tiers) {
    if (tier.length === 1) return { orders: tier[0][1] };
    if (tier.length > 1) {
      return {
        error: `printed in ${tier.length} batches (${tier.map(([k, os]) => `batch ${k}: ${os.map((o) => `\`${o.reference_code}\``).join(' ')}`).join('; ')}). Paste the reference you mean`,
      };
    }
  }

  const legacy = groups.get('none') || [];
  if (!legacy.length) return { orders: [] };
  const parcel = ordersInOneParcel(legacy);
  if (!parcel) {
    const list = legacy
      .map((o) => `\`${o.reference_code}\`${o.paid_at ? ` (${o.paid_at.slice(0, 10)})` : ''}`)
      .join(', ');
    return {
      error: `${legacy.length} unshipped orders more than ${STALE_SPAN_DAYS} days apart: ${list}. `
        + 'An older one has probably gone out already. Paste the reference you mean, '
        + 'or tick the old ones off with 📦 Mark posted',
    };
  }
  return { orders: parcel };
}

/**
 * Applies a whole paste. Returns what happened so the caller can reply, and
 * the changed orders so the caller can push them to the sheet in one go.
 */
export async function applyTrackingPaste(client, text) {
  const entries = String(text || '')
    .split(/[\n;]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseTrackingLine)
    .filter(Boolean);

  const done = [];
  const failed = [];
  const synced = [];

  for (const { who, ref, code } of entries) {
    let orders;
    if (ref) {
      const order = getOrderByReference(ref);
      if (!order) {
        failed.push(`${who} — no order \`${ref}\``);
        continue;
      }
      orders = parcelForOrder(order);
    } else {
      const buyers = findBuyersByName(who);
      if (buyers.length > 1) {
        failed.push(`${who} — ${buyers.length} buyers share that name, use the order reference`);
        continue;
      }
      if (!buyers.length) {
        failed.push(`${who} — no buyer with that exact name`);
        continue;
      }
      const result = parcelForBuyer(buyers[0].discord_id);
      if (result.error) {
        failed.push(`${who} — ${result.error}`);
        continue;
      }
      orders = result.orders;
    }

    if (!orders.length) {
      failed.push(`${who} — nothing waiting for tracking`);
      continue;
    }

    // One parcel can hold several orders, so they all get the same code.
    for (const order of orders) {
      const updated = order.status === 'paid'
        ? markShipped(order.id, code).order
        : setTrackingCode(order.id, code);
      await postTrackingToThread(client, updated);
      synced.push(updated);
    }
    const what = orders.map((o) => o.reference_code).join(', ');
    done.push(`${who} — ${code}${orders.length > 1 ? ` (${orders.length} orders: ${what})` : ''}`);
  }

  return { done, failed, synced, lines: entries.length };
}

/** The reply both entry points send. */
export function trackingReply({ done, failed, lines }) {
  if (!lines) {
    return 'No tracking codes found. Each line should look like `Ben Broadhurst: 0301018247797006320996`.';
  }
  const out = [
    `📦 Tracking sent for **${done.length}** parcel${done.length === 1 ? '' : 's'}. Those are marked posted too.`,
    ...done.map((d) => `• ${d}`),
  ];
  if (failed.length) out.push('', `⚠️ **${failed.length} skipped:**`, ...failed.map((f) => `• ${f}`));
  return out.join('\n').slice(0, 1900);
}

import { getDb } from '../db/database.js';
import { findBuyersByName } from './buyerService.js';
import { getOrderByReference, markShipped, setTrackingCode } from './orderService.js';
import { parcelKeyer } from './parcelService.js';

/**
 * Pasted tracking codes, turned into shipped orders and buyer messages.
 *
 * Shared by /tracking and the Add tracking button so both behave exactly the
 * same. Adding a code also marks the parcel posted, so pasting codes is the
 * whole job after a post office run: there is no separate step to forget.
 */

const DAY = 86400000;

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

/** Orders that could still take a code: waiting, or posted without one. */
function awaitingCode(buyerId, alsoId = null, now = Date.now()) {
  const recent = new Date(now - 7 * DAY).toISOString();
  return getDb().prepare(`
    SELECT * FROM orders
    WHERE buyer_id = ?
      AND (status = 'paid'
        OR (status = 'shipped' AND tracking_code IS NULL AND label_batch_id IS NOT NULL AND shipped_at >= ?)
        OR id = ?)
    ORDER BY claimed_at ASC, id ASC
  `).all(buyerId, recent, alsoId ?? -1);
}

/** Everything in the same box as this order (one order: see parcelService). */
function parcelForOrder(order) {
  const key = parcelKeyer();
  const mine = key(order);
  return awaitingCode(order.buyer_id, order.id).filter((o) => key(o) === mine);
}

/**
 * Which parcel a name means, when someone has more than one on the go.
 *
 * In order of preference:
 *   1. a printed parcel already marked posted that has no code yet
 *   2. a printed parcel that hasn't been marked posted
 *   3. a parcel never printed with the buttons
 *
 * Only one parcel at the first level that has any is a match. Two is a real
 * question (two orders, two boxes) and comes back as one, never a guess.
 */
function parcelForBuyer(buyerId) {
  const key = parcelKeyer();
  const parcels = new Map();
  for (const o of awaitingCode(buyerId)) {
    const k = key(o);
    if (!parcels.has(k)) parcels.set(k, []);
    parcels.get(k).push(o);
  }
  const all = [...parcels.values()];
  const printed = all.filter((os) => os[0].label_batch_id);
  const tiers = [
    printed.filter((os) => os.some((o) => o.status === 'shipped')),
    printed.filter((os) => os.some((o) => o.status === 'paid')),
    all.filter((os) => !os[0].label_batch_id),
  ];
  for (const tier of tiers) {
    if (tier.length === 1) return { orders: tier[0] };
    if (tier.length > 1) {
      const list = tier.map((os) => os.map((o) => `\`${o.reference_code}\``).join(' + ')).join('; ');
      return { error: `has ${tier.length} separate parcels waiting (${list}). Paste the reference of the one you posted` };
    }
  }
  return { orders: [] };
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

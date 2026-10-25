import { config } from '../config.js';
import { getMeta } from './metaService.js';
import { callbackUrl, deletionUrl, ebayAccount, ebayConnected, ebayKeys, hasExtras } from './ebayService.js';
import { ebaySettings, listingsView } from './ebayListings.js';
import { ordersView } from './ebayOrders.js';
import { inboxView } from './ebayInbox.js';

/**
 * The eBay side in one look, for the dashboard's eBay section, the ops door
 * and the 9am brief: whether it's connected, each listing's shelf, price and
 * market, orders and what they still need, and what's waiting in the inbox.
 */

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const hoursText = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`);
const dollars = (c) => `$${(c / 100).toFixed(2)}`;

export function lastEbaySync() {
  try {
    return JSON.parse(getMeta('ebay_sync') || 'null');
  } catch {
    return null;
  }
}

export function ebayBoard({ now = new Date() } = {}) {
  const account = ebayAccount();
  const base = {
    keys: ebayKeys(),
    verifyToken: Boolean(config.ebayVerifyToken),
    connected: ebayConnected(),
    account,
    extras: hasExtras(),
    urls: { callback: callbackUrl(), deletion: deletionUrl() },
    settings: ebaySettings(),
    sync: lastEbaySync(),
  };
  if (!base.connected) return base;
  const listings = listingsView();
  return {
    ...base,
    listings,
    orders: ordersView({ now }),
    inbox: inboxView({ now }),
    restock: listings.filter((l) => l.active && l.restock > 0)
      .map((l) => ({ itemId: l.itemId, product: l.product || l.title, need: l.restock, onHand: l.onHand, target: l.target })),
  };
}

/** The brief's eBay lines: { lines, action } like its other sections. */
export function ebayBriefLines({ now = new Date() } = {}) {
  if (!ebayKeys()) return { lines: [], action: false };
  if (!ebayConnected()) {
    return {
      lines: [ebayAccount()?.broken ? '🔴 eBay: the connection ended. Press Connect eBay on the dashboard.' : '🔗 eBay isn\'t connected yet: press Connect eBay on the dashboard.'],
      action: true,
    };
  }
  const b = ebayBoard({ now });
  const lines = [];
  let action = false;
  const add = (text, isAction = true) => {
    lines.push(text);
    if (isAction) action = true;
  };
  const o = b.orders;
  if (o.toPost) add(`🛒 eBay: ${plural(o.toPost, 'order')} to post${o.late ? `, **${o.late} late**` : o.dueToday ? `, ${o.dueToday} due today` : ''}`);
  if (o.noTracking.length) add(`🏷️ eBay: ${plural(o.noTracking.length, 'parcel')} ticked shipped with no tracking. Add it so eBay counts them as posted.`);
  if (o.cancelRequests.length) add(`✋ eBay: ${plural(o.cancelRequests.length, 'buyer')} asked to cancel. Answer in eBay before posting.`);
  const inbox = b.inbox;
  if (inbox.messages.length) add(`💬 eBay: ${plural(inbox.messages.length, 'message')} waiting for a reply (oldest ${hoursText(inbox.oldestHours)})`);
  for (const n of inbox.notices.slice(0, 3)) add(`📣 eBay: ${n.title}`);
  const bad = inbox.newFeedback.filter((f) => f.rating && f.rating !== 'POSITIVE');
  for (const f of bad) add(`🔴 eBay ${String(f.rating).toLowerCase()} feedback from ${f.who || 'a buyer'}: "${String(f.body || '').slice(0, 80)}"`);
  const good = inbox.newFeedback.length - bad.length;
  if (good) add(`⭐ ${plural(good, 'new eBay review')}, all positive`, false);
  for (const l of b.listings.filter((x) => x.status === 'held')) add(`💲 eBay price waiting for your OK: ${l.title.slice(0, 40)}, ${dollars(l.ebayPrice)} to ${dollars(l.held)}`);
  for (const l of b.listings.filter((x) => x.status === 'error')) add(`⚠️ eBay listing not updating: ${l.title.slice(0, 40)}: ${l.error}`);
  const empty = b.listings.filter((x) => x.active && x.onHand === 0);
  if (b.restock.length) add(`📦 eBay shelf to restock: ${b.restock.map((r) => `${r.need} ${r.product}`).join(', ')}`, empty.length > 0);
  const unlinked = b.listings.filter((x) => x.status === 'unlinked').length;
  if (unlinked) add(`🔗 ${plural(unlinked, 'eBay listing')} not linked to a product yet (dashboard, eBay section)`, false);
  return { lines, action };
}

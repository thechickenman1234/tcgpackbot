import { setMeta } from '../services/metaService.js';
import { noteFail, noteOk } from '../services/healthService.js';
import { ebayConnected, refreshAccount } from '../services/ebayService.js';
import { checkMarkets, checkOutOfStockControl, pushListings, syncListings } from '../services/ebayListings.js';
import { sendThanks, syncFulfilments, syncOrders } from '../services/ebayOrders.js';
import { syncInbox } from '../services/ebayInbox.js';

/**
 * Keeps eBay and the bot in step, every 5 minutes while eBay is connected:
 *
 *   every run       new orders in, tracking out, shelf and price changes out
 *   every 15 min    messages, eBay's notices, feedback
 *   every 30 min    thank-yous that are due
 *   every 6 hours   the list of listings, then the market check
 *   every 12 hours  the account (business, store, limits, out-of-stock control)
 *
 * Each part fails on its own: a messages error never stops tracking going
 * out. Failures go to the health check, which pings once if it lasts.
 */

const MINUTE = 60000;
const EVERY = { inbox: 15 * MINUTE, thanks: 30 * MINUTE, listings: 6 * 60 * MINUTE, account: 12 * 60 * MINUTE };
const last = { inbox: 0, thanks: 0, listings: 0, account: 0 };
let running = null;
let kickTimer = null;

export async function runEbaySync(client, { full = false, now = new Date() } = {}) {
  if (!ebayConnected()) return { skipped: true };
  if (running) return running;
  running = (async () => {
    const t = now.getTime();
    const due = (part) => full || t - last[part] >= EVERY[part];
    const report = { errors: [] };
    const step = async (name, fn) => {
      try {
        report[name] = await fn();
      } catch (err) {
        report.errors.push(`${name}: ${err.message}`);
      }
    };
    if (due('account')) {
      last.account = t;
      await step('account', async () => {
        await refreshAccount();
        return { outOfStockControl: await checkOutOfStockControl() };
      });
    }
    if (due('listings')) {
      last.listings = t;
      await step('listings', () => syncListings({ now }));
    }
    await step('orders', async () => {
      const r = await syncOrders(client, { now });
      return { added: r.added.length, cancelled: r.cancelled.length, requests: r.requests.length, shippedThere: r.shippedThere.length };
    });
    await step('tracking', () => syncFulfilments({ now }));
    await step('stock', () => pushListings({ now }));
    if (due('inbox')) {
      last.inbox = t;
      await step('inbox', () => syncInbox(client, { now }));
    }
    if (due('thanks')) {
      last.thanks = t;
      await step('thanks', () => sendThanks({ now }));
    }
    if (report.listings) await step('market', () => checkMarkets({ now }));
    setMeta('ebay_sync', JSON.stringify({ at: now.toISOString(), errors: report.errors }));
    if (report.errors.length) noteFail('ebay', report.errors.join('; '), now);
    else noteOk('ebay', now);
    return report;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

/** A parcel was just ticked: send its tracking to eBay in a few seconds rather than at the next run. */
export function kickEbay(client) {
  if (!ebayConnected()) return;
  clearTimeout(kickTimer);
  kickTimer = setTimeout(() => {
    runEbaySync(client).catch((err) => console.error('eBay sync failed:', err));
  }, 3000);
}

export function startEbayJob(client, intervalMs = 5 * MINUTE) {
  const tick = () => {
    runEbaySync(client).catch((err) => console.error('eBay sync failed:', err));
  };
  setTimeout(tick, 90 * 1000);
  return setInterval(tick, intervalMs);
}

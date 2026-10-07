import { config } from '../config.js';
import {
  getSalesToAnnounce,
  getSalesToClose,
  getSalesToOpen,
  markAnnounced,
  markClosed,
  markSaleFailed,
  openSale,
  productsFor,
} from '../services/scheduledSaleService.js';
import { buildStockpostPayload, rememberStockpost } from '../services/stockpostService.js';
import { endClaimSale } from '../services/saleAnnouncements.js';
import { buildSaleLiveMessage, buildSalePriceAnnouncement } from '../services/saleMessages.js';
import { formatMelbourne } from '../services/scheduleService.js';

/**
 * Opens and closes scheduled claim sales.
 *
 * Runs every 30 seconds. A sale whose start passed during a restart opens
 * on the next tick rather than being skipped, because a sale that silently
 * never opened is far worse than one that opened a minute late.
 *
 * Each sale is wrapped on its own: one product that has been deleted must
 * not stop the next sale in the queue from running.
 */
async function tick(client) {
  // Prices first, usually an hour before the doors open.
  for (const sale of getSalesToAnnounce()) {
    try {
      const channel = await client.channels.fetch(sale.announce_channel_id);
      if (!channel?.isTextBased()) throw new Error('Announcement channel is gone');

      const products = productsFor(sale);
      if (!products.length) throw new Error('None of the products for this sale still exist');

      await channel.send({
        content: buildSalePriceAnnouncement(products, { note: sale.note, title: sale.title }),
        allowedMentions: { parse: ['everyone'] },
      });
      markAnnounced(sale.id);
      console.log(`Scheduled sale ${sale.id} prices announced`);
    } catch (err) {
      console.error(`Scheduled sale ${sale.id} failed to announce:`, err.message);
      // Deliberately not marked failed: missing the price post is a shame,
      // but the sale itself should still open at 8pm.
      markAnnounced(sale.id);
    }
  }

  for (const sale of getSalesToOpen()) {
    try {
      const channel = await client.channels.fetch(sale.channel_id);
      if (!channel?.isTextBased()) throw new Error('Sale channel is gone');

      const result = openSale(sale);
      if (!result.ok) throw new Error('None of the products for this sale still exist');

      // The written post first, since that is the one people read, then
      // the stock embed with the dropdown under it.
      await channel.send({
        content: buildSaleLiveMessage(result.products, { note: sale.note, title: sale.title }),
        allowedMentions: { parse: ['everyone'] },
      });

      const payload = buildStockpostPayload(result.products);
      const message = await channel.send(payload);
      rememberStockpost(channel.id, message.id);

      console.log(
        `Scheduled sale ${sale.id} opened with ${result.products.length} product(s), `
        + `closes ${formatMelbourne(sale.end_at)}`,
      );
    } catch (err) {
      console.error(`Scheduled sale ${sale.id} failed to open:`, err.message);
      markSaleFailed(sale.id, err.message);
    }
  }

  for (const sale of getSalesToClose()) {
    try {
      const channel = await client.channels.fetch(sale.channel_id);
      // endClaimSale closes every active product, posts the sale-over
      // message and opens the late window, which is exactly what /endsale
      // does by hand.
      await endClaimSale(channel, {
        announce: true,
        productNames: productsFor(sale).map((p) => p.name),
      });
      markClosed(sale.id);
      console.log(`Scheduled sale ${sale.id} closed`);
    } catch (err) {
      console.error(`Scheduled sale ${sale.id} failed to close:`, err.message);
      markSaleFailed(sale.id, err.message);
    }
  }
}

export function startScheduledSalesJob(client, everyMs = 30000) {
  if (!config.claimsChannelId) return;
  setInterval(() => {
    tick(client).catch((err) => console.error('Scheduled sales job:', err));
  }, everyMs).unref?.();
}

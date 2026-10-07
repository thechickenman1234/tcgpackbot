import { config } from '../config.js';
import {
  getSalesToClose,
  getSalesToOpen,
  markClosed,
  markSaleFailed,
  openSale,
  productsFor,
} from '../services/scheduledSaleService.js';
import { buildStockpostPayload, rememberStockpost } from '../services/stockpostService.js';
import { announceSaleStart, endClaimSale } from '../services/saleAnnouncements.js';
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
  for (const sale of getSalesToOpen()) {
    try {
      const channel = await client.channels.fetch(sale.channel_id);
      if (!channel?.isTextBased()) throw new Error('Sale channel is gone');

      const result = openSale(sale);
      if (!result.ok) throw new Error('None of the products for this sale still exist');

      const payload = buildStockpostPayload(result.products);
      const message = await channel.send(payload);
      rememberStockpost(channel.id, message.id);

      await announceSaleStart(channel, result.products.map((p) => p.name));

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

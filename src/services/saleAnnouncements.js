import { config } from '../config.js';
import {
  closeLateWindow, findProductByName, listActiveProducts, openLateWindow, setProductActive,
} from './productService.js';
import { clearStockpostPointer, refreshStockpost } from './stockpostService.js';
import { currentOpenSale } from './scheduledSaleService.js';
import { postOrderSheet } from './orderSheet.js';

export function buildSaleOverMessage(productNames = []) {
  const hours = config.paymentDeadlineHours;
  const label = productNames.length
    ? productNames.map((n) => n.toUpperCase()).join(' / ')
    : 'CLAIM SALE';

  return [
    '@everyone',
    `**[${label}] CLAIM SALE IS NOW OVER!!!**`,
    'Please check the thread that opened up for payment and shipping details.',
    `Payments must be sent within **${hours} hours**, or you will be banned from all future Claim Sales.`,
    'DM staff if you have any issues.',
  ].join(' ');
}

export function buildSoldOutMessage(productName) {
  return `@everyone **[${productName.toUpperCase()}] SOLD OUT!** No more claims for this product.`;
}

export function buildSaleStartMessage(productNames = []) {
  const label = productNames.length
    ? productNames.map((n) => n.toUpperCase()).join(' / ')
    : 'CLAIM';

  return `@everyone **THE ${label} CLAIM SALE HAS NOW BEGUN!! BE QUICK!!**`;
}

export async function announceSaleStart(channel, productNames) {
  if (!channel?.isTextBased()) return;
  await channel.send(buildSaleStartMessage(productNames));
}

export async function announceSoldOut(channel, productName) {
  if (!channel?.isTextBased()) return;
  await channel.send(buildSoldOutMessage(productName));
}

export async function endClaimSale(channel, { announce = true, productNames = null } = {}) {
  const active = listActiveProducts();
  const names = productNames ?? active.map((p) => p.name);

  // The sale closes, but claims keep working for another day at a markup.
  // Shutting the door completely just moves the orders into your DMs.
  for (const product of active) {
    setProductActive(product.id, false);
    if (config.lateWindowHours > 0) {
      openLateWindow(product.id, config.lateWindowHours, config.lateMarkupPercent);
    }
  }

  if (announce && channel?.isTextBased()) {
    await channel.send(buildSaleOverMessage(names));
    if (config.lateWindowHours > 0 && active.length) {
      const until = Math.floor((Date.now() + config.lateWindowHours * 3600000) / 1000);
      await channel.send(
        `⏰ **Late claims are open for another ${config.lateWindowHours} hours** `
        + `(until <t:${until}:t>) at **+${config.lateMarkupPercent}%**, while stock lasts.\n`
        + 'Claim the same way you normally would. After that the sale is closed — '
        + 'wholesale enquiries only.',
      );
    }
  }

  if (channel?.client) {
    try {
      await refreshStockpost(channel.client);
    } catch {
      // ignore
    }
  }
  clearStockpostPointer();

  // What to order, in the staff log. The sale's own product list counts
  // anything that sold out earlier in the night, which `active` no longer has.
  if (channel?.client) {
    try {
      const sale = currentOpenSale();
      const ids = active.map((p) => p.id);
      if (sale) ids.push(...JSON.parse(sale.product_ids));
      for (const name of names) {
        const product = findProductByName(name);
        if (product) ids.push(product.id);
      }
      await postOrderSheet(channel.client, { productIds: ids, sinceIso: sale ? sale.opened_at || sale.start_at : null });
    } catch (err) {
      console.error('Order sheet failed:', err);
    }
  }

  return names;
}

/**
 * After a claim: if product hit 0, announce sold out.
 * If nothing with stock remains, end the whole sale.
 */
export async function handlePostClaimSaleState(channel, product) {
  if (!product) return;

  // A late claim: the sale already ended once. Running the end-of-sale
  // steps again would post "CLAIM SALE IS NOW OVER" to @everyone after
  // every single late claim. Just say so if that was the last one.
  if (!product.active) {
    if (product.quantity_available <= 0) {
      closeLateWindow(product.id);
      try {
        await announceSoldOut(channel, product.name);
      } catch (err) {
        console.error('Sold out announce failed:', err);
      }
    }
    return;
  }

  if (product.quantity_available <= 0) {
    setProductActive(product.id, false);
    try {
      await announceSoldOut(channel, product.name);
    } catch (err) {
      console.error('Sold out announce failed:', err);
    }
  }

  const remainingWithStock = listActiveProducts().filter((p) => p.quantity_available > 0);
  if (remainingWithStock.length > 0) {
    try {
      await refreshStockpost(channel.client);
    } catch (err) {
      console.error('Stockpost refresh after claim failed:', err);
    }
    return;
  }

  const leftoverNames = listActiveProducts().map((p) => p.name);
  const names = leftoverNames.length ? leftoverNames : [product.name];

  try {
    await endClaimSale(channel, { announce: true, productNames: names });
  } catch (err) {
    console.error('Auto end-sale failed:', err);
  }
}

import { config } from '../config.js';
import { listActiveProducts, setProductActive } from './productService.js';

export function buildSaleOverMessage(productNames = []) {
  const hours = config.paymentDeadlineHours;
  const label = productNames.length
    ? productNames.map((n) => n.toUpperCase()).join(' / ')
    : 'CLAIM SALE';

  return [
    `**[${label}] CLAIM SALE IS NOW OVER!!!**`,
    'Please check the thread that opened up for payment and shipping details.',
    `Payments must be sent within **${hours} hours**, or you will be banned from all future Claim Sales.`,
    'DM staff if you have any issues.',
  ].join(' ');
}

export function buildSoldOutMessage(productName) {
  return `**[${productName.toUpperCase()}] SOLD OUT!** No more claims for this product.`;
}

export async function announceSoldOut(channel, productName) {
  if (!channel?.isTextBased()) return;
  await channel.send(buildSoldOutMessage(productName));
}

export async function endClaimSale(channel, { announce = true, productNames = null } = {}) {
  const active = listActiveProducts();
  const names = productNames ?? active.map((p) => p.name);

  for (const product of active) {
    setProductActive(product.id, false);
  }

  if (announce && channel?.isTextBased()) {
    await channel.send(buildSaleOverMessage(names));
  }

  return names;
}

/**
 * After a claim: if product hit 0, announce sold out.
 * If nothing with stock remains, end the whole sale.
 */
export async function handlePostClaimSaleState(channel, product) {
  if (!product) return;

  if (product.quantity_available <= 0) {
    setProductActive(product.id, false);
    try {
      await announceSoldOut(channel, product.name);
    } catch (err) {
      console.error('Sold out announce failed:', err);
    }
  }

  const remainingWithStock = listActiveProducts().filter((p) => p.quantity_available > 0);
  if (remainingWithStock.length > 0) return;

  const leftoverNames = listActiveProducts().map((p) => p.name);
  const names = leftoverNames.length ? leftoverNames : [product.name];

  try {
    await endClaimSale(channel, { announce: true, productNames: names });
  } catch (err) {
    console.error('Auto end-sale failed:', err);
  }
}

import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { formatAud } from '../utils/permissions.js';
import { getProductMaxPerBuyer, getProductTiers, listActiveProducts } from '../services/productService.js';
import { CLAIM_SELECT_ID } from './customIds.js';

export { CLAIM_SELECT_ID };

export function buildClaimSelectRow(products = listActiveProducts()) {
  const options = products
    .filter((p) => p.quantity_available > 0)
    .slice(0, 25)
    .map((p) => {
      const limit = getProductMaxPerBuyer(p);
      const limitNote = limit ? ` · max ${limit}/person` : '';
      const tiers = getProductTiers(p);
      const priceNote = tiers
        ? `From ${formatAud(tiers[tiers.length - 1].priceCents)}/ea (tiered)`
        : `${formatAud(p.price_cents)}${p.shipping_cents ? ` + ${formatAud(p.shipping_cents)} ship` : ''}`;
      return {
        label: p.name.slice(0, 100),
        description: `${priceNote} · ${p.quantity_available} left${limitNote}`.slice(0, 100),
        value: String(p.id),
      };
    });

  if (!options.length) return null;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(CLAIM_SELECT_ID)
      .setPlaceholder('Claim a product…')
      .addOptions(options),
  );
}

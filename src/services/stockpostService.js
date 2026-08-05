import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { formatAud } from '../utils/permissions.js';
import { buildClaimSelectRow } from '../ui/claimSelect.js';
import { getProductMaxPerBuyer, listActiveProducts } from './productService.js';
import { clearMeta, getMeta, setMeta } from './metaService.js';

const STOCKPOST_MESSAGE_KEY = 'stockpost_message_id';
const STOCKPOST_CHANNEL_KEY = 'stockpost_channel_id';

export function buildStockpostEmbed(products = listActiveProducts()) {
  return new EmbedBuilder()
    .setTitle('TCG Pack Bot — Claim Sale')
    .setColor(0xe67e22)
    .setDescription(
      [
        '**How to claim**',
        '1. Use the dropdown below to pick a product',
        '2. Enter quantity (and shipping details if it\'s your first claim)',
        '3. You\'ll get a **private ticket** with PayID payment details',
        '',
        'Payment deadline applies once your claim is locked — pay and post a screenshot in your ticket.',
        'Need to change your address later? Use `/shipping`.',
      ].join('\n'),
    )
    .addFields(
      products.map((p) => {
        const limit = getProductMaxPerBuyer(p);
        return {
          name: p.name,
          value: [
            `Price: **${formatAud(p.price_cents)}**`,
            p.shipping_cents ? `Shipping: **${formatAud(p.shipping_cents)}** (flat)` : 'Shipping: included / none',
            `Available: **${p.quantity_available}**`,
            limit ? `Limit: **${limit}** per person` : null,
            p.sale_window ? `Window: ${p.sale_window}` : null,
          ].filter(Boolean).join('\n'),
          inline: true,
        };
      }),
    )
    .setFooter({
      text: `Payment via PayID · ${config.paymentDeadlineHours}h deadline · confirmed manually by staff`,
    });
}

export function buildStockpostPayload(products = listActiveProducts()) {
  const selectRow = buildClaimSelectRow(products);
  return {
    embeds: [buildStockpostEmbed(products)],
    components: selectRow ? [selectRow] : [],
  };
}

export function rememberStockpost(channelId, messageId) {
  setMeta(STOCKPOST_CHANNEL_KEY, channelId);
  setMeta(STOCKPOST_MESSAGE_KEY, messageId);
}

export function clearStockpostPointer() {
  clearMeta(STOCKPOST_CHANNEL_KEY);
  clearMeta(STOCKPOST_MESSAGE_KEY);
}

/**
 * Edit the last /stockpost message so qty/limit stay current.
 * Safe no-op if missing or deleted.
 */
export async function refreshStockpost(client) {
  const channelId = getMeta(STOCKPOST_CHANNEL_KEY);
  const messageId = getMeta(STOCKPOST_MESSAGE_KEY);
  if (!channelId || !messageId || !client) return false;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) return false;

    const message = await channel.messages.fetch(messageId);
    const products = listActiveProducts().filter((p) => p.quantity_available > 0);

    if (!products.length) {
      await message.edit({
        content: 'Claim sale stock updated — nothing currently available. Staff can `/stockpost` again when restocked.',
        embeds: [],
        components: [],
      });
      return true;
    }

    await message.edit(buildStockpostPayload(listActiveProducts()));
    return true;
  } catch (err) {
    console.error('Stockpost refresh failed:', err.message);
    return false;
  }
}

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { config } from '../config.js';
import { formatAud } from '../utils/permissions.js';
import { buyerDetailsFromRow, getBuyer } from '../services/buyerService.js';
import { getOrderById, setShippingMethod } from '../services/orderService.js';
import { buildPaymentEmbed } from '../services/paymentEmbed.js';
import { SHIP_METHOD_PREFIX } from '../ui/customIds.js';

export { SHIP_METHOD_PREFIX };

export function buildShippingMethodRow(orderId, buyerId = null) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`${SHIP_METHOD_PREFIX}standard:${orderId}`)
      .setLabel(`Standard — ${formatAud(config.standardShippingCents)}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${SHIP_METHOD_PREFIX}express:${orderId}`)
      .setLabel(`Express — ${formatAud(config.expressShippingCents)}`)
      .setStyle(ButtonStyle.Primary),
  ];

  // There used to be a third button here letting a buyer combine this
  // order into a parcel they already had waiting, with no shipping
  // charged. It made every order a special case at packing time and the
  // zeroed shipping was impossible to reconcile afterwards. Every order
  // now stands on its own.
  return new ActionRowBuilder().addComponents(...buttons);
}

export async function handleShippingMethodButton(interaction) {
  const [, method, orderIdRaw] = interaction.customId.split(':');
  const orderId = Number(orderIdRaw);
  const order = getOrderById(orderId);

  if (!order) {
    await interaction.reply({ content: 'Order not found.', ephemeral: true });
    return;
  }

  if (order.buyer_id !== interaction.user.id) {
    await interaction.reply({ content: 'This choice is for the buyer only.', ephemeral: true });
    return;
  }

  // Old combine buttons may still be sitting in threads from before the
  // feature was removed, so answer them rather than failing silently.
  if (method === 'combine') {
    await interaction.reply({
      content: 'Orders are no longer combined — each one is shipped and charged on its own. '
        + 'Pick **Standard** or **Express**.',
      ephemeral: true,
    });
    return;
  }

  const result = setShippingMethod(orderId, method);
  const chosenLabel = method === 'express' ? 'Express' : 'Standard';

  if (!result.ok) {
    await interaction.reply({
      content: `Couldn't set shipping method (status: \`${order.status}\`).`,
      ephemeral: true,
    });
    return;
  }

  const shipping = buyerDetailsFromRow(getBuyer(order.buyer_id));

  await interaction.update({ content: `Shipping: **${chosenLabel}**`, components: [] });

  await interaction.followUp({
    embeds: [buildPaymentEmbed(result.order, shipping)],
  });
}

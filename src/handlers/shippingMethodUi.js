import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { config } from '../config.js';
import { formatAud } from '../utils/permissions.js';
import { buyerDetailsFromRow, getBuyer } from '../services/buyerService.js';
import {
  getOrderById,
  getUnshippedOrdersForBuyer,
  setCombinedShipping,
  setShippingMethod,
} from '../services/orderService.js';
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

  // Only worth offering when they already have something that hasn't gone out.
  if (buyerId && getUnshippedOrdersForBuyer(buyerId, orderId).length) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${SHIP_METHOD_PREFIX}combine:${orderId}`)
        .setLabel('Combine with my other order — free')
        .setStyle(ButtonStyle.Success),
    );
  }

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

  let result;
  let chosenLabel;

  if (method === 'combine') {
    const others = getUnshippedOrdersForBuyer(order.buyer_id, orderId);
    if (!others.length) {
      await interaction.reply({
        content: 'Nothing left to combine with — your other order has already shipped. Pick Standard or Express.',
        ephemeral: true,
      });
      return;
    }
    const parcel = others[0];
    result = setCombinedShipping(orderId, parcel.reference_code);
    chosenLabel = `Combined with \`${parcel.reference_code}\` — no shipping charged`;
  } else {
    result = setShippingMethod(orderId, method);
    chosenLabel = method === 'express' ? 'Express' : 'Standard';
  }

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

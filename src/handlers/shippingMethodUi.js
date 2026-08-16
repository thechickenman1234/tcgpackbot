import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { config } from '../config.js';
import { formatAud } from '../utils/permissions.js';
import { buyerDetailsFromRow, getBuyer } from '../services/buyerService.js';
import { getOrderById, setShippingMethod } from '../services/orderService.js';
import { buildPaymentEmbed } from '../services/paymentEmbed.js';
import { SHIP_METHOD_PREFIX } from '../ui/customIds.js';

export { SHIP_METHOD_PREFIX };

export function buildShippingMethodRow(orderId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${SHIP_METHOD_PREFIX}standard:${orderId}`)
      .setLabel(`Standard — ${formatAud(config.standardShippingCents)}`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${SHIP_METHOD_PREFIX}express:${orderId}`)
      .setLabel(`Express — ${formatAud(config.expressShippingCents)}`)
      .setStyle(ButtonStyle.Primary),
  );
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

  const result = setShippingMethod(orderId, method);
  if (!result.ok) {
    await interaction.reply({
      content: `Couldn't set shipping method (status: \`${order.status}\`).`,
      ephemeral: true,
    });
    return;
  }

  const shipping = buyerDetailsFromRow(getBuyer(order.buyer_id));

  await interaction.update({ content: `Shipping method: **${method === 'express' ? 'Express' : 'Standard'}**`, components: [] });

  await interaction.followUp({
    embeds: [buildPaymentEmbed(result.order, shipping)],
  });
}

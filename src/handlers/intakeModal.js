import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { updateBuyerDetails } from '../services/buyerService.js';
import { getOrderById } from '../services/orderService.js';
import { buildPaymentEmbed } from '../services/paymentEmbed.js';

export function buildIntakeModal(orderId) {
  return new ModalBuilder()
    .setCustomId(`intake_modal:${orderId}`)
    .setTitle('Shipping details')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('full_name')
          .setLabel('Full name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('phone')
          .setLabel('Phone number')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(30),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('address')
          .setLabel('Shipping address')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500),
      ),
    );
}

export async function showIntakeModal(interaction) {
  const orderId = Number(interaction.customId.split(':')[1]);
  const order = getOrderById(orderId);

  if (!order) {
    await interaction.reply({ content: 'Order not found.', ephemeral: true });
    return;
  }

  if (order.buyer_id !== interaction.user.id && !interaction.memberPermissions?.has('ManageGuild')) {
    await interaction.reply({ content: 'This form is for the buyer only.', ephemeral: true });
    return;
  }

  if (order.status !== 'pending') {
    await interaction.reply({ content: 'This order is no longer awaiting intake.', ephemeral: true });
    return;
  }

  await interaction.showModal(buildIntakeModal(orderId));
}

export async function handleIntakeSubmit(interaction) {
  const orderId = Number(interaction.customId.split(':')[1]);
  const order = getOrderById(orderId);

  if (!order) {
    await interaction.reply({ content: 'Order not found.', ephemeral: true });
    return;
  }

  if (order.buyer_id !== interaction.user.id) {
    await interaction.reply({ content: 'This form is for the buyer only.', ephemeral: true });
    return;
  }

  if (order.status !== 'pending') {
    await interaction.reply({ content: 'This order is no longer awaiting payment details.', ephemeral: true });
    return;
  }

  const name = interaction.fields.getTextInputValue('full_name').trim();
  const phone = interaction.fields.getTextInputValue('phone').trim();
  const address = interaction.fields.getTextInputValue('address').trim();

  updateBuyerDetails(interaction.user.id, {
    name,
    phone,
    shippingAddress: address,
  });

  await interaction.reply({
    embeds: [
      buildPaymentEmbed(order, {
        name,
        phone,
        shippingAddress: address,
      }),
    ],
  });
}

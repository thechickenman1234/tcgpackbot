import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} from 'discord.js';
import { config } from '../config.js';
import { formatAud } from '../utils/permissions.js';
import { updateBuyerDetails } from '../services/buyerService.js';
import { getOrderById } from '../services/orderService.js';

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

  const deadlineUnix = Math.floor(new Date(order.payment_deadline_at).getTime() / 1000);

  const embed = new EmbedBuilder()
    .setTitle('Payment details')
    .setColor(0x2ecc71)
    .setDescription(
      [
        'Transfer the exact amount via PayID and **include the order reference** in the payment description.',
        'Then post a screenshot of the transfer in this thread.',
        '',
        'Staff will manually confirm payment (no automatic bank matching in v1).',
      ].join('\n'),
    )
    .addFields(
      { name: 'PayID', value: `\`${config.payId}\``, inline: false },
      { name: 'Amount owed', value: `**${formatAud(order.total_cents)}**`, inline: true },
      { name: 'Order reference', value: `\`${order.reference_code}\``, inline: true },
      { name: 'Items', value: `${order.quantity}x ${order.product_name}`, inline: false },
      {
        name: 'Payment deadline',
        value: `<t:${deadlineUnix}:F> (<t:${deadlineUnix}:R>)`,
        inline: false,
      },
      { name: 'Ship to', value: `${name}\n${phone}\n${address}`, inline: false },
    )
    .setFooter({ text: 'Missing the deadline without payment results in a claim ban.' });

  await interaction.reply({ embeds: [embed] });
}

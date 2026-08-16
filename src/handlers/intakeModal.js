import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { updateBuyerDetails } from '../services/buyerService.js';
import { getOrderById } from '../services/orderService.js';
import { buildShippingMethodRow } from './shippingMethodUi.js';

export function buildIntakeModal(orderId) {
  // 5 fields max: name, phone, street, city, state+zip
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
          .setLabel('Street address')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('city')
          .setLabel('City / Suburb')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('state_zip')
          .setLabel('State and ZIP / postcode')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(40)
          .setPlaceholder('VIC 3000'),
      ),
    );
}

function parseStateZip(raw) {
  const text = raw.trim().replace(/\s+/g, ' ');
  const match = text.match(/^(.+?)\s+(\d[\w-]*)$/);
  if (match) return { state: match[1].trim(), zip: match[2] };
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { state: parts[0], zip: parts.slice(1).join(' ') };
  return { state: text, zip: '' };
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
  const city = interaction.fields.getTextInputValue('city').trim();
  const { state, zip } = parseStateZip(interaction.fields.getTextInputValue('state_zip'));

  if (!state || !zip) {
    await interaction.reply({
      content: 'Please enter state and ZIP like: `VIC 3000`',
      ephemeral: true,
    });
    return;
  }

  updateBuyerDetails(interaction.user.id, {
    name,
    phone,
    shippingAddress: address,
    city,
    state,
    zip,
  });

  await interaction.reply({
    content: 'One more step — pick a shipping method:',
    components: [buildShippingMethodRow(orderId)],
  });
}

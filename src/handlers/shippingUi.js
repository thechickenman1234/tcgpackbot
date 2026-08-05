import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { parseCityStateZip } from '../utils/claimParser.js';
import { isStaff } from '../utils/permissions.js';
import {
  buyerDetailsFromRow,
  getBuyer,
  updateBuyerDetails,
} from '../services/buyerService.js';
import {
  getOrderById,
  getOrderByThreadId,
  listPendingOrdersByBuyer,
} from '../services/orderService.js';
import { buildPaymentEmbed } from '../services/paymentEmbed.js';
import {
  SHIPPING_MODAL_ID,
  SHIPPING_MODAL_USER_PREFIX,
  UPDATE_SHIPPING_BUTTON_PREFIX,
} from '../ui/customIds.js';

export {
  SHIPPING_MODAL_ID,
  SHIPPING_MODAL_USER_PREFIX,
  UPDATE_SHIPPING_BUTTON_PREFIX,
};

function withValue(input, value, maxLen) {
  const trimmed = (value || '').trim();
  if (trimmed) input.setValue(trimmed.slice(0, maxLen));
  return input;
}

function buildShippingModal(customId, defaults = {}) {
  const cityStateZip = [defaults.city, defaults.state, defaults.zip].filter(Boolean).join(', ');

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Update shipping details')
    .addComponents(
      new ActionRowBuilder().addComponents(
        withValue(
          new TextInputBuilder()
            .setCustomId('full_name')
            .setLabel('Full name')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100),
          defaults.name,
          100,
        ),
      ),
      new ActionRowBuilder().addComponents(
        withValue(
          new TextInputBuilder()
            .setCustomId('phone')
            .setLabel('Phone number')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(30),
          defaults.phone,
          30,
        ),
      ),
      new ActionRowBuilder().addComponents(
        withValue(
          new TextInputBuilder()
            .setCustomId('address')
            .setLabel('Street address')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(200),
          defaults.shippingAddress || defaults.shipping_address,
          200,
        ),
      ),
      new ActionRowBuilder().addComponents(
        withValue(
          new TextInputBuilder()
            .setCustomId('city_state_zip')
            .setLabel('City, State, ZIP')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(120)
            .setPlaceholder('Melbourne, VIC, 3000'),
          cityStateZip,
          120,
        ),
      ),
    );
}

export async function showShippingModalForUser(interaction, targetUserId) {
  const buyer = getBuyer(targetUserId);
  const defaults = buyer
    ? {
      name: buyer.name,
      phone: buyer.phone,
      shippingAddress: buyer.shipping_address,
      city: buyer.city,
      state: buyer.state,
      zip: buyer.zip,
    }
    : {};

  const customId = targetUserId === interaction.user.id
    ? SHIPPING_MODAL_ID
    : `${SHIPPING_MODAL_USER_PREFIX}${targetUserId}`;

  await interaction.showModal(buildShippingModal(customId, defaults));
}

export async function handleUpdateShippingButton(interaction) {
  const orderId = Number(interaction.customId.slice(UPDATE_SHIPPING_BUTTON_PREFIX.length));
  const order = getOrderById(orderId);

  if (!order) {
    await interaction.reply({ content: 'Order not found.', ephemeral: true });
    return;
  }

  const staff = isStaff(interaction.member);
  if (order.buyer_id !== interaction.user.id && !staff) {
    await interaction.reply({ content: 'Only the buyer or staff can update shipping.', ephemeral: true });
    return;
  }

  if (!['pending', 'paid'].includes(order.status)) {
    await interaction.reply({ content: 'Shipping can only be updated on open orders.', ephemeral: true });
    return;
  }

  await showShippingModalForUser(interaction, order.buyer_id);
}

export async function handleShippingCommand(interaction) {
  const target = interaction.options.getUser('user');
  let targetUserId = interaction.user.id;

  if (target) {
    if (!isStaff(interaction.member)) {
      await interaction.reply({ content: 'Only staff can update shipping for another user.', ephemeral: true });
      return;
    }
    targetUserId = target.id;
  }

  await showShippingModalForUser(interaction, targetUserId);
}

async function applyShippingUpdate(interaction, targetUserId) {
  const name = interaction.fields.getTextInputValue('full_name').trim();
  const phone = interaction.fields.getTextInputValue('phone').trim();
  const address = interaction.fields.getTextInputValue('address').trim();
  const { city, state, zip } = parseCityStateZip(
    interaction.fields.getTextInputValue('city_state_zip'),
  );

  if (!city || !state || !zip) {
    await interaction.reply({
      content: 'Please enter City, State, ZIP like: `Melbourne, VIC, 3000`',
      ephemeral: true,
    });
    return;
  }

  updateBuyerDetails(targetUserId, {
    name,
    phone,
    shippingAddress: address,
    city,
    state,
    zip,
  });

  const details = {
    name,
    phone,
    shippingAddress: address,
    city,
    state,
    zip,
  };

  // Prefer the ticket thread if present; otherwise refresh pending tickets.
  let order = interaction.channel?.isThread()
    ? getOrderByThreadId(interaction.channelId)
    : null;

  if (!order || order.buyer_id !== targetUserId) {
    const pending = listPendingOrdersByBuyer(targetUserId);
    order = pending[0] ?? null;
  }

  if (order?.thread_id && ['pending', 'paid'].includes(order.status)) {
    try {
      const thread = await interaction.client.channels.fetch(order.thread_id);
      if (thread?.isThread()) {
        await thread.send({
          content: `📦 Shipping details updated for <@${targetUserId}>.`,
          embeds: [buildPaymentEmbed(order, details)],
        });
      }
    } catch (err) {
      console.error('Failed to post shipping update in thread:', err.message);
    }
  }

  await interaction.reply({
    content: targetUserId === interaction.user.id
      ? 'Shipping details saved.'
      : `Shipping details saved for <@${targetUserId}>.`,
    ephemeral: true,
  });
}

export async function handleShippingModalSubmit(interaction) {
  if (interaction.customId === SHIPPING_MODAL_ID) {
    await applyShippingUpdate(interaction, interaction.user.id);
    return;
  }

  if (interaction.customId.startsWith(SHIPPING_MODAL_USER_PREFIX)) {
    if (!isStaff(interaction.member)) {
      await interaction.reply({ content: 'Staff only.', ephemeral: true });
      return;
    }
    const targetUserId = interaction.customId.slice(SHIPPING_MODAL_USER_PREFIX.length);
    await applyShippingUpdate(interaction, targetUserId);
  }
}

export function getBuyerShippingSummary(userId) {
  return buyerDetailsFromRow(getBuyer(userId));
}

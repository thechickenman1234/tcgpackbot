import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { config } from '../config.js';
import { parseCityStateZip } from '../utils/claimParser.js';
import { hasBannedRole } from '../utils/permissions.js';
import {
  buyerDetailsFromRow,
  getBuyer,
  hasCompleteShippingDetails,
  isBuyerBanned,
  updateBuyerDetails,
} from '../services/buyerService.js';
import { getProductById } from '../services/productService.js';
import {
  checkBuyerPurchaseLimit,
  fulfillClaim,
  formatLimitRejectMessage,
} from '../services/claimService.js';
import { CLAIM_SELECT_ID, buildClaimSelectRow } from '../ui/claimSelect.js';
import { CLAIM_MODAL_PREFIX } from '../ui/customIds.js';

export { CLAIM_SELECT_ID, CLAIM_MODAL_PREFIX, buildClaimSelectRow };

function buildClaimModal(productId, includeShipping) {
  const modal = new ModalBuilder()
    .setCustomId(`${CLAIM_MODAL_PREFIX}${productId}`)
    .setTitle(includeShipping ? 'Claim + shipping' : 'Claim quantity');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('quantity')
        .setLabel('Quantity')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(3)
        .setPlaceholder('e.g. 2'),
    ),
  );

  if (includeShipping) {
    modal.addComponents(
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
          .setCustomId('city_state_zip')
          .setLabel('City, State, ZIP')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(120)
          .setPlaceholder('Melbourne, VIC, 3000'),
      ),
    );
  }

  return modal;
}

export async function handleClaimSelect(interaction) {
  if (interaction.channelId !== config.claimsChannelId) {
    await interaction.reply({
      content: 'Claims can only be started from the claims channel stock post.',
      ephemeral: true,
    });
    return;
  }

  if (hasBannedRole(interaction.member) || isBuyerBanned(interaction.user.id)) {
    await interaction.reply({ content: 'You cannot claim right now.', ephemeral: true });
    return;
  }

  const productId = Number(interaction.values[0]);
  const product = getProductById(productId);

  if (!product || !product.active) {
    await interaction.reply({ content: 'That product is no longer available.', ephemeral: true });
    return;
  }

  if (product.quantity_available <= 0) {
    await interaction.reply({ content: `\`${product.name}\` is sold out.`, ephemeral: true });
    return;
  }

  const limitCheck = checkBuyerPurchaseLimit(interaction.user.id, product, 1);
  if (!limitCheck.ok && limitCheck.remaining <= 0) {
    await interaction.reply({
      content: formatLimitRejectMessage(product.name, limitCheck),
      ephemeral: true,
    });
    return;
  }

  const includeShipping = !hasCompleteShippingDetails(interaction.user.id);
  await interaction.showModal(buildClaimModal(productId, includeShipping));
}

export async function handleClaimModalSubmit(interaction) {
  const productId = Number(interaction.customId.slice(CLAIM_MODAL_PREFIX.length));
  const product = getProductById(productId);

  if (!product || !product.active) {
    await interaction.reply({ content: 'That product is no longer available.', ephemeral: true });
    return;
  }

  if (hasBannedRole(interaction.member) || isBuyerBanned(interaction.user.id)) {
    await interaction.reply({ content: 'You cannot claim right now.', ephemeral: true });
    return;
  }

  const quantityRaw = interaction.fields.getTextInputValue('quantity').trim();
  const quantity = Number(quantityRaw);

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    await interaction.reply({ content: 'Quantity must be a whole number between 1 and 100.', ephemeral: true });
    return;
  }

  if (product.quantity_available < quantity) {
    await interaction.reply({
      content: product.quantity_available <= 0
        ? `\`${product.name}\` is sold out.`
        : `Only ${product.quantity_available} left of \`${product.name}\`.`,
      ephemeral: true,
    });
    return;
  }

  const limitCheck = checkBuyerPurchaseLimit(interaction.user.id, product, quantity);
  if (!limitCheck.ok) {
    await interaction.reply({
      content: formatLimitRejectMessage(product.name, limitCheck),
      ephemeral: true,
    });
    return;
  }

  let shippingDetails = buyerDetailsFromRow(getBuyer(interaction.user.id));

  if (!shippingDetails) {
    try {
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

      updateBuyerDetails(interaction.user.id, {
        name,
        phone,
        shippingAddress: address,
        city,
        state,
        zip,
      });
      shippingDetails = {
        name,
        phone,
        shippingAddress: address,
        city,
        state,
        zip,
      };
    } catch {
      await interaction.reply({
        content: 'Shipping details are required for your first claim. Try again from the dropdown.',
        ephemeral: true,
      });
      return;
    }
  }

  const channel = interaction.channel?.isTextBased()
    ? interaction.channel
    : await interaction.client.channels.fetch(config.claimsChannelId);

  if (!channel?.isTextBased()) {
    await interaction.reply({ content: 'Could not access the claims channel.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const result = await fulfillClaim({
    channel,
    buyerUser: interaction.user,
    product,
    quantity,
    shippingDetails,
  });

  if (!result.ok) {
    if (result.reason === 'sold_out') {
      await interaction.editReply(`\`${product.name}\` is sold out.`);
    } else if (result.reason === 'limit') {
      await interaction.editReply(formatLimitRejectMessage(product.name, result));
    } else if (result.reason === 'thread_failed') {
      await interaction.editReply('Claim saved but the private thread failed — staff will follow up.');
    } else {
      await interaction.editReply('Could not complete that claim. Try again or ping staff.');
    }
    return;
  }

  if (result.toppedUp) {
    const threadMention = result.thread?.id ? ` → <#${result.thread.id}>` : '';
    await interaction.editReply(
      `Claim updated: **+${result.added}** → **${result.order.quantity}x ${product.name}**. New total is in your ticket${threadMention}.`,
    );
    return;
  }

  await interaction.editReply(
    `Claim locked: **${quantity}x ${product.name}**. Check your private thread for PayID details → <#${result.thread.id}>`,
  );
}

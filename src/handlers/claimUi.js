import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import { config } from '../config.js';
import { formatAud, hasBannedRole } from '../utils/permissions.js';
import {
  getBuyer,
  hasCompleteShippingDetails,
  isBuyerBanned,
  updateBuyerDetails,
} from '../services/buyerService.js';
import { getProductById, listActiveProducts } from '../services/productService.js';
import { fulfillClaim } from '../services/claimService.js';

export const CLAIM_SELECT_ID = 'claim_select';
export const CLAIM_MODAL_PREFIX = 'claim_modal:';

export function buildClaimSelectRow(products = listActiveProducts()) {
  const options = products.slice(0, 25).map((p) => ({
    label: p.name.slice(0, 100),
    description: `${formatAud(p.price_cents)} · ${p.quantity_available} left`.slice(0, 100),
    value: String(p.id),
  }));

  if (!options.length) return null;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(CLAIM_SELECT_ID)
      .setPlaceholder('Claim a product…')
      .addOptions(options),
  );
}

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
          .setLabel('Shipping address')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500),
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
    // Silent-ish block (ephemeral so they know the select didn't hang)
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

  let shippingDetails = null;
  const buyer = getBuyer(interaction.user.id);

  if (hasCompleteShippingDetails(buyer)) {
    shippingDetails = {
      name: buyer.name,
      phone: buyer.phone,
      shippingAddress: buyer.shipping_address,
    };
  } else {
    try {
      const name = interaction.fields.getTextInputValue('full_name').trim();
      const phone = interaction.fields.getTextInputValue('phone').trim();
      const address = interaction.fields.getTextInputValue('address').trim();
      updateBuyerDetails(interaction.user.id, {
        name,
        phone,
        shippingAddress: address,
      });
      shippingDetails = { name, phone, shippingAddress: address };
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
    if (result.reason === 'duplicate') {
      await interaction.editReply(
        `You already have an open claim for \`${product.name}\` (${result.existing.reference_code}).`,
      );
    } else if (result.reason === 'sold_out') {
      await interaction.editReply(`\`${product.name}\` is sold out.`);
    } else if (result.reason === 'thread_failed') {
      await interaction.editReply('Claim saved but the private thread failed — staff will follow up.');
    } else {
      await interaction.editReply('Could not complete that claim. Try again or ping staff.');
    }
    return;
  }

  await interaction.editReply(
    `Claim locked: **${quantity}x ${product.name}**. Check your private thread for PayID details → <#${result.thread.id}>`,
  );
}

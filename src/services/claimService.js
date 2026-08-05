import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} from 'discord.js';
import { config } from '../config.js';
import { parseClaim, looksLikeClaimAttempt } from '../utils/claimParser.js';
import { formatAud, hasBannedRole } from '../utils/permissions.js';
import { getBuyer, hasCompleteShippingDetails, isBuyerBanned } from './buyerService.js';
import { findActiveProductByName } from './productService.js';
import { attachThread, createClaimOrder } from './orderService.js';
import { buildPaymentEmbed } from './paymentEmbed.js';

async function briefReply(message, text) {
  try {
    const reply = await message.reply({ content: text });
    setTimeout(() => reply.delete().catch(() => {}), 8000);
  } catch {
    // ignore
  }
}

/**
 * Create order + private thread. Posts PayID immediately when shipping details exist;
 * otherwise posts the intake-form fallback button.
 */
export async function fulfillClaim({
  channel,
  buyerUser,
  product,
  quantity,
  claimMessageId = null,
  shippingDetails = null,
}) {
  const created = createClaimOrder({
    buyerId: buyerUser.id,
    product,
    quantity,
    claimMessageId,
  });

  if (!created.ok) {
    return { ok: false, reason: created.reason, existing: created.existing };
  }

  const order = created.order;
  const threadName = `${order.reference_code} · ${buyerUser.username}`.slice(0, 100);

  let thread;
  try {
    thread = await channel.threads.create({
      name: threadName,
      type: ChannelType.PrivateThread,
      invitable: false,
      reason: `Claim ticket ${order.reference_code}`,
    });
  } catch (err) {
    console.error('Failed to create private thread:', err);
    return { ok: false, reason: 'thread_failed', order };
  }

  attachThread(order.id, thread.id);

  try {
    await thread.members.add(buyerUser.id);
  } catch (err) {
    console.error('Failed to add buyer to thread:', err);
  }

  const details = shippingDetails ?? (() => {
    const buyer = getBuyer(buyerUser.id);
    if (!hasCompleteShippingDetails(buyer)) return null;
    return {
      name: buyer.name,
      phone: buyer.phone,
      shippingAddress: buyer.shipping_address,
    };
  })();

  try {
    if (details) {
      await thread.send({
        content: [
          `<@${buyerUser.id}> · <@&${config.staffRoleId}>`,
          `**Claim locked:** ${order.quantity}x **${order.product_name}** (${formatAud(order.total_cents)})`,
          `Order: \`${order.reference_code}\``,
        ].join('\n'),
        embeds: [buildPaymentEmbed(order, details)],
      });
    } else {
      await thread.send({
        content: [
          `<@${buyerUser.id}> · <@&${config.staffRoleId}>`,
          `**Claim locked:** ${order.quantity}x **${order.product_name}** (${formatAud(order.total_cents)})`,
          `Order: \`${order.reference_code}\``,
          '',
          'Open the intake form below to receive PayID payment details.',
        ].join('\n'),
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`intake:${order.id}`)
              .setLabel('Open intake form')
              .setStyle(ButtonStyle.Primary),
          ),
        ],
      });
    }
  } catch (err) {
    console.error('Failed to send thread opener:', err);
  }

  return { ok: true, order, thread };
}

export async function handleClaimMessage(message) {
  if (message.author.bot) return;
  if (message.channelId !== config.claimsChannelId) return;

  const content = message.content?.trim() ?? '';
  if (!looksLikeClaimAttempt(content)) return;

  const parsed = parseClaim(content);
  if (!parsed) {
    await briefReply(
      message,
      'Invalid format. Prefer the dropdown on the stock post, or use: `claim [quantity]x [product]`',
    );
    return;
  }

  const member = message.member;
  if (hasBannedRole(member) || isBuyerBanned(message.author.id)) {
    return;
  }

  const product = findActiveProductByName(parsed.productName);
  if (!product) {
    await briefReply(message, `Unknown product: \`${parsed.productName}\`. Use the dropdown on the stock post.`);
    return;
  }

  if (product.quantity_available < parsed.quantity) {
    await briefReply(
      message,
      product.quantity_available <= 0
        ? `\`${product.name}\` is sold out.`
        : `Only ${product.quantity_available} left of \`${product.name}\`.`,
    );
    return;
  }

  const result = await fulfillClaim({
    channel: message.channel,
    buyerUser: message.author,
    product,
    quantity: parsed.quantity,
    claimMessageId: message.id,
  });

  if (!result.ok) {
    if (result.reason === 'duplicate') {
      await briefReply(
        message,
        `You already have an open claim for \`${product.name}\` (${result.existing.reference_code}).`,
      );
    } else if (result.reason === 'sold_out') {
      await briefReply(message, `\`${product.name}\` is sold out.`);
    } else if (result.reason === 'thread_failed') {
      await briefReply(message, 'Claim accepted in DB but thread creation failed — staff will follow up.');
    }
    return;
  }

  try {
    await message.react('✅');
  } catch {
    // ignore
  }
}

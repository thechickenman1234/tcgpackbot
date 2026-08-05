import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} from 'discord.js';
import { config } from '../config.js';
import { parseClaim, looksLikeClaimAttempt } from '../utils/claimParser.js';
import { formatAud, hasBannedRole } from '../utils/permissions.js';
import {
  buyerDetailsFromRow,
  getBuyer,
  isBuyerBanned,
} from './buyerService.js';
import {
  findActiveProductByName,
  getProductById,
  listActiveProducts,
} from './productService.js';
import { attachThread, createClaimOrder } from './orderService.js';
import { buildPaymentEmbed } from './paymentEmbed.js';
import { handlePostClaimSaleState } from './saleAnnouncements.js';

async function briefReply(message, text) {
  try {
    const reply = await message.reply({ content: text });
    setTimeout(() => reply.delete().catch(() => {}), 8000);
  } catch {
    // ignore
  }
}

export function resolveClaimProduct(productName) {
  if (productName) {
    const product = findActiveProductByName(productName);
    if (!product) return { ok: false, reason: 'unknown', productName };
    return { ok: true, product };
  }

  const active = listActiveProducts().filter((p) => p.quantity_available > 0);
  if (active.length === 1) return { ok: true, product: active[0] };
  if (active.length === 0) return { ok: false, reason: 'no_sale' };
  return { ok: false, reason: 'need_product' };
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

  const details = shippingDetails ?? buyerDetailsFromRow(getBuyer(buyerUser.id));

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

  await handlePostClaimSaleState(channel, getProductById(product.id));

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
      'Could not read that claim. Use the stockpost dropdown, or e.g. `claim 2x mega dream` / `claim 2`',
    );
    return;
  }

  const member = message.member;
  if (hasBannedRole(member) || isBuyerBanned(message.author.id)) {
    return;
  }

  const resolved = resolveClaimProduct(parsed.productName);
  if (!resolved.ok) {
    if (resolved.reason === 'unknown') {
      await briefReply(message, `Unknown product: \`${resolved.productName}\`. Use the dropdown on the stock post.`);
    } else if (resolved.reason === 'no_sale') {
      await briefReply(message, 'No active claim sale right now.');
    } else {
      await briefReply(message, 'Multiple products are live — include the product name, or use the dropdown.');
    }
    return;
  }

  const product = resolved.product;

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

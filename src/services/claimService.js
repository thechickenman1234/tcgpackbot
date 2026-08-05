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
  getProductMaxPerBuyer,
  listActiveProducts,
} from './productService.js';
import {
  attachThread,
  createClaimOrder,
  getBuyerClaimedQuantity,
} from './orderService.js';
import { buildPaymentEmbed } from './paymentEmbed.js';
import { handlePostClaimSaleState } from './saleAnnouncements.js';
import { UPDATE_SHIPPING_BUTTON_PREFIX } from '../ui/customIds.js';

export { UPDATE_SHIPPING_BUTTON_PREFIX };

export function checkBuyerPurchaseLimit(buyerId, product, quantity) {
  const maxPerBuyer = getProductMaxPerBuyer(product);
  if (maxPerBuyer == null) return { ok: true };

  const already = getBuyerClaimedQuantity(buyerId, product.id);
  const remaining = Math.max(0, maxPerBuyer - already);
  if (already + quantity > maxPerBuyer) {
    return { ok: false, maxPerBuyer, already, remaining };
  }
  return { ok: true, maxPerBuyer, already, remaining };
}

export function formatLimitRejectMessage(productName, limit) {
  if (limit.remaining <= 0) {
    return `Limit reached for \`${productName}\`: max **${limit.maxPerBuyer}** per person.`;
  }
  return `Limit for \`${productName}\` is **${limit.maxPerBuyer}** per person — you can claim up to **${limit.remaining}** more.`;
}

function shippingUpdateRow(orderId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${UPDATE_SHIPPING_BUTTON_PREFIX}${orderId}`)
      .setLabel('Update shipping')
      .setStyle(ButtonStyle.Secondary),
  );
}

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

async function postTopUpUpdate(order, buyerUser, added, shippingDetails) {
  if (!order.thread_id) return null;

  try {
    const thread = await buyerUser.client.channels.fetch(order.thread_id);
    if (!thread?.isThread()) return null;

    const details = shippingDetails ?? buyerDetailsFromRow(getBuyer(buyerUser.id));
    await thread.send({
      content: [
        `<@${buyerUser.id}> · <@&${config.staffRoleId}>`,
        `**Claim updated:** +${added} → now **${order.quantity}x ${order.product_name}** (${formatAud(order.total_cents)})`,
        `Order: \`${order.reference_code}\` — pay the **new total** below.`,
      ].join('\n'),
      embeds: details ? [buildPaymentEmbed(order, details)] : [],
      components: [shippingUpdateRow(order.id)],
    });
    return thread;
  } catch (err) {
    console.error('Failed to post top-up update:', err);
    return null;
  }
}

/**
 * Create order + private thread, or top up an existing pending claim.
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
    return {
      ok: false,
      reason: created.reason,
      existing: created.existing,
      maxPerBuyer: created.maxPerBuyer,
      already: created.already,
      remaining: created.remaining,
    };
  }

  const order = created.order;

  if (created.toppedUp) {
    const thread = await postTopUpUpdate(order, buyerUser, created.added, shippingDetails);
    await handlePostClaimSaleState(channel, getProductById(product.id));
    return { ok: true, order, thread, toppedUp: true, added: created.added };
  }

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
        components: [shippingUpdateRow(order.id)],
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

  return { ok: true, order, thread, toppedUp: false };
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

  const limitCheck = checkBuyerPurchaseLimit(message.author.id, product, parsed.quantity);
  if (!limitCheck.ok) {
    await briefReply(message, formatLimitRejectMessage(product.name, limitCheck));
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
    if (result.reason === 'sold_out') {
      await briefReply(message, `\`${product.name}\` is sold out.`);
    } else if (result.reason === 'limit') {
      await briefReply(message, formatLimitRejectMessage(product.name, result));
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

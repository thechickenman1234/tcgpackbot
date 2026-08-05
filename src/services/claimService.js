import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} from 'discord.js';
import { config } from '../config.js';
import { parseClaim, looksLikeClaimAttempt } from '../utils/claimParser.js';
import { formatAud, hasBannedRole } from '../utils/permissions.js';
import { isBuyerBanned } from './buyerService.js';
import { findActiveProductByName } from './productService.js';
import { attachThread, createClaimOrder } from './orderService.js';

async function briefReply(message, text) {
  try {
    const reply = await message.reply({ content: text });
    setTimeout(() => reply.delete().catch(() => {}), 8000);
  } catch {
    // ignore
  }
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
      'Invalid format. Use: `claim [quantity]x [product]` — e.g. `claim 2x mega dream`',
    );
    return;
  }

  const member = message.member;
  if (hasBannedRole(member) || isBuyerBanned(message.author.id)) {
    // Silent block for banned buyers
    return;
  }

  const product = findActiveProductByName(parsed.productName);
  if (!product) {
    await briefReply(message, `Unknown product: \`${parsed.productName}\`. Check the stock post for exact names.`);
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

  const created = createClaimOrder({
    buyerId: message.author.id,
    product,
    quantity: parsed.quantity,
    claimMessageId: message.id,
  });

  if (!created.ok) {
    if (created.reason === 'duplicate') {
      await briefReply(
        message,
        `You already have an open claim for \`${product.name}\` (${created.existing.reference_code}).`,
      );
    } else if (created.reason === 'sold_out') {
      await briefReply(message, `\`${product.name}\` is sold out.`);
    }
    return;
  }

  const order = created.order;

  try {
    await message.react('✅');
  } catch {
    // reaction permission missing — continue
  }

  const threadName = `${order.reference_code} · ${message.author.username}`.slice(0, 100);

  let thread;
  try {
    thread = await message.channel.threads.create({
      name: threadName,
      type: ChannelType.PrivateThread,
      invitable: false,
      reason: `Claim ticket ${order.reference_code}`,
    });
  } catch (err) {
    console.error('Failed to create private thread:', err);
    await briefReply(message, 'Claim accepted in DB but thread creation failed — staff will follow up.');
    return;
  }

  attachThread(order.id, thread.id);

  try {
    await thread.members.add(message.author.id);
  } catch (err) {
    console.error('Failed to add buyer to thread:', err);
  }

  // Add staff role members is heavy; private threads with staff role access
  // rely on staff opening via thread list / bot mentioning staff role once.
  try {
    await thread.send({
      content: [
        `<@${message.author.id}> · <@&${config.staffRoleId}>`,
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
  } catch (err) {
    console.error('Failed to send thread intake prompt:', err);
  }
}

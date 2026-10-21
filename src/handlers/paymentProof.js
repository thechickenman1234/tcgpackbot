import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { config } from '../config.js';
import { addHoursIso, formatAud, isStaff } from '../utils/permissions.js';
import {
  clearProof,
  getOrderById,
  getOrderByThreadId,
  getOverdueHeldOrders,
  markOverduePinged,
  markPaid,
  markProofPosted,
} from '../services/orderService.js';
import { pushToSheetInBackground } from '../services/sheetService.js';
import { grantBuyerRole } from '../services/buyerRoleService.js';
import { sendPaidInvoice } from './invoiceMaker.js';

// Buyers often pay and post the screenshot while nobody from staff is
// online to run /paid. A screenshot in the ticket now holds the order (no
// auto-cancel, no ban) and puts Paid / Not paid buttons under it, in the
// ticket and in the staff log, so it can be confirmed with one press.
export const PAYPROOF_PREFIX = 'payproof:';

// After Not paid, a buyer whose deadline has already gone (or is about to)
// gets at least this long to send the right screenshot.
const RETRY_HOURS = 2;

const IMAGE_NAME = /\.(png|jpe?g|webp|gif|heic|heif)$/i;

function isImage(attachment) {
  return attachment.contentType?.startsWith('image/') || IMAGE_NAME.test(attachment.name || '');
}

function unix(iso) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function proofButtons(orderId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PAYPROOF_PREFIX}paid:${orderId}`)
      .setLabel('Paid (staff)')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${PAYPROOF_PREFIX}unpaid:${orderId}`)
      .setLabel('Not paid (staff)')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  );
}

/**
 * Everything marking an order paid does, shared by /paid and the Paid
 * button: the status, the accounting sheet and the Buyer role. The invoice
 * is sent separately, after the confirmation line, so it lands under it.
 */
export async function confirmPaid(client, order) {
  const result = markPaid(order.id);
  if (!result.ok) return result;
  pushToSheetInBackground([result.order], 'paid');
  const gotRole = await grantBuyerRole(client, order.buyer_id);
  return { ok: true, order: result.order, gotRole };
}

async function logProofToStaff(client, order, message, image) {
  try {
    const channel = await client.channels.fetch(config.staffLogChannelId);
    if (!channel?.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setTitle(`📸 Payment screenshot: ${order.reference_code}`)
      .setColor(0xf1c40f)
      .setDescription(`<@${order.buyer_id}> posted a payment screenshot. Their claim is on hold (no ban) until you press Paid or Not paid.`)
      .addFields(
        { name: 'Order', value: `${order.quantity}x ${order.product_name}`, inline: true },
        { name: 'Should be', value: formatAud(order.total_cents), inline: true },
        { name: 'Ticket', value: message.url, inline: false },
      )
      .setImage(image.url)
      .setTimestamp();
    await channel.send({ embeds: [embed], components: [proofButtons(order.id)] });
  } catch (err) {
    console.error('Failed to log payment screenshot:', err.message);
  }
}

/**
 * Deadline job: a held order that reaches its deadline still unchecked pings
 * staff once in the staff log, with the buttons, so it doesn't sit forever.
 */
export async function pingOverdueProofs(client) {
  const overdue = getOverdueHeldOrders();
  if (!overdue.length) return;
  let channel;
  try {
    channel = await client.channels.fetch(config.staffLogChannelId);
  } catch (err) {
    console.error('Overdue screenshot ping: no staff log channel:', err.message);
    return;
  }
  if (!channel?.isTextBased()) return;

  for (const order of overdue) {
    const screenshot = order.thread_id && order.proof_message_id
      ? `https://discord.com/channels/${config.guildId}/${order.thread_id}/${order.proof_message_id}`
      : null;
    try {
      await channel.send({
        content: [
          `<@&${config.staffRoleId}> ⏰ **${order.reference_code}** is past its payment deadline, `
            + `but <@${order.buyer_id}> sent a payment screenshot that hasn't been checked yet.`,
          `${order.quantity}x ${order.product_name}, should be **${formatAud(order.total_cents)}**.`
            + (screenshot ? ` Screenshot: ${screenshot}` : ''),
          'Their claim stays on hold until you press one of these:',
        ].join('\n'),
        components: [proofButtons(order.id)],
        allowedMentions: { roles: [config.staffRoleId] },
      });
      markOverduePinged(order.id);
      console.log(`Overdue screenshot ping: ${order.reference_code}`);
    } catch (err) {
      console.error(`Overdue screenshot ping failed for ${order.reference_code}:`, err.message);
    }
  }
}

/** messageCreate: a buyer posting an image in their own pending ticket. */
export async function handlePaymentProofMessage(message) {
  if (message.author.bot || !message.channel?.isThread?.()) return;
  const image = message.attachments.find(isImage);
  if (!image) return;

  const order = getOrderByThreadId(message.channelId);
  if (!order || order.status !== 'pending' || order.buyer_id !== message.author.id) return;
  // A second screenshot while the first is still waiting changes nothing.
  if (!markProofPosted(order.id, message.id)) return;

  try {
    await message.reply({
      content: [
        `📸 Got your payment screenshot for \`${order.reference_code}\`, thanks!`,
        'Your claim is safe while we check it: it won\'t expire and you won\'t be banned. '
          + 'You\'ll see ✅ here once staff confirm the payment.',
      ].join('\n'),
      components: [proofButtons(order.id)],
      allowedMentions: { repliedUser: false },
    });
  } catch (err) {
    console.error(`Failed to answer screenshot in ${order.reference_code}:`, err.message);
  }

  await logProofToStaff(message.client, order, message, image);
  console.log(`Payment screenshot held: ${order.reference_code}`);
}

async function postToThread(client, order, payload) {
  if (!order.thread_id) return;
  try {
    const thread = await client.channels.fetch(order.thread_id);
    if (thread?.isTextBased?.()) await thread.send(payload);
  } catch (err) {
    console.error(`Failed to post in ticket ${order.reference_code}:`, err.message);
  }
}

/** The Paid / Not paid buttons, in the ticket or the staff log. */
export async function handlePaymentProofButton(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Only staff can confirm payments.', ephemeral: true });
    return;
  }

  const [, action, orderIdRaw] = interaction.customId.split(':');
  const order = getOrderById(Number(orderIdRaw));
  const staff = `<@${interaction.user.id}>`;
  const stamp = (line) => (interaction.message.content ? `${interaction.message.content}\n\n${line}` : line);

  // Already settled, from the other copy of these buttons or with /paid.
  if (!order || order.status !== 'pending') {
    await interaction.update({ components: [] });
    await interaction.followUp({
      content: order ? `\`${order.reference_code}\` is already **${order.status}**, nothing to do.` : 'Order not found.',
      ephemeral: true,
    });
    return;
  }

  if (action === 'paid') {
    // The Buyer role can take a moment, longer than Discord waits for a click.
    await interaction.deferUpdate();
    const result = await confirmPaid(interaction.client, order);
    if (!result.ok) {
      await interaction.followUp({ content: `Cannot mark paid (status: \`${order.status}\`).`, ephemeral: true });
      return;
    }
    await interaction.editReply({
      content: stamp(`✅ **Paid**, confirmed by ${staff}.`),
      components: [],
      allowedMentions: { parse: [] },
    });
    await postToThread(interaction.client, order, {
      content: `✅ <@${order.buyer_id}> payment confirmed for **${order.reference_code}** (${formatAud(order.total_cents)}). Thanks!`
        + (result.gotRole ? '\n🏅 Buyer role given.' : ''),
    });
    await sendPaidInvoice(interaction.client, result.order);
    return;
  }

  if (action === 'unpaid') {
    if (!order.proof_at) {
      await interaction.update({ components: [] });
      await interaction.followUp({
        content: `\`${order.reference_code}\` was already marked not paid. Waiting for a new screenshot.`,
        ephemeral: true,
      });
      return;
    }
    const updated = clearProof(order.id, addHoursIso(RETRY_HOURS));
    const deadline = unix(updated.payment_deadline_at);
    await interaction.update({
      content: stamp(`❌ **Not paid**, marked by ${staff}. The buyer has until <t:${deadline}:F> to send the right screenshot.`),
      components: [],
      allowedMentions: { parse: [] },
    });
    await postToThread(interaction.client, order, {
      content: [
        `❌ <@${order.buyer_id}> we couldn't find your payment for \`${order.reference_code}\` yet.`,
        'Please check the payment went through for the full amount in the payment details above, '
          + `with \`${order.reference_code}\` in the description, then **post a screenshot of that payment here**.`,
        `If it isn't here by <t:${deadline}:F> (<t:${deadline}:R>), the claim is cancelled and you'll be banned from future claim sales.`,
      ].join('\n'),
    });
  }
}

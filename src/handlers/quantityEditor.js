import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { config } from '../config.js';
import { formatAud, isStaff } from '../utils/permissions.js';
import { buyerDetailsFromRow, getBuyer } from '../services/buyerService.js';
import { changeOrderQuantity, getOrderById, getOrderByThreadId } from '../services/orderService.js';
import { buildPaymentEmbed } from '../services/paymentEmbed.js';
import { pushToSheetInBackground } from '../services/sheetService.js';
import { logToStaff } from '../services/staffLog.js';
import { QTY_PREFIX } from '../ui/customIds.js';

/**
 * Change quantity: staff fix how many an order is for in two taps, from the
 * button on the ticket or, in a ticket made before the button existed, by
 * long-pressing any message and picking Apps → Change quantity. A pop-up
 * asks for the number; stock, total and label follow, and the buyer is told
 * in their ticket what they now owe.
 */

export { QTY_PREFIX };
export const QTY_CONTEXT_MENU = 'Change quantity';

async function showModal(interaction, order) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Only staff can change an order.', ephemeral: true });
    return;
  }
  if (!order) {
    await interaction.reply({ content: 'No order found for this ticket.', ephemeral: true });
    return;
  }
  if (!['pending', 'paid'].includes(order.status)) {
    await interaction.reply({ content: `\`${order.reference_code}\` is **${order.status}**, so it can't change any more.`, ephemeral: true });
    return;
  }
  await interaction.showModal(new ModalBuilder()
    .setCustomId(`${QTY_PREFIX}m:${order.id}`)
    .setTitle(`${order.reference_code}: ${order.product_name}`.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('qty')
      .setLabel(`How many? (now ${order.quantity})`)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(4)
      .setValue(String(order.quantity)))));
}

/** The button on the ticket: qty:<orderId>. */
export async function handleQuantityButton(interaction) {
  await showModal(interaction, getOrderById(Number(interaction.customId.slice(QTY_PREFIX.length))));
}

/** Long-press a message in a ticket → Apps → Change quantity. */
export async function handleQuantityContextMenu(interaction) {
  await showModal(interaction, interaction.channel?.isThread() ? getOrderByThreadId(interaction.channelId) : null);
}

/** What the buyer reads in their ticket after the change. */
function buyerMessage(order, before) {
  const head = `✏️ <@${order.buyer_id}> Your order is now **${order.quantity}x ${order.product_name}** (was ${before.quantity}).`;
  if (order.status === 'pending') {
    return `${head} New total **${formatAud(order.total_cents)}**: pay this amount, using the details below.`;
  }
  const change = order.total_cents - before.total_cents;
  if (change > 0) {
    return `${head} You've paid ${formatAud(before.total_cents)}, so there's **${formatAud(change)} more** to pay`
      + ` (PayID ${config.payId}). 📸 Post a screenshot here once it's sent.`;
  }
  if (change < 0) return `${head} You've paid ${formatAud(before.total_cents)}, so we'll refund the **${formatAud(-change)}** difference.`;
  return head;
}

export async function handleQuantityModal(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Only staff can change an order.', ephemeral: true });
    return;
  }
  const orderId = Number(interaction.customId.split(':')[2]);
  const qty = Number(interaction.fields.getTextInputValue('qty').trim());
  if (!Number.isInteger(qty) || qty < 1) {
    await interaction.reply({ content: 'Type a whole number, 1 or more.', ephemeral: true });
    return;
  }

  const result = changeOrderQuantity(orderId, qty);
  if (!result.ok) {
    const why = result.reason === 'invalid_status' ? `it's ${result.order.status} now` : 'that order is gone';
    await interaction.reply({ content: `Couldn't change it: ${why}.`, ephemeral: true });
    return;
  }
  if (!result.diff) {
    await interaction.reply({ content: `It's already ${qty}. Nothing changed.`, ephemeral: true });
    return;
  }

  const { order, before } = result;
  const notes = [`✅ \`${order.reference_code}\` is now **${order.quantity}x ${order.product_name}**, total ${formatAud(order.total_cents)}.`,
    `Stock ${result.diff > 0 ? `down ${result.diff}` : `back up ${-result.diff}`}. The label will say ${order.quantity}x.`];
  if (order.label_batch_id) notes.push('Its label was already printed: reprint that batch from the shipping panel.');
  await interaction.reply({ content: notes.join('\n'), ephemeral: true });

  if (order.thread_id) {
    try {
      const thread = await interaction.client.channels.fetch(order.thread_id);
      const details = buyerDetailsFromRow(getBuyer(order.buyer_id));
      await thread.send({
        content: buyerMessage(order, before),
        embeds: order.status === 'pending' && details ? [buildPaymentEmbed(order, details)] : [],
      });
    } catch (err) {
      console.error(`Change quantity: could not post in ticket ${order.thread_id}:`, err.message);
    }
  }
  pushToSheetInBackground([order], 'quantity');
  logToStaff(interaction.client, {
    title: 'Order quantity changed',
    description: `\`${order.reference_code}\` ${before.quantity}x → **${order.quantity}x ${order.product_name}** `
      + `(${formatAud(before.total_cents)} → ${formatAud(order.total_cents)}) by <@${interaction.user.id}>`,
    color: 0x5865f2,
  });
}

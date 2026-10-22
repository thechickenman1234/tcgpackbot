import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { isStaff } from '../utils/permissions.js';
import { getBuyer } from '../services/buyerService.js';
import {
  getOrderById,
  getOrderByReference,
  getOrderByThreadId,
  listOpenOrders,
  setLabelReference,
} from '../services/orderService.js';
import { defaultLabelReference, labelReferenceFor } from '../services/labelText.js';
import { pushToSheetInBackground } from '../services/sheetService.js';

// /label: change what an order's shipping label says, so a parcel whose
// order changed after claiming gets packed right. Opens a pop-up with the
// label's current text; clearing it goes back to the default.
export const LABEL_PREFIX = 'labelref:';
const MAX_LEN = 100;
const EDITABLE = ['pending', 'paid'];

function resolveOrder(interaction) {
  const ref = interaction.options.getString('reference');
  if (ref) return getOrderByReference(ref.trim().toUpperCase());
  if (interaction.channel?.isThread()) return getOrderByThreadId(interaction.channelId);
  return null;
}

export async function handleLabelCommand(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const order = resolveOrder(interaction);
  if (!order) {
    await interaction.reply({ content: 'Order not found. Run this inside the ticket, or pick the order in `reference`.', ephemeral: true });
    return;
  }
  if (!EDITABLE.includes(order.status)) {
    await interaction.reply({ content: `\`${order.reference_code}\` is **${order.status}**, so its label can't change any more.`, ephemeral: true });
    return;
  }

  const input = new TextInputBuilder()
    .setCustomId('text')
    .setLabel('Reference on the label')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(MAX_LEN)
    .setPlaceholder(defaultLabelReference(order).slice(0, 100))
    .setValue(labelReferenceFor(order).slice(0, MAX_LEN));

  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`${LABEL_PREFIX}${order.id}`)
      .setTitle(`Label for ${order.reference_code}`.slice(0, 45))
      .addComponents(new ActionRowBuilder().addComponents(input)),
  );
}

export async function handleLabelModal(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const order = getOrderById(Number(interaction.customId.slice(LABEL_PREFIX.length)));
  if (!order || !EDITABLE.includes(order.status)) {
    await interaction.reply({ content: 'That order can no longer be changed.', ephemeral: true });
    return;
  }

  const text = interaction.fields.getTextInputValue('text').trim();
  const fallback = defaultLabelReference(order);
  const custom = text && text !== fallback ? text : null;
  const updated = setLabelReference(order.id, custom);
  pushToSheetInBackground([updated], 'label');

  const lines = custom
    ? [`🏷️ The label for **${order.reference_code}** now reads:`, `\`${custom}\``]
    : [`🏷️ The label for **${order.reference_code}** is back to the default:`, `\`${fallback}\``];
  if (order.label_batch_id) lines.push('It was already printed, so reprint its batch from the shipping panel to get the new label.');
  await interaction.reply({ content: lines.join('\n'), ephemeral: true });
}

/** Autocomplete for /label reference: open orders, newest first, matched on ref, product or buyer. */
export async function labelAutocomplete(interaction, typed) {
  const choices = [];
  for (const o of listOpenOrders(300)) {
    const buyer = getBuyer(o.buyer_id)?.name || '';
    const name = `${o.reference_code} · ${o.quantity}x ${o.product_name}${buyer ? ` · ${buyer}` : ''}`;
    if (typed && !name.toLowerCase().includes(typed)) continue;
    choices.push({ name: name.slice(0, 100), value: o.reference_code });
    if (choices.length === 25) break;
  }
  await interaction.respond(choices);
}

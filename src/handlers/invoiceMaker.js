import {
  ActionRowBuilder,
  AttachmentBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { isStaff } from '../utils/permissions.js';
import { invoicePdf, money } from '../services/invoicePdf.js';
import { getOrderById } from '../services/orderService.js';
import {
  dateLong,
  dateShort,
  invoiceSender,
  invoiceableOrders,
  isYes,
  paidInvoiceFor,
  parseInvoiceDate,
  parseItems,
  parseShipping,
  prefillFromOrder,
  recordInvoice,
} from '../services/invoiceService.js';

/**
 * /invoice: one pop-up, one PDF.
 *
 * Pick an order and the pop-up opens already filled in from it, paid or not.
 * Leave the order out and it opens blank for anything else, like a
 * wholesale order. Either way, Submit sends back the PDF to forward.
 */

export const INVOICE_PREFIX = 'inv:';
const DUE_DAYS = 7;

function field(id, label, { value = '', placeholder = '', paragraph = false, required = true, max = 200 } = {}) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(required)
    .setMaxLength(max);
  if (placeholder) input.setPlaceholder(placeholder);
  if (value) input.setValue(String(value).slice(0, max));
  return new ActionRowBuilder().addComponents(input);
}

export async function handleInvoiceCommand(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const orderId = interaction.options.getString('order');
  const pre = orderId ? prefillFromOrder(orderId) : null;
  if (orderId && !pre) {
    await interaction.reply({ content: 'Could not find that order. Pick it from the list.', ephemeral: true });
    return;
  }

  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`inv:make:${pre ? pre.order.id : 0}`)
      .setTitle(pre ? `Invoice: ${pre.order.reference_code}` : 'New invoice')
      .addComponents(
        field('billto', 'Bill to: name, then ABN if they have one', {
          value: pre?.billTo, placeholder: 'Sam Smith\nABN 12 345 678 901', paragraph: true, max: 300,
        }),
        field('items', 'Items: one per line, qty x item @ price', {
          value: pre?.items, placeholder: '6 x 30th Anniversary booster box @ 114\n2 x Gem vol.5 @ 46', paragraph: true, max: 1500,
        }),
        field('shipping', 'Shipping (e.g. 10, or express 10)', {
          value: pre?.shipping, placeholder: 'express 10', required: false, max: 40,
        }),
        field('date', 'Invoice date (e.g. 29/9/2026, or today)', {
          value: pre?.date || dateShort(new Date()), placeholder: '29/9/2026', max: 20,
        }),
        field('paid', 'Already paid? yes or no', { value: pre?.paid || 'no', max: 5 }),
      ),
  );
}

/** Builds the PDF for a saved invoice. Unpaid invoices are due a week after their date. */
function renderPdf({ number, issued, paid, billTo, items, shipping, note }) {
  const { from, payment } = invoiceSender();
  const due = new Date(issued.getTime() + DUE_DAYS * 86400000);
  const out = invoicePdf({
    number,
    issued: dateLong(issued),
    due: dateLong(due),
    paidOn: paid ? dateLong(issued) : null,
    from,
    billTo,
    items,
    shippingCents: shipping.cents,
    shippingLabel: shipping.label,
    note,
    payment,
  });
  return { ...out, due };
}

async function makeInvoice(interaction, orderId) {
  const billTo = interaction.fields.getTextInputValue('billto').split('\n').map((l) => l.trim()).filter(Boolean);
  const { items, bad } = parseItems(interaction.fields.getTextInputValue('items'));
  const shipping = parseShipping(interaction.fields.getTextInputValue('shipping'));
  const paid = isYes(interaction.fields.getTextInputValue('paid'));
  const issued = parseInvoiceDate(interaction.fields.getTextInputValue('date'));
  // Picked from an order: say which one on the invoice, without a box for it.
  const order = Number(orderId) ? getOrderById(orderId) : null;
  const note = order ? `Order ${order.reference_code}` : '';

  const problems = [];
  if (!issued) problems.push('The **date** should look like `29/9/2026` or `today`.');
  if (!billTo.length) problems.push('**Bill to** is empty.');
  if (bad.length) problems.push(`Could not read ${bad.map((b) => `\`${b}\``).join(', ')}. Write items like \`6 x 30th bb @ 114\`.`);
  if (!items.length && !bad.length) problems.push('Add at least one item, like `6 x 30th bb @ 114`.');
  if (!shipping) problems.push('Shipping should be a number, like `10` or `express 10`.');
  if (problems.length) {
    await interaction.reply({ content: `Nothing was made. ${problems.join(' ')}\nRun \`/invoice\` again.`, ephemeral: true });
    return;
  }

  const number = recordInvoice({
    billTo: billTo.join('\n'), items, shipping, paid, note, orderId: order?.id || null,
    createdBy: interaction.user.id, issuedOn: issued,
  });
  const { pdf, totalCents, due } = renderPdf({ number, issued, paid, billTo, items, shipping, note });

  await interaction.reply({
    content: `🧾 **${number}** for **${billTo[0]}**, dated ${dateLong(issued)}: **${money(totalCents)} AUD** `
      + `${paid ? '(marked paid)' : `(due ${dateLong(due)})`}.\n`
      + 'Save the PDF below and send it to them.',
    files: [new AttachmentBuilder(pdf, { name: `invoice-${number}.pdf` })],
    ephemeral: true,
  });
}

/**
 * Called by /paid: makes a PAID invoice for the order and posts it in the
 * buyer's ticket thread. Turned off with AUTO_INVOICE=off. Returns the
 * invoice number, or null when nothing was sent. Never throws, because a
 * failed invoice must not undo or hide a payment that was recorded.
 */
export async function sendPaidInvoice(client, order) {
  if (/^(off|false|no|0)$/i.test(process.env.AUTO_INVOICE || '')) return null;
  if (!order?.thread_id) return null;
  try {
    const thread = await client.channels.fetch(order.thread_id);
    if (!thread?.isTextBased?.()) return null;
    const inv = paidInvoiceFor(order);
    const { pdf, totalCents } = renderPdf({ ...inv, paid: true });
    await thread.send({
      content: `🧾 Here's your invoice for this order: **${inv.number}**, ${money(totalCents)} AUD, paid. Thanks!`,
      files: [new AttachmentBuilder(pdf, { name: `invoice-${inv.number}.pdf` })],
      allowedMentions: { parse: [] },
    });
    return inv.number;
  } catch (err) {
    console.error(`Auto invoice for ${order.reference_code} failed:`, err.message);
    return null;
  }
}

export async function handleInvoiceInteraction(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const [, action, orderId] = interaction.customId.split(':');
  if (action === 'make') await makeInvoice(interaction, orderId);
}

export async function invoiceAutocomplete(interaction, typed) {
  await interaction.respond(invoiceableOrders(typed));
}

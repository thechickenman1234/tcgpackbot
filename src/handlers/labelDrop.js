import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import { isStaff } from '../utils/permissions.js';
import { getMeta } from '../services/metaService.js';
import { readLabelsFromFile } from '../services/labelReader.js';
import {
  getParcel,
  matchLabel,
  ordersAwaitingParcels,
  parcelMessage,
  partCorrectionMessage,
  recordParcel,
  setParcelQuantity,
} from '../services/labelParcels.js';
import { getOrderById } from '../services/orderService.js';
import { pushToSheetInBackground } from '../services/sheetService.js';
import { noteFail, noteOk } from '../services/healthService.js';

/**
 * Drop the label PDFs in the shipping channel after a post office run and
 * the bot does the rest: reads each label's tracking number, name and order
 * reference, finds the order, tells the buyer in their ticket and marks it
 * posted. Only what it can't be sure of comes back as a button to tap.
 *
 * A label with fewer units than the order (its Ref edited with /label, e.g.
 * "1x storm" on a 2x order) goes out as part of the order; so does any parcel
 * staff mark "Part only" afterwards. The buyer is told what's in this parcel
 * and what's still to come.
 */

export const LABEL_DROP_PREFIX = 'lbl:';
const FILE_TYPES = /\.(pdf|png|jpe?g)$/i;
const MAX_BYTES = 25 * 1024 * 1024;

function isLabelChannel(channel) {
  if (!channel) return false;
  if (channel.id === getMeta('shipping_panel_channel')) return true;
  return /ship|label/i.test(channel.name || '');
}

const short = (code) => (code.length > 10 ? `${code.slice(0, 4)}…${code.slice(-4)}` : code);
const orderText = (o) => `${o.reference_code} · ${o.quantity}x ${o.product_name}`;

async function tellBuyer(client, order, text) {
  if (!order.thread_id) return false;
  try {
    const thread = await client.channels.fetch(order.thread_id);
    await thread.send(text);
    return true;
  } catch (err) {
    console.error(`Label drop: could not post in ticket ${order.thread_id}:`, err.message);
    return false;
  }
}

/** Records the parcel, tells the buyer, and returns the line for the summary. */
async function applyParcel(client, order, label, qty) {
  const r = recordParcel(order.id, label.tracking, qty);
  if (r.duplicate) return { line: `↩️ ${order.buyer_name || orderText(order)}: \`${short(label.tracking)}\` was already done`, r };
  const told = await tellBuyer(client, r.order, parcelMessage(r.order, r, label.tracking));
  pushToSheetInBackground([r.order], 'tracking');
  const what = r.complete && !r.sentBefore
    ? `${r.order.quantity}x ${r.order.product_name}`
    : `${r.quantity} of ${r.order.quantity}x ${r.order.product_name}${r.complete ? ' (the rest, all sent now)' : ', rest to come'}`;
  const name = order.buyer_name || '';
  return {
    line: `✅ ${name ? `${name} · ` : ''}\`${r.order.reference_code}\` ${what} · \`${short(label.tracking)}\`${told ? '' : ' (no ticket to post in)'}`,
    r,
  };
}

const partButton = (r, name) => new ButtonBuilder()
  .setCustomId(`${LABEL_DROP_PREFIX}part:${r.parcel.id}`)
  .setLabel(`Part only: ${name || r.order.reference_code}`.slice(0, 80))
  .setStyle(ButtonStyle.Secondary);

function rows(buttons) {
  const out = [];
  for (let i = 0; i < buttons.length && out.length < 5; i += 5) out.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  return out;
}

/** Only staff, only in the shipping channel, only label files. */
export async function handleLabelDropMessage(message) {
  if (message.author?.bot || !message.guild || !message.attachments?.size) return;
  const files = [...message.attachments.values()].filter((a) => FILE_TYPES.test(a.name || '') && a.size <= MAX_BYTES);
  if (!files.length || !isLabelChannel(message.channel) || !isStaff(message.member)) return;

  await message.react('⏳').catch(() => {});
  const labels = [];
  for (const file of files) {
    try {
      const res = await fetch(file.url);
      const found = await readLabelsFromFile(Buffer.from(await res.arrayBuffer()), file.name);
      if (!found.length) labels.push({ file: file.name, problem: 'no label picture found in it' });
      else noteOk('labels');
      for (const l of found) labels.push({ ...l, file: file.name });
    } catch (err) {
      console.error(`Label drop: could not read ${file.name}:`, err);
      noteFail('labels', `${file.name} couldn't be read: ${err.message}`);
      labels.push({ file: file.name, problem: 'could not be read' });
    }
  }

  const done = [];
  const parts = [];
  const questions = [];
  const awaiting = ordersAwaitingParcels();
  for (const label of labels) {
    if (label.problem || !label.tracking) {
      done.push(`⚠️ ${label.file}: ${label.problem || 'no barcode found, so no tracking number'}${label.name ? ` (to ${label.name})` : ''}`);
      continue;
    }
    const match = matchLabel(label, awaiting);
    if (match.order) {
      const { line, r } = await applyParcel(message.client, match.order, label, match.qty);
      done.push(line);
      if (r.parcel && r.complete && !r.sentBefore && r.order.quantity > 1) parts.push(partButton(r, match.order.buyer_name));
      continue;
    }
    questions.push({ label, match });
  }

  const head = `📦 **${labels.length} label${labels.length === 1 ? '' : 's'} read.** `
    + `${done.filter((d) => d.startsWith('✅')).length} buyer${done.filter((d) => d.startsWith('✅')).length === 1 ? '' : 's'} told`
    + (questions.length ? `, ${questions.length} need${questions.length === 1 ? 's' : ''} you below.` : '.');
  const footer = parts.length ? '\nOnly part of an order in one of these? Tap its **Part only** button.' : '';
  await message.reply({
    content: [head, ...done].join('\n').slice(0, 1900 - footer.length) + footer,
    components: rows(parts),
    allowedMentions: { parse: [] },
  });

  for (const { label, match } of questions) {
    const about = `\`${short(label.tracking)}\`${label.name ? ` to **${label.name}**` : ''}${label.ref ? ` (Ref: ${label.ref})` : ''}`;
    const qty = match.qty ? `:${match.qty}` : '';
    if (match.candidates.length) {
      const buttons = match.candidates.slice(0, 4).map((o) => new ButtonBuilder()
        .setCustomId(`${LABEL_DROP_PREFIX}pick:${o.id}:${label.tracking}${qty}`)
        .setLabel(orderText(o).slice(0, 80))
        .setStyle(ButtonStyle.Primary));
      buttons.push(new ButtonBuilder().setCustomId(`${LABEL_DROP_PREFIX}skip`).setLabel('Skip').setStyle(ButtonStyle.Secondary));
      await message.channel.send({
        content: `⚠️ Label ${about}: ${match.candidates.length} orders are waiting for that name. Which one is in this parcel?`,
        components: [new ActionRowBuilder().addComponents(buttons)],
        allowedMentions: { parse: [] },
      });
    } else if (match.suggestions.length) {
      await message.channel.send({
        content: `❓ Label ${about}: no waiting order matches. Pick it, or skip.`,
        components: [
          new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
            .setCustomId(`${LABEL_DROP_PREFIX}sel:${label.tracking}${qty}`)
            .setPlaceholder('Which order is this parcel?')
            .addOptions(match.suggestions.map((o) => ({
              label: `${o.buyer_name || 'No name'} · ${o.reference_code}`.slice(0, 100),
              description: `${o.quantity}x ${o.product_name}`.slice(0, 100),
              value: String(o.id),
            })))),
          new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${LABEL_DROP_PREFIX}skip`).setLabel('Skip').setStyle(ButtonStyle.Secondary)),
        ],
        allowedMentions: { parse: [] },
      });
    } else {
      await message.channel.send({ content: `❓ Label ${about}: nothing is waiting to be posted, so it wasn't matched.`, allowedMentions: { parse: [] } });
    }
  }

  await message.reactions.cache.get('⏳')?.users.remove(message.client.user.id).catch(() => {});
  await message.react(questions.length ? '❓' : '✅').catch(() => {});
}

/** The buttons and dropdowns on those messages. */
export async function handleLabelDropInteraction(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const [, action, a, b, c] = interaction.customId.split(':');

  if (action === 'skip') {
    await interaction.update({ content: `${interaction.message.content}\n⏭️ Skipped.`, components: [] });
    return;
  }

  if (action === 'pick' || action === 'sel') {
    const orderId = action === 'pick' ? Number(a) : Number(interaction.values[0]);
    const tracking = action === 'pick' ? b : a;
    const qty = Number(action === 'pick' ? c : b) || null;
    const order = getOrderById(orderId);
    if (!order) {
      await interaction.reply({ content: 'That order is gone.', ephemeral: true });
      return;
    }
    const { line, r } = await applyParcel(interaction.client, order, { tracking }, qty);
    const components = r.parcel && r.complete && !r.sentBefore && r.order.quantity > 1 ? rows([partButton(r, null)]) : [];
    await interaction.update({ content: `${interaction.message.content.split('\n')[0]}\n${line}`, components });
    return;
  }

  if (action === 'part') {
    const parcel = getParcel(Number(a));
    const order = parcel && getOrderById(parcel.order_id);
    if (!order || order.quantity < 2) {
      await interaction.reply({ content: 'Nothing to split there.', ephemeral: true });
      return;
    }
    await interaction.reply({
      content: `How many of **${order.quantity}x ${order.product_name}** (\`${order.reference_code}\`) are in the parcel \`${short(parcel.tracking_code)}\`?`,
      components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId(`${LABEL_DROP_PREFIX}partq:${parcel.id}`)
        .setPlaceholder('How many are in it?')
        .addOptions(Array.from({ length: Math.min(order.quantity - 1, 25) }, (_, i) => ({
          label: `${i + 1} of ${order.quantity}`,
          value: String(i + 1),
        }))))],
      ephemeral: true,
    });
    return;
  }

  if (action === 'partq') {
    const result = setParcelQuantity(Number(a), Number(interaction.values[0]));
    if (result.error) {
      await interaction.update({ content: 'That parcel is gone.', components: [] });
      return;
    }
    await tellBuyer(interaction.client, result.order, partCorrectionMessage(result.order, result.parcel, result.left));
    pushToSheetInBackground([result.order], 'tracking');
    await interaction.update({
      content: `Done. The buyer knows that parcel has ${result.parcel.quantity} of ${result.order.quantity}; `
        + `the other ${result.left} ${result.left === 1 ? 'is' : 'are'} back on **Print labels**, with a label that says "(rest)".`,
      components: [],
    });
  }
}

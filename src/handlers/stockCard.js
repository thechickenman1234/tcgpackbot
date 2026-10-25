import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { config } from '../config.js';
import { isStaff } from '../utils/permissions.js';
import { batchView, getStockBatch, setCardLocation, setStep } from '../services/stockTracker.js';

/**
 * The stock card in the staff log: one per sale night, posted with the
 * order sheet. Its buttons tick the steps only staff know about (ordered,
 * supplier paid, on its way, arrived); tapping a ticked one unticks it, so
 * a wrong tap is one more tap to fix. The dashboard has the same buttons.
 */

export const STOCK_PREFIX = 'stk:';

const date = (iso) => `<t:${Math.floor(Date.parse(iso) / 1000)}:d>`;

export function stockCardPayload(v) {
  const lines = v.steps.map((s) => {
    const mark = s.done ? '✅' : s.implied ? '☑️' : s.key === v.stage ? '👉' : '⬜';
    let extra = s.done && s.at ? ` · ${date(s.at)}${s.auto ? ' (auto)' : ''}` : '';
    if (s.key === 'onway' && v.note) extra += ` · ${v.note}`;
    if (s.key === 'packed' && !s.done && v.units.packed) extra += ` · ${v.units.packed} of ${v.units.paid}`;
    if (s.key === 'posted' && !s.done && v.units.posted) extra += ` · ${v.units.posted} of ${v.units.paid}`;
    return `${mark} ${s.label}${extra}`;
  });
  const u = v.units;
  lines.push('', `${u.paid} paid${u.toPay ? `, ${u.toPay} still to pay` : ''} · ${u.posted} posted`);
  if (v.stuck) lines.push(`${v.stuck.level === 'bad' ? '🔴' : '🟡'} **${v.stuck.text}**`);
  else if (v.done) lines.push('🎉 All done.');
  else lines.push('Tap a step when it happens. Tap a ticked one to untick it.');

  const embed = new EmbedBuilder()
    .setTitle(`📦 Stock: ${v.title}`.slice(0, 256))
    .setDescription(lines.join('\n').slice(0, 4000))
    .setColor(v.done ? 0x27ae60 : v.stuck?.level === 'bad' ? 0xc0392b : v.stuck ? 0xf1c40f : 0x3498db);

  const buttons = v.steps.filter((s) => s.manual).map((s) => new ButtonBuilder()
    .setCustomId(`${STOCK_PREFIX}${s.key}:${v.id}`)
    .setLabel(`${s.done ? '✅ ' : ''}${s.label}`)
    .setStyle(s.done ? ButtonStyle.Success : s.key === v.stage ? ButtonStyle.Primary : ButtonStyle.Secondary));
  return { embeds: [embed], components: v.done ? [] : [new ActionRowBuilder().addComponents(buttons)] };
}

/** Posted in the staff log when a night's claims close. */
export async function postStockCard(client, batch) {
  try {
    const channel = await client.channels.fetch(config.staffLogChannelId);
    if (!channel?.isTextBased()) return;
    const v = batchView(batch);
    if (v.done) return;
    const message = await channel.send(stockCardPayload(v));
    setCardLocation(batch.id, channel.id, message.id);
  } catch (err) {
    console.error('Stock card failed:', err);
  }
}

/** Brings a night's card in the staff log up to date after a tick elsewhere (dashboard, ops door). */
export async function refreshStockCard(client, v) {
  if (!v.card) return;
  const channel = await client.channels.fetch(v.card.channelId).catch(() => null);
  const message = await channel?.messages.fetch(v.card.messageId).catch(() => null);
  await message?.edit(stockCardPayload(v)).catch(() => {});
}

export async function handleStockInteraction(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const parts = interaction.customId.slice(STOCK_PREFIX.length).split(':');

  // The "On its way" pop-up: stk:m:onway:<id>
  if (interaction.isModalSubmit() && parts[0] === 'm') {
    const id = Number(parts[2]);
    setStep(id, 'onway', true, { note: interaction.fields.getTextInputValue('note') });
    const batch = getStockBatch(id);
    if (batch) await interaction.update(stockCardPayload(batchView(batch)));
    else await interaction.reply({ content: 'That stock night is gone.', ephemeral: true });
    return;
  }

  const [step, rawId] = parts;
  const batch = getStockBatch(rawId);
  if (!batch) {
    await interaction.reply({ content: 'That stock night is gone.', ephemeral: true });
    return;
  }
  const s = batchView(batch).steps.find((x) => x.key === step);
  if (!s?.manual) {
    await interaction.reply({ content: 'That step ticks itself.', ephemeral: true });
    return;
  }

  if (s.tapped) {
    setStep(batch.id, step, false);
  } else if (step === 'onway') {
    await interaction.showModal(new ModalBuilder()
      .setCustomId(`${STOCK_PREFIX}m:onway:${batch.id}`)
      .setTitle('On its way')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('note')
        .setLabel('Tracking or arrival date (optional)')
        .setPlaceholder('e.g. SF1234567 or due 5 Nov')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(200))));
    return;
  } else {
    setStep(batch.id, step, true);
  }
  await interaction.update(stockCardPayload(batchView(getStockBatch(batch.id))));
}

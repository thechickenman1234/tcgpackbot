import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { isStaff } from '../utils/permissions.js';
import { formatMelbourne } from '../services/scheduleService.js';
import {
  REEL_RULES,
  createReel,
  dueReelReminders,
  getReel,
  lastLoggedReel,
  markReminded,
  saveReelResults,
} from '../services/reelService.js';

export const REEL_PREFIX = 'reel:';

const rulesBlock = () => REEL_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n');
const quote = (text) => String(text || '').trim().split('\n').map((l) => `> ${l}`).join('\n');

/** /reel: run it the moment a video goes up. */
export async function handleReelCommand(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const title = interaction.options.getString('title', true).trim();
  const link = interaction.options.getString('link')?.trim() || null;
  const hours = interaction.options.getInteger('hours') ?? 24;

  // Read before creating, so the promise shown is from the previous video.
  const last = lastLoggedReel();
  const reel = createReel({
    title, link, channelId: interaction.channelId, userId: interaction.user.id, hours,
  });
  const unix = Math.floor(new Date(reel.remind_at).getTime() / 1000);

  const lines = [
    `🎬 **Logged: ${title}**`,
    `⏰ I'll ping you here **${formatMelbourne(reel.remind_at)}** (<t:${unix}:R>) to log how it did.`,
  ];
  if (last?.next_time) {
    lines.push('', `**Last time (${last.title}) you said next video you'd:**`, quote(last.next_time), 'Did this one do that?');
  }
  lines.push('', '**Your 7 rules. Did this video hit all of them?**', rulesBlock());

  await interaction.reply({ content: lines.join('\n').slice(0, 1900), ephemeral: true });
}

function logButton(id, label = 'Log results', emoji = '📊') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`reel:log:${id}`).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Primary),
  );
}

/** The 24-hour ping. */
export function reminderMessage(reel) {
  return {
    content: [
      `<@${reel.user_id}> ⏰ **24 hours since you posted: ${reel.title}**`,
      reel.link || null,
      '',
      'Open the stats, then press **Log results**: views, shares, saves, watch time, what worked, what didn\'t.',
      '',
      '**Check it against your 7 rules:**',
      rulesBlock(),
    ].filter((l) => l !== null).join('\n'),
    components: [logButton(reel.id)],
    allowedMentions: { users: [reel.user_id] },
  };
}

/** The finished loop, which replaces the ping so the channel reads as a log. */
function loopCard(reel) {
  return [
    `🎬 **Feedback loop: ${reel.title}**`,
    `Posted ${formatMelbourne(reel.posted_at)}${reel.link ? ` · ${reel.link}` : ''}`,
    '',
    `📊 **Numbers**\n${quote(reel.numbers)}`,
    `✅ **What worked** (best first)\n${quote(reel.worked)}`,
    `❌ **What didn't** (worst first)\n${quote(reel.didnt)}`,
    `➡️ **Next video I will**\n${quote(reel.next_time)}`,
  ].join('\n').slice(0, 1990);
}

function input(id, label, placeholder, value, max) {
  const field = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(max);
  if (value) field.setValue(String(value).slice(0, max));
  return new ActionRowBuilder().addComponents(field);
}

async function openLog(interaction, id) {
  const reel = getReel(id);
  if (!reel) {
    await interaction.reply({ content: 'That video is not in the log any more.', ephemeral: true });
    return;
  }
  // Filled in again when editing, so fixing a typo does not mean retyping.
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`reel:save:${reel.id}`)
      .setTitle('Feedback loop')
      .addComponents(
        input('numbers', 'Numbers', 'Views 4,524 · shares 22 · saves 40 · avg watch 12s', reel.numbers, 300),
        input('worked', 'What worked? Best first', 'Big number in the hook, face on camera…', reel.worked, 500),
        input('didnt', 'What didn\'t work? Worst first', 'Too long, sped up looked cheap…', reel.didnt, 500),
        input('next', 'Next video I will…', 'Keep it under 50s, film in a clean spot…', reel.next_time, 500),
      ),
  );
}

async function saveLog(interaction, id) {
  const reel = saveReelResults(id, {
    numbers: interaction.fields.getTextInputValue('numbers'),
    worked: interaction.fields.getTextInputValue('worked'),
    didnt: interaction.fields.getTextInputValue('didnt'),
    nextTime: interaction.fields.getTextInputValue('next'),
  });
  const payload = { content: loopCard(reel), components: [logButton(reel.id, 'Edit', '✏️')], allowedMentions: { parse: [] } };

  // From the reminder's button, the card replaces the ping in place.
  if (interaction.isFromMessage?.()) {
    await interaction.update(payload);
  } else {
    await interaction.reply(payload);
  }
}

export async function handleReelInteraction(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const [, action, id] = interaction.customId.split(':');
  if (action === 'log') await openLog(interaction, id);
  else if (action === 'save') await saveLog(interaction, id);
  else await interaction.reply({ content: 'That button is out of date.', ephemeral: true });
}

/** Sends any pings that have come due. A ping missed during a restart goes out on the next tick. */
export async function sendDueReelReminders(client) {
  for (const reel of dueReelReminders()) {
    try {
      const channel = await client.channels.fetch(reel.channel_id);
      if (!channel?.isTextBased()) throw new Error('channel is gone');
      const message = await channel.send(reminderMessage(reel));
      markReminded(reel.id, message.id);
      console.log(`Reel reminder sent for ${reel.id} (${reel.title})`);
    } catch (err) {
      markReminded(reel.id, null);
      console.error(`Reel reminder ${reel.id} failed:`, err.message);
    }
  }
}

export function startReelReminderJob(client, everyMs = 60000) {
  setInterval(() => {
    sendDueReelReminders(client).catch((err) => console.error('Reel reminder job:', err));
  }, everyMs).unref?.();
}

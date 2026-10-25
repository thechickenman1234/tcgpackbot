import { isStaff } from '../utils/permissions.js';
import { eventUrl } from '../services/discordEventService.js';
import { formatMelbourne } from '../services/scheduleService.js';
import { planStream, postLive, setStreamLink } from '../services/streamService.js';

/** /stream: sending the Discord to TCG Pack Bot's Whatnot shows. */
export async function handleStreamCommand(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const sub = interaction.options.getSubcommand();

  if (sub === 'link') {
    const result = setStreamLink(interaction.options.getString('url', true));
    await interaction.reply({
      content: result.error || `🔴 Saved: ${result.link}${result.platform ? ` (${result.platform})` : ''}. \`/stream plan\` and \`/stream live\` use it now.`,
      ephemeral: true,
    });
    return;
  }

  if (sub === 'live') {
    await interaction.deferReply({ ephemeral: true });
    const result = await postLive(interaction.client, {
      title: interaction.options.getString('title'),
      ping: interaction.options.getBoolean('ping') ?? false,
    });
    await interaction.editReply(result.error || `🔴 Posted: ${result.url}`);
    return;
  }

  if (sub === 'plan') {
    await interaction.deferReply({ ephemeral: true });
    const result = await planStream(interaction.client, interaction.guild, {
      date: interaction.options.getString('date', true),
      time: interaction.options.getString('time', true),
      title: interaction.options.getString('title'),
      hours: interaction.options.getInteger('hours') ?? 2,
      ping: interaction.options.getBoolean('ping') ?? false,
      image: interaction.options.getAttachment('image'),
    });
    if (result.error) {
      await interaction.editReply(result.error);
      return;
    }
    await interaction.editReply(
      `📅 Show planned for **${formatMelbourne(result.start.toISOString())}**. It's an event at the top of the server, `
      + `and "we're live" posts in announcements when it starts.\n`
      + (result.imageSkipped ? '⚠️ Could not fetch that picture, so the event has no cover image.\n' : '')
      + `Show moved or off? Delete the event, and \`/unschedule\` the post (#${result.postId}).\n`
      + eventUrl(interaction.guild.id, result.event.id),
    );
  }
}

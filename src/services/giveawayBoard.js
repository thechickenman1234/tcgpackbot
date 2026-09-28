import { EmbedBuilder } from 'discord.js';
import { getRunningGiveaway, getStandings, getTotals } from './giveawayService.js';

/**
 * The standings message that lives in the announcement channel and keeps
 * itself current. The leaderboard is the mechanic - people invite harder
 * when they can see where they sit.
 *
 * Every failure here is swallowed. A deleted message or a permissions
 * change must never take the bot down or block a sale.
 */

export function buildBoardEmbed(giveaway, standings, totals) {
  const endsUnix = Math.floor(new Date(giveaway.ends_at).getTime() / 1000);

  const top = standings.slice(0, 10);
  const medals = ['🥇', '🥈', '🥉'];
  const lines = top.length
    ? top.map((row, i) => {
      const place = medals[i] || `**${i + 1}.**`;
      return `${place} <@${row.inviter_id}> — **${row.entries}** ${row.entries === 1 ? 'entry' : 'entries'}`;
    })
    : ['Nobody has invited anyone yet. First entry takes the lead.'];

  return new EmbedBuilder()
    .setTitle('🎁 Invite Giveaway')
    .setDescription(
      `**Prize:** ${giveaway.prize}\n`
      + `**Ends:** <t:${endsUnix}:F> (<t:${endsUnix}:R>)\n\n`
      + 'Every person you invite who stays in the server is **one entry**. '
      + 'Invite more, get more chances.\n\n'
      + `**Leaderboard**\n${lines.join('\n')}`,
    )
    .setFooter({
      text: `${totals.entries} entries from ${totals.people} ${totals.people === 1 ? 'person' : 'people'} · /entries to check yours`,
    })
    .setColor(0xf1c40f)
    .setTimestamp(new Date());
}

async function refreshBoard(client) {
  const giveaway = getRunningGiveaway();
  if (!giveaway?.channel_id || !giveaway?.message_id) return;

  try {
    const channel = await client.channels.fetch(giveaway.channel_id);
    if (!channel?.isTextBased()) return;
    const message = await channel.messages.fetch(giveaway.message_id);
    const standings = getStandings(giveaway.id);
    const totals = getTotals(giveaway.id);
    await message.edit({ embeds: [buildBoardEmbed(giveaway, standings, totals)] });
  } catch (err) {
    console.error('Could not refresh the giveaway board:', err.message);
  }
}

export function startGiveawayBoardJob(client, everyMs = 10 * 60 * 1000) {
  setInterval(() => {
    refreshBoard(client).catch((err) => console.error('Giveaway board job:', err));
  }, everyMs).unref?.();
}

export { refreshBoard };

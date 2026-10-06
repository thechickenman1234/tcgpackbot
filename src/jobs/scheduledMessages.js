import { AttachmentBuilder } from 'discord.js';
import {
  cleanupAttachments,
  formatMelbourne,
  getDueMessages,
  markFailed,
  markSent,
  readAttachments,
  rollForward,
} from '../services/scheduleService.js';

/**
 * Posts scheduled messages when they come due.
 *
 * Runs every 30 seconds. A message that fell due while the bot was
 * restarting still goes out on the next tick - late is better than never
 * for a drop announcement.
 *
 * allowedMentions deliberately permits @everyone: these are announcements
 * Lachy writes himself, and the whole point of scheduling one is that it
 * pings the server while he is packing or asleep. The bot still needs the
 * Mention Everyone permission in that channel for it to land.
 */
async function sendDue(client) {
  const due = getDueMessages();
  if (!due.length) return;

  for (const row of due) {
    try {
      const channel = await client.channels.fetch(row.channel_id);
      if (!channel?.isTextBased()) throw new Error('That channel is not a text channel any more');

      // Uploaded fresh from the volume every time, so a weekly post keeps
      // working long after the original Discord link has expired.
      const files = readAttachments(row).map((file) => new AttachmentBuilder(file));

      await channel.send({
        content: row.content,
        files,
        allowedMentions: { parse: ['users', 'roles', 'everyone'] },
      });

      if (row.repeat_every) {
        const next = rollForward(row.id);
        console.log(
          `Scheduled message ${row.id} sent with ${files.length} file(s), next ${row.repeat_every} run `
          + `${next ? formatMelbourne(next.send_at) : 'unknown'}`,
        );
      } else {
        markSent(row.id);
        cleanupAttachments(row);
        console.log(`Scheduled message ${row.id} sent to ${row.channel_id} with ${files.length} file(s)`);
      }
    } catch (err) {
      console.error(`Scheduled message ${row.id} failed:`, err.message);
      markFailed(row.id, err.message);
    }
  }
}

export function startScheduledMessagesJob(client, everyMs = 30000) {
  setInterval(() => {
    sendDue(client).catch((err) => console.error('Scheduled messages job:', err));
  }, everyMs).unref?.();
}

import { GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } from 'discord.js';

/**
 * Discord's own scheduled events, the ones that sit at the top of the server
 * with an Interested button.
 *
 * Nothing is stored here. Discord is the only record, so an event edited or
 * deleted in the Discord UI can never disagree with a copy in the database.
 * That is the whole reason this file has no table behind it.
 *
 * Every event is created as External rather than tied to a voice channel,
 * because a claim sale happens in a text channel and Discord has no entity
 * type for that. External is also the only type that takes a plain location
 * string, which is what makes "#claim-sales" or "Akibar, Elizabeth St" work.
 */

const LIMITS = { name: 100, location: 100, description: 1000 };

/** Discord REST codes worth telling the user about by name. */
const MISSING_PERMISSIONS = 50013;

/**
 * Pulls an uploaded picture down so it can go up again as the cover image.
 *
 * Returns null rather than throwing: a missing picture is not a reason to
 * lose the event, and the caller says so in its reply.
 */
async function coverImage(attachment) {
  if (!attachment) return null;
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Creates one scheduled event.
 *
 * Resolves to { ok: false, reason } for anything the user can fix, and only
 * throws on something genuinely unexpected.
 */
export async function createScheduledEvent(guild, {
  title,
  start,
  hours = 4,
  where = 'Discord',
  details = null,
  image = null,
}) {
  if (!guild) return { ok: false, reason: 'Run this in the server, not in a DM.' };
  if (!start || Number.isNaN(start.getTime())) {
    return { ok: false, reason: 'That date and time did not parse. Pick both from the dropdowns.' };
  }
  if (start.getTime() <= Date.now()) {
    return { ok: false, reason: 'That start time has already passed. Discord only takes future events.' };
  }

  const end = new Date(start.getTime() + hours * 3600000);
  const cover = await coverImage(image);

  try {
    const event = await guild.scheduledEvents.create({
      name: title.slice(0, LIMITS.name),
      scheduledStartTime: start,
      scheduledEndTime: end,
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.External,
      entityMetadata: { location: where.slice(0, LIMITS.location) },
      description: details ? details.slice(0, LIMITS.description) : undefined,
      image: cover ?? undefined,
    });

    return {
      ok: true,
      event,
      end,
      // Said out loud in the reply so a silently missing picture is never a mystery.
      imageSkipped: Boolean(image) && !cover,
    };
  } catch (err) {
    if (err?.code === MISSING_PERMISSIONS) {
      return {
        ok: false,
        reason: 'I need the **Manage Events** permission. '
          + 'Server Settings, Roles, the bot\'s role, turn on Manage Events, then run this again. '
          + 'Manage Server is a different permission and does not cover it.',
      };
    }
    return { ok: false, reason: `Discord refused it: ${err.message}` };
  }
}

/** The clickable link to an event. */
export function eventUrl(guildId, eventId) {
  return `https://discord.com/events/${guildId}/${eventId}`;
}

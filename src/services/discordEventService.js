import fs from 'node:fs';
import {
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
} from 'discord.js';
import { config } from '../config.js';
import { productsFor } from './scheduledSaleService.js';
import { readAttachments } from './scheduleService.js';

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

/** Bigger than this and Discord turns the cover down, and the event with it. */
const MAX_COVER_BYTES = 8 * 1024 * 1024;

/**
 * Pulls an uploaded picture down so it can go up again as the cover image.
 * Takes a Discord attachment (or anything with a url), or { path } for a
 * picture a scheduled sale already saved on the volume.
 *
 * Returns null rather than throwing: a missing picture is not a reason to
 * lose the event, and the caller says so in its reply.
 */
async function coverImage(attachment) {
  if (!attachment) return null;
  try {
    if (attachment.path) {
      return fs.statSync(attachment.path).size <= MAX_COVER_BYTES ? fs.readFileSync(attachment.path) : null;
    }
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

/* --------------------------------------------------------------------------
 * One event per claim sale.
 *
 * Every queued claim sale gets its own event, made by the bot the moment the
 * sale is queued (/newsale, /schedulesale or the ops door), brought up to
 * date when another product joins that night, and deleted when the sale is
 * cancelled. Nobody has to remember to make it.
 *
 * Still nothing stored. A sale's event is found again by its start time,
 * since only one sale can start at a given minute (see findPendingSaleAt),
 * and by "claim" in its name or place. That also finds one made by hand with
 * /event, so a night never ends up with two. One made by hand is left alone:
 * the bot only rewrites or deletes events it made itself.
 * ------------------------------------------------------------------------ */

const ZONE = 'Australia/Melbourne';
const LIVE = [GuildScheduledEventStatus.Scheduled, GuildScheduledEventStatus.Active];

/** "7pm" or "7:30pm", Melbourne time. */
function clock(iso) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: ZONE, hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(iso));
  const part = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const minute = part('minute') === '00' ? '' : `:${part('minute')}`;
  return `${part('hour')}${minute}${part('dayPeriod').toLowerCase().replace(/[\s.]/g, '')}`;
}

/** "#claim-sales" for a channel called "🛒│claim-sales". */
async function channelLabel(guild, channelId, fallback) {
  if (!channelId) return fallback;
  try {
    const channel = await guild.channels.fetch(channelId);
    const name = channel?.name?.replace(/^[^a-z0-9]+/i, '');
    return name ? `#${name}` : fallback;
  } catch {
    return fallback;
  }
}

async function findSaleEvent(guild, startAtIso) {
  const start = Date.parse(startAtIso);
  const events = await guild.scheduledEvents.fetch();
  return events.find((e) => e.scheduledStartTimestamp === start
    && LIVE.includes(e.status)
    && /claim/i.test(`${e.name} ${e.entityMetadata?.location ?? ''}`)) ?? null;
}

const madeByBot = (guild, event) => event.creatorId === guild.client.user.id;

function saleEventText(sale, products, { claims, announcements }) {
  const names = products.map((p) => p.display_name || p.name);
  let title = sale.title ? `Claim sale: ${sale.title}` : `Claim sale: ${names.join(' + ')}`;
  if (title.length > LIMITS.name) title = `Claim sale: ${names[0]} + ${names.length - 1} more`;

  const lines = [
    "What's on:",
    ...names.map((n) => `• ${n}`),
    '',
    sale.announce_at ? `Price list goes out at ${clock(sale.announce_at)} in ${announcements}.` : null,
    `Claims open at ${clock(sale.start_at)} in ${claims}. Type claim, first in gets it.`,
    sale.note ? `\n${sale.note}` : null,
  ].filter((line) => line !== null);

  return { title: title.slice(0, LIMITS.name), details: lines.join('\n').slice(0, LIMITS.description) };
}

/**
 * Makes the sale's event, or brings the one already there up to date.
 *
 * Resolves to { ok, event, updated, kept } or { ok: false, reason }, and
 * never throws: an event that won't go up must not stop the sale itself.
 */
export async function syncSaleEvent(guild, sale) {
  try {
    const products = productsFor(sale);
    if (!guild || !products.length) return { ok: false, reason: 'that night has no products on it.' };

    const [claims, announcements] = await Promise.all([
      channelLabel(guild, sale.channel_id || config.claimsChannelId, '#claim-sales'),
      channelLabel(guild, sale.announce_channel_id || config.announceChannelId, '#announcements'),
    ]);
    const { title, details } = saleEventText(sale, products, { claims, announcements });
    const start = new Date(sale.start_at);
    const end = new Date(sale.end_at);

    const existing = await findSaleEvent(guild, sale.start_at);
    if (existing && !madeByBot(guild, existing)) return { ok: true, event: existing, kept: true };
    if (existing) {
      const event = await existing.edit({
        name: title,
        description: details,
        scheduledEndTime: end,
        entityMetadata: { location: claims },
      });
      return { ok: true, event, updated: true };
    }

    const [picture] = readAttachments(sale);
    return await createScheduledEvent(guild, {
      title,
      start,
      hours: (end.getTime() - start.getTime()) / 3600000,
      where: claims,
      details,
      image: picture ? { path: picture } : null,
    });
  } catch (err) {
    return { ok: false, reason: `Discord refused it: ${err.message}` };
  }
}

/** Deletes the event of a cancelled sale, if the bot made it. Never throws. */
export async function removeSaleEvent(guild, sale) {
  try {
    const event = await findSaleEvent(guild, sale.start_at);
    if (!event) return { ok: true, found: false };
    if (!madeByBot(guild, event)) return { ok: true, found: true, kept: true, event };
    await event.delete();
    return { ok: true, found: true };
  } catch (err) {
    return { ok: false, reason: `Discord refused it: ${err.message}` };
  }
}

/** One line for a staff reply saying what happened to the sale's event. */
export function saleEventLine(guild, result) {
  if (!result.ok) return `⚠️ No Discord event for it: ${result.reason}`;
  const url = eventUrl(guild.id, result.event.id);
  if (result.kept) return `📅 There's already an event for that night (made by hand, so I left it): ${url}`;
  return `📅 Event ${result.updated ? 'updated' : 'is up'}: ${url}`
    + (result.imageSkipped ? ' (no cover picture, it could not be read)' : '');
}

/** The same for a cancelled sale. Empty when there was nothing to say. */
export function removedEventLine(guild, result) {
  if (!result.ok) return `⚠️ Could not delete its Discord event: ${result.reason}`;
  if (result.kept) return `📅 Its event was made by hand, so delete it yourself: ${eventUrl(guild.id, result.event.id)}`;
  return result.found ? '📅 Deleted its Discord event too.' : '';
}

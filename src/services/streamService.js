import { config } from '../config.js';
import { createScheduledEvent } from './discordEventService.js';
import { getMeta, setMeta } from './metaService.js';
import { melbourneToUtc, scheduleMessage } from './scheduleService.js';

/**
 * The stream kit. Lachy's brother streams as TCG Pack Bot on Whatnot, where
 * people buy inside the show, so the Discord's job is sending viewers there:
 *
 *   link       the stream's address, saved once and used by everything here
 *   plan       a show at a set time becomes a Discord event, and its "we're
 *              live" post is queued for the moment it starts
 *   live       "we're live" right now, for a show nobody planned
 *
 * Whatnot has no way for the bot to see when a show starts, which is why a
 * planned show queues its own post rather than waiting to be told.
 */

const LINK_KEY = 'stream_link';

const PLATFORMS = [
  [/whatnot\.com/i, 'Whatnot'],
  [/twitch\.tv/i, 'Twitch'],
  [/youtube\.com|youtu\.be/i, 'YouTube'],
  [/tiktok\.com/i, 'TikTok'],
  [/kick\.com/i, 'Kick'],
  [/instagram\.com/i, 'Instagram'],
  [/facebook\.com|fb\.watch/i, 'Facebook'],
];

export function getStreamLink() {
  return getMeta(LINK_KEY);
}

/** Saves the stream's address. Returns { ok, link, platform } or { error }. */
export function setStreamLink(url) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    return { error: 'That isn\'t a link. Paste the whole address, starting https://' };
  }
  if (!/^https?:$/.test(parsed.protocol)) return { error: 'The link has to start with https://' };
  setMeta(LINK_KEY, parsed.toString());
  return { ok: true, link: parsed.toString(), platform: platformOf(parsed.toString()) };
}

export function platformOf(url) {
  return PLATFORMS.find(([re]) => re.test(url || ''))?.[1] || null;
}

/** The announcements channel: ANNOUNCE_CHANNEL_ID, else the one named like it. */
async function announcementsChannel(client) {
  if (config.announceChannelId) {
    const byId = await client.channels.fetch(config.announceChannelId).catch(() => null);
    if (byId?.isTextBased?.()) return byId;
  }
  const guild = await client.guilds.fetch(config.guildId);
  const channels = [...(await guild.channels.fetch()).values()];
  return channels.find((c) => c?.isTextBased?.() && /announcement/i.test(c.name)) || null;
}

export function liveMessage({ title = null, link = getStreamLink(), ping = false } = {}) {
  const platform = platformOf(link);
  return [
    `${ping ? '@everyone ' : ''}🔴 **We're live${platform ? ` on ${platform}` : ''}!**${title ? ` ${title}` : ''}`,
    link || null,
    platform === 'Whatnot' ? 'Bid and buy right in the show.' : null,
  ].filter(Boolean).join('\n');
}

/** Posts "we're live" in announcements now. Returns { ok, url } or { error }. */
export async function postLive(client, { title = null, ping = false } = {}) {
  const link = getStreamLink();
  if (!link) return { error: 'Save the stream link first: `/stream link`.' };
  const channel = await announcementsChannel(client);
  if (!channel) return { error: 'No announcements channel found. Set ANNOUNCE_CHANNEL_ID on Railway.' };
  const message = await channel.send({
    content: liveMessage({ title, link, ping }),
    allowedMentions: { parse: ping ? ['everyone'] : [] },
  });
  return { ok: true, url: message.url };
}

/**
 * A show at a set time: the Discord event, plus its "we're live" post queued
 * in announcements for the start. Returns { ok, event, start, end, postId }
 * or { error }.
 */
export async function planStream(client, guild, { date, time, title = null, hours = 2, ping = false, image = null }) {
  const link = getStreamLink();
  if (!link) return { error: 'Save the stream link first: `/stream link`.' };
  const start = melbourneToUtc(date, time);
  if (!start) return { error: `Could not read \`${date}\` and \`${time}\`. Pick them from the dropdowns.` };
  const channel = await announcementsChannel(client);
  if (!channel) return { error: 'No announcements channel found. Set ANNOUNCE_CHANNEL_ID on Railway.' };

  const platform = platformOf(link);
  const result = await createScheduledEvent(guild, {
    title: `🔴 LIVE: ${title || 'TCG Pack Bot live'}`,
    start,
    hours,
    where: link,
    details: [`Live${platform ? ` on ${platform}` : ''}: ${link}`, platform === 'Whatnot' ? 'Bid and buy right in the show.' : null]
      .filter(Boolean).join('\n'),
    image,
  });
  if (!result.ok) return { error: result.reason };

  const post = scheduleMessage({
    channelId: channel.id,
    content: liveMessage({ title, link, ping }),
    sendAt: start.toISOString(),
    repeatEvery: null,
    createdBy: 'stream',
  });
  return { ok: true, event: result.event, start, end: result.end, postId: post.id, imageSkipped: result.imageSkipped };
}

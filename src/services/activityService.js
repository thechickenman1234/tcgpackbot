import { getDb } from '../db/database.js';
import { config } from '../config.js';
import { ZONE } from './scheduleService.js';

/**
 * The server side of the dashboard, recorded as it happens because Discord
 * keeps none of it for us:
 *
 *   member_daily   members at the day's first check, plus joins and leaves
 *   chat_hourly    messages per Melbourne hour, in channels (never tickets)
 *   chat_authors   who has talked and when they last did
 *   member_joins   every join, with the invite link it came through
 *
 * Only counts and ids, never what anyone wrote. Every write is best effort:
 * a failure here must never get in the way of a claim or a message.
 */

const DAY = 86400000;

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
});

export function melbourneDateHour(ms = Date.now()) {
  const p = {};
  for (const part of partsFmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

function safely(what, fn) {
  try {
    return fn();
  } catch (err) {
    console.error(`activity: ${what} failed:`, err.message);
    return null;
  }
}

/** One message from a person in a channel. Tickets (threads) and bots are left out. */
export function recordChatMessage(message) {
  if (!message?.guild || message.author?.bot || message.system) return;
  if (message.guild.id !== config.guildId || message.channel?.isThread?.()) return;
  safely('chat', () => {
    const { date, hour } = melbourneDateHour(message.createdTimestamp || Date.now());
    const at = new Date(message.createdTimestamp || Date.now()).toISOString();
    const db = getDb();
    db.prepare(`
      INSERT INTO chat_hourly (date, hour, messages) VALUES (?, ?, 1)
      ON CONFLICT(date, hour) DO UPDATE SET messages = messages + 1
    `).run(date, hour);
    db.prepare(`
      INSERT INTO chat_authors (author_id, first_at, last_at, messages) VALUES (?, ?, ?, 1)
      ON CONFLICT(author_id) DO UPDATE SET last_at = excluded.last_at, messages = messages + 1
    `).run(message.author.id, at, at);
  });
}

function bumpDaily(column) {
  const { date } = melbourneDateHour();
  getDb().prepare(`
    INSERT INTO member_daily (date, ${column}) VALUES (?, 1)
    ON CONFLICT(date) DO UPDATE SET ${column} = ${column} + 1
  `).run(date);
}

export function recordJoin(member, inviteCode = null, inviterId = null) {
  if (!member || member.user?.bot || member.guild?.id !== config.guildId) return;
  safely('join', () => {
    getDb().prepare(`
      INSERT INTO member_joins (member_id, joined_at, invite_code, inviter_id) VALUES (?, ?, ?, ?)
    `).run(member.id, new Date().toISOString(), inviteCode, inviterId);
    bumpDaily('joins');
  });
}

export function recordLeave(member) {
  if (!member || member.user?.bot || member.guild?.id !== config.guildId) return;
  safely('leave', () => {
    getDb().prepare(`
      UPDATE member_joins SET left_at = ?
      WHERE id = (SELECT id FROM member_joins WHERE member_id = ? AND left_at IS NULL ORDER BY id DESC LIMIT 1)
    `).run(new Date().toISOString(), member.id);
    bumpDaily('leaves');
  });
}

/** The day's member count, once a day (the first check after midnight wins). */
export async function snapshotMembers(client) {
  const { date } = melbourneDateHour();
  const row = getDb().prepare('SELECT members FROM member_daily WHERE date = ?').get(date);
  if (row?.members != null) return;
  const guild = await client.guilds.fetch(config.guildId);
  safely('snapshot', () => getDb().prepare(`
    INSERT INTO member_daily (date, members) VALUES (?, ?)
    ON CONFLICT(date) DO UPDATE SET members = excluded.members
  `).run(date, guild.memberCount));
}

export function startMemberSnapshotJob(client, intervalMs = 30 * 60000) {
  const tick = () => snapshotMembers(client).catch((err) => console.error('member snapshot failed:', err.message));
  setTimeout(tick, 30000);
  return setInterval(tick, intervalMs);
}

// ---------------------------------------------------------------- reading

export function memberGrowth(days = 120, now = Date.now()) {
  const since = melbourneDateHour(now - days * DAY).date;
  return getDb().prepare('SELECT * FROM member_daily WHERE date >= ? ORDER BY date').all(since);
}

export function chatStats(now = Date.now()) {
  const db = getDb();
  const day = (d) => melbourneDateHour(now - d * DAY).date;
  const first = db.prepare('SELECT MIN(date) AS d FROM chat_hourly').get()?.d || null;
  const last7 = db.prepare('SELECT COALESCE(SUM(messages), 0) AS n FROM chat_hourly WHERE date > ?').get(day(7)).n;
  const days7 = first ? Math.max(1, Math.min(7, Math.round((now - Date.parse(`${first}T12:00:00Z`)) / DAY) + 1)) : 0;
  const hours = Array(24).fill(0);
  for (const r of db.prepare('SELECT hour, SUM(messages) AS n FROM chat_hourly WHERE date > ? GROUP BY hour').all(day(30))) {
    hours[r.hour] = r.n;
  }
  const active = (d) => db.prepare('SELECT COUNT(*) AS n FROM chat_authors WHERE last_at >= ?')
    .get(new Date(now - d * DAY).toISOString()).n;
  const daily = db.prepare('SELECT date, SUM(messages) AS n FROM chat_hourly WHERE date > ? GROUP BY date ORDER BY date').all(day(30));
  return { since: first, perDay7: days7 ? Math.round(last7 / days7) : null, active7: active(7), active30: active(30), active90: active(90), hours, daily };
}

/** Joins per invite link, and how many of those people have since bought. */
export function inviteStats(buyerIds, days = 90, now = Date.now()) {
  const rows = getDb().prepare(`
    SELECT member_id, invite_code, inviter_id, left_at FROM member_joins WHERE joined_at >= ?
  `).all(new Date(now - days * DAY).toISOString());
  const first = getDb().prepare('SELECT MIN(joined_at) AS d FROM member_joins').get()?.d || null;
  const byCode = new Map();
  for (const r of rows) {
    const key = r.invite_code || 'unknown';
    const s = byCode.get(key) || { code: r.invite_code, inviterId: r.inviter_id, joins: 0, stayed: 0, bought: 0 };
    s.joins += 1;
    if (!r.left_at) s.stayed += 1;
    if (buyerIds.has(r.member_id)) s.bought += 1;
    byCode.set(key, s);
  }
  return { since: first, links: [...byCode.values()].sort((a, b) => b.joins - a.joins) };
}

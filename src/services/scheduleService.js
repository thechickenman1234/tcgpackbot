import { getDb } from '../db/database.js';

/**
 * Scheduled messages.
 *
 * Everything is stored as UTC in the database and shown in Melbourne time,
 * because the bot runs in Amsterdam and a sale that starts at 8pm Melbourne
 * is already the next day there.
 *
 * Melbourne also changes offset twice a year - AEST +10 becomes AEDT +11 on
 * the first Sunday in October - so the offset is never hardcoded. It is
 * measured at the exact instant being scheduled, which is the only way an
 * 8pm drop stays at 8pm across the switch.
 */

export const ZONE = 'Australia/Melbourne';

/** How far the zone is ahead of UTC at a given instant, in milliseconds. */
function offsetAt(utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));

  const p = {};
  for (const part of parts) p[part.type] = part.value;
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asIfUtc - utcMs;
}

/**
 * Turns "2026-10-05" and "20:00" in Melbourne into a real UTC instant.
 *
 * Run twice: the first pass measures the offset using a guess that may sit
 * on the wrong side of a daylight saving change, the second corrects it.
 */
export function melbourneToUtc(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  if ([y, mo, d, h, mi].some((n) => !Number.isFinite(n))) return null;

  let utc = Date.UTC(y, mo - 1, d, h, mi);
  utc -= offsetAt(utc);
  utc = Date.UTC(y, mo - 1, d, h, mi) - offsetAt(utc);
  return new Date(utc);
}

export function formatMelbourne(iso) {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: ZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

export function scheduleMessage({ channelId, content, sendAt, repeatEvery, createdBy }) {
  const result = getDb().prepare(`
    INSERT INTO scheduled_messages (channel_id, content, send_at, repeat_every, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(channelId, content, sendAt, repeatEvery || null, createdBy, new Date().toISOString());

  return getScheduledById(result.lastInsertRowid);
}

export function getScheduledById(id) {
  return getDb().prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id);
}

export function listPending() {
  return getDb().prepare(`
    SELECT * FROM scheduled_messages WHERE status = 'pending' ORDER BY send_at ASC
  `).all();
}

/**
 * Anything due now. Also catches messages that came due while the bot was
 * restarting or deploying, so a drop announcement is late rather than lost.
 */
export function getDueMessages() {
  return getDb().prepare(`
    SELECT * FROM scheduled_messages
    WHERE status = 'pending' AND send_at <= ?
    ORDER BY send_at ASC
  `).all(new Date().toISOString());
}

export function markSent(id) {
  getDb().prepare(`
    UPDATE scheduled_messages SET status = 'sent', last_sent_at = ? WHERE id = ?
  `).run(new Date().toISOString(), id);
}

export function markFailed(id, error) {
  getDb().prepare(`
    UPDATE scheduled_messages SET status = 'failed', last_error = ? WHERE id = ?
  `).run(String(error).slice(0, 400), id);
}

/** Rolls a repeating message forward to its next slot and keeps it pending. */
export function rollForward(id) {
  const row = getScheduledById(id);
  if (!row?.repeat_every) return null;

  const days = row.repeat_every === 'weekly' ? 7 : 1;
  // Step in whole days from the current slot until it is in the future,
  // so a bot that was down for a week does not fire seven times.
  let next = new Date(row.send_at).getTime();
  const now = Date.now();
  while (next <= now) next += days * 86400000;

  // Re-anchor to the same wall clock time in Melbourne, so a daily 8pm
  // message stays at 8pm through a daylight saving change.
  const wall = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(next));
  const p = {};
  for (const part of wall) p[part.type] = part.value;
  const original = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(row.send_at));
  const o = {};
  for (const part of original) o[part.type] = part.value;

  const corrected = melbourneToUtc(
    `${p.year}-${p.month}-${p.day}`,
    `${o.hour % 24}`.padStart(2, '0') + `:${o.minute}`,
  );

  getDb().prepare(`
    UPDATE scheduled_messages SET send_at = ?, last_sent_at = ? WHERE id = ?
  `).run((corrected || new Date(next)).toISOString(), new Date().toISOString(), id);

  return getScheduledById(id);
}

export function cancelScheduled(id) {
  const row = getScheduledById(id);
  if (!row || row.status !== 'pending') return { ok: false };
  getDb().prepare("UPDATE scheduled_messages SET status = 'cancelled' WHERE id = ?").run(id);
  return { ok: true, row };
}

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/database.js';
import { config } from '../config.js';

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

const pad = (n) => String(n).padStart(2, '0');

/**
 * Reads a time however it was typed: "20:00", "8pm", "8 pm", "8:30pm", "2030".
 *
 * Discord sends the raw text whenever a dropdown has no match, so anything a
 * person would reasonably type has to work here too, not only the dropdown
 * values. Returns "HH:MM" or null.
 */
export function parseTime(input) {
  const s = String(input ?? '').trim().toLowerCase().replace(/[\s.]/g, '');
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/);
  if (!m) return null;

  let h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  if (mi > 59) return null;

  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3].startsWith('p') && h !== 12) h += 12;
    if (m[3].startsWith('a') && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return `${pad(h)}:${pad(mi)}`;
}

/** Today's date in Melbourne as "YYYY-MM-DD", plus its weekday 0-6. */
function melbourneToday(offsetDays = 0) {
  const day = new Date(Date.now() + offsetDays * 86400000);
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(day);
  const weekday = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return { iso, weekday };
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Reads a date however it was typed: "2026-10-10", "10/10", "10/10/2026",
 * "today", "tomorrow", "sat". Day first, because this is Australia.
 *
 * A day and month with no year means the next time that date comes round.
 * Returns "YYYY-MM-DD" or null.
 */
export function parseDate(input) {
  const s = String(input ?? '').trim().toLowerCase();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s === 'today' || s.endsWith('(today)')) return melbourneToday().iso;
  if (s === 'tomorrow' || s.endsWith('(tomorrow)')) return melbourneToday(1).iso;

  const wd = WEEKDAYS.findIndex((w) => s.startsWith(w));
  if (wd >= 0 && /^[a-z]+$/.test(s)) {
    const ahead = (wd - melbourneToday().weekday + 7) % 7;
    return melbourneToday(ahead).iso;
  }

  const dm = s.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (dm) {
    const d = Number(dm[1]);
    const mo = Number(dm[2]);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
    const today = melbourneToday().iso;
    let y = dm[3] ? Number(dm[3]) : Number(today.slice(0, 4));
    if (y < 100) y += 2000;
    let iso = `${y}-${pad(mo)}-${pad(d)}`;
    if (!dm[3] && iso < today) iso = `${y + 1}-${pad(mo)}-${pad(d)}`;
    return iso;
  }

  return null;
}

/**
 * The time dropdown.
 *
 * Discord shows at most 25 choices. Half-hours from midnight ran out at
 * 12pm, so with nothing typed no evening time was ever on the list. Empty
 * now shows every hour on the hour, which is 24 and fits.
 *
 * Typed text is matched against the forms people actually type, so "8pm",
 * "8 pm", "830" and "20" all find something instead of an empty list.
 */
export function timeChoices(typed) {
  const q = String(typed ?? '').toLowerCase().replace(/[\s:.]/g, '');
  const choices = [];

  for (let h = 0; h < 24; h += 1) {
    for (const m of [0, 30]) {
      if (!q && m) continue;
      const h12 = h % 12 === 0 ? 12 : h % 12;
      const ampm = h < 12 ? 'am' : 'pm';
      const label = `${h12}:${pad(m)} ${ampm}`;
      const value = `${pad(h)}:${pad(m)}`;
      const keys = [`${h12}${pad(m)}${ampm}`, `${pad(h)}${pad(m)}`, `${h}${pad(m)}`];
      if (!m) keys.push(`${h12}${ampm}`);
      if (!q || keys.some((k) => k.startsWith(q))) choices.push({ name: label, value });
    }
  }
  return choices.slice(0, 25);
}

/**
 * Turns "2026-10-05" and "20:00" in Melbourne into a real UTC instant.
 *
 * Also takes looser forms ("10/10", "8pm") through parseDate and parseTime,
 * since Discord passes typed text straight through when a dropdown is empty.
 *
 * Run twice: the first pass measures the offset using a guess that may sit
 * on the wrong side of a daylight saving change, the second corrects it.
 */
export function melbourneToUtc(dateStr, timeStr) {
  const date = parseDate(dateStr);
  const time = parseTime(timeStr);
  if (!date || !time) return null;

  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
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

/**
 * Where scheduled images live.
 *
 * Discord attachment links are signed and expire within about a day, so a
 * post scheduled for next week would go out with a dead image if we only
 * kept the URL. The file is copied onto the Railway volume instead and
 * uploaded fresh when the message actually sends.
 */
const MEDIA_DIR = path.join(path.dirname(path.resolve(config.databasePath)), 'scheduled-media');

const MAX_BYTES = 20 * 1024 * 1024;

export async function saveAttachment(attachment) {
  if (!attachment) return null;
  if (attachment.size > MAX_BYTES) {
    throw new Error(`${attachment.name} is ${(attachment.size / 1048576).toFixed(1)}MB — the limit is 20MB`);
  }

  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`Could not download ${attachment.name} (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());

  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const safe = attachment.name.replace(/[^\w.-]/g, '_').slice(-80);
  const file = path.join(MEDIA_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
  fs.writeFileSync(file, buffer);
  return file;
}

export function readAttachments(row) {
  if (!row?.attachments) return [];
  try {
    return JSON.parse(row.attachments).filter((f) => fs.existsSync(f));
  } catch {
    return [];
  }
}

/** Removes the stored copies once a message can never be sent again. */
export function cleanupAttachments(row) {
  for (const file of readAttachments(row)) {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      console.error(`Could not delete scheduled image ${file}:`, err.message);
    }
  }
}

export function scheduleMessage({ channelId, content, sendAt, repeatEvery, createdBy, attachments = [] }) {
  const result = getDb().prepare(`
    INSERT INTO scheduled_messages
      (channel_id, content, send_at, repeat_every, created_by, created_at, attachments)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    channelId,
    content,
    sendAt,
    repeatEvery || null,
    createdBy,
    new Date().toISOString(),
    attachments.length ? JSON.stringify(attachments) : null,
  );

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

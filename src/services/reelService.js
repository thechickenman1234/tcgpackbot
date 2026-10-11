import { getDb } from '../db/database.js';

/**
 * Video feedback loops.
 *
 * /reel records a video the moment it goes up and schedules a ping for when
 * the numbers mean something. The ping carries a button that opens the
 * feedback loop: numbers, what worked, what didn't, what changes next time.
 * The last "next time" is shown again on the following /reel, which is the
 * accountability part: the promise comes back before the next video is made.
 */

/**
 * Lachy's own rules, from his feedback loops. Shown on every /reel and every
 * reminder so a video gets checked against them, not just remembered.
 */
export const REEL_RULES = [
  'Big number in the hook, said and on screen',
  'Your face on camera',
  'Teaches something, no unboxing',
  '50 seconds or less',
  'Not sped up: cut words instead',
  'Clean background',
  'One idea per reel',
];

export function createReel({ title, link, channelId, userId, hours = 24 }) {
  const posted = new Date();
  const remind = new Date(posted.getTime() + hours * 3600000);
  const info = getDb().prepare(`
    INSERT INTO reels (title, link, channel_id, user_id, posted_at, remind_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(title, link || null, channelId, userId, posted.toISOString(), remind.toISOString());
  return getReel(info.lastInsertRowid);
}

export function getReel(id) {
  return getDb().prepare('SELECT * FROM reels WHERE id = ?').get(Number(id));
}

/** The most recent video with a finished loop, for its "next time" promises. */
export function lastLoggedReel() {
  return getDb().prepare(`
    SELECT * FROM reels WHERE logged_at IS NOT NULL ORDER BY logged_at DESC LIMIT 1
  `).get();
}

export function dueReelReminders(now = new Date()) {
  return getDb().prepare(`
    SELECT * FROM reels WHERE reminded_at IS NULL AND remind_at <= ? ORDER BY remind_at
  `).all(now.toISOString());
}

/**
 * Marked even when sending failed, with no message id. A channel that has
 * been deleted would otherwise be retried, and logged, every minute forever.
 */
export function markReminded(id, messageId = null) {
  getDb().prepare('UPDATE reels SET reminded_at = ?, reminder_message_id = ? WHERE id = ?')
    .run(new Date().toISOString(), messageId, Number(id));
}

export function saveReelResults(id, { numbers, worked, didnt, nextTime }) {
  getDb().prepare(`
    UPDATE reels SET numbers = ?, worked = ?, didnt = ?, next_time = ?, logged_at = ? WHERE id = ?
  `).run(numbers, worked, didnt, nextTime, new Date().toISOString(), Number(id));
  return getReel(id);
}

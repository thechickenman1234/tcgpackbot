import { randomInt } from 'node:crypto';
import { getDb } from '../db/database.js';

/**
 * Invite giveaways: every person you bring in who sticks around is one
 * entry into the draw.
 *
 * Two rules do all the anti-farming work:
 *
 *   1. One row per invitee, enforced by a UNIQUE constraint. Leaving and
 *      rejoining cannot mint a second entry, no matter how many times.
 *   2. An entry only counts while left_at is null. Invite a pile of alts
 *      and purge them and the entries go with them.
 *
 * On top of that, accounts younger than the giveaway's minimum age never
 * create an entry at all, so a batch of throwaways made this morning is
 * worth nothing.
 */

function nowIso() {
  return new Date().toISOString();
}

export function getRunningGiveaway() {
  return getDb().prepare(`
    SELECT * FROM giveaways WHERE status = 'running' ORDER BY id DESC LIMIT 1
  `).get();
}

export function getGiveawayById(id) {
  return getDb().prepare('SELECT * FROM giveaways WHERE id = ?').get(id);
}

export function getLatestGiveaway() {
  return getDb().prepare('SELECT * FROM giveaways ORDER BY id DESC LIMIT 1').get();
}

export function startGiveaway({ prize, endsAt, winnerCount = 1, minAccountAgeDays = 7 }) {
  if (getRunningGiveaway()) {
    return { ok: false, reason: 'already_running' };
  }
  const result = getDb().prepare(`
    INSERT INTO giveaways (prize, winner_count, min_account_age_days, started_at, ends_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(prize, winnerCount, minAccountAgeDays, nowIso(), endsAt);

  return { ok: true, giveaway: getGiveawayById(result.lastInsertRowid) };
}

export function attachBoardMessage(giveawayId, channelId, messageId) {
  getDb().prepare('UPDATE giveaways SET channel_id = ?, message_id = ? WHERE id = ?')
    .run(channelId, messageId, giveawayId);
}

export function endGiveaway(giveawayId) {
  const giveaway = getGiveawayById(giveawayId);
  if (!giveaway || giveaway.status !== 'running') {
    return { ok: false, reason: 'not_running' };
  }
  getDb().prepare("UPDATE giveaways SET status = 'ended', ended_at = ? WHERE id = ?")
    .run(nowIso(), giveawayId);
  return { ok: true, giveaway: getGiveawayById(giveawayId) };
}

export function cancelGiveaway(giveawayId) {
  const giveaway = getGiveawayById(giveawayId);
  if (!giveaway || giveaway.status === 'drawn') {
    return { ok: false, reason: 'already_drawn' };
  }
  getDb().prepare("UPDATE giveaways SET status = 'cancelled', ended_at = ? WHERE id = ?")
    .run(nowIso(), giveawayId);
  return { ok: true };
}

/**
 * Records an invite. Returns why it didn't count when it didn't, so the
 * caller can log something useful rather than failing silently.
 */
export function recordInvite({ giveawayId, inviterId, inviteeId, inviteCode }) {
  if (!inviterId || !inviteeId) return { ok: false, reason: 'unknown_inviter' };
  if (inviterId === inviteeId) return { ok: false, reason: 'self_invite' };

  const existing = getDb().prepare(`
    SELECT * FROM giveaway_entries WHERE giveaway_id = ? AND invitee_id = ?
  `).get(giveawayId, inviteeId);

  if (existing) {
    // They have been here before. Restore the entry rather than minting a
    // new one - still one person, still worth exactly one entry.
    if (existing.left_at) {
      getDb().prepare('UPDATE giveaway_entries SET left_at = NULL WHERE id = ?').run(existing.id);
      return { ok: true, restored: true, inviterId: existing.inviter_id };
    }
    return { ok: false, reason: 'already_counted' };
  }

  getDb().prepare(`
    INSERT INTO giveaway_entries (giveaway_id, inviter_id, invitee_id, invite_code, joined_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(giveawayId, inviterId, inviteeId, inviteCode || null, nowIso());

  return { ok: true, restored: false, inviterId };
}

/** Someone left. Their entry stops counting until and unless they return. */
export function markInviteeLeft(giveawayId, inviteeId) {
  const result = getDb().prepare(`
    UPDATE giveaway_entries SET left_at = ?
    WHERE giveaway_id = ? AND invitee_id = ? AND left_at IS NULL
  `).run(nowIso(), giveawayId, inviteeId);
  return result.changes > 0;
}

/** Standings, most entries first. Only members still in the server count. */
export function getStandings(giveawayId) {
  return getDb().prepare(`
    SELECT inviter_id, COUNT(*) AS entries
    FROM giveaway_entries
    WHERE giveaway_id = ? AND left_at IS NULL
    GROUP BY inviter_id
    ORDER BY entries DESC, MIN(joined_at) ASC
  `).all(giveawayId);
}

export function getEntryCount(giveawayId, inviterId) {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n FROM giveaway_entries
    WHERE giveaway_id = ? AND inviter_id = ? AND left_at IS NULL
  `).get(giveawayId, inviterId);
  return row?.n || 0;
}

export function getTotals(giveawayId) {
  const row = getDb().prepare(`
    SELECT
      COUNT(*) AS entries,
      COUNT(DISTINCT inviter_id) AS people
    FROM giveaway_entries
    WHERE giveaway_id = ? AND left_at IS NULL
  `).get(giveawayId);
  return { entries: row?.entries || 0, people: row?.people || 0 };
}

/**
 * Picks winners weighted by entries: three invites is three tickets in the
 * hat, not three times the same name drawn.
 *
 * Uses crypto randomInt rather than Math.random - this decides who gets
 * something worth money, so it should not be predictable.
 *
 * Nobody can win twice. If there are fewer people than prizes, everyone
 * who entered wins once and the draw stops there.
 */
export function drawWinners(giveawayId) {
  const giveaway = getGiveawayById(giveawayId);
  if (!giveaway) return { ok: false, reason: 'not_found' };
  if (giveaway.status === 'drawn') return { ok: false, reason: 'already_drawn' };

  const standings = getStandings(giveawayId);
  if (!standings.length) return { ok: false, reason: 'no_entries' };

  let pool = [];
  for (const row of standings) {
    for (let i = 0; i < row.entries; i += 1) pool.push(row.inviter_id);
  }

  const winners = [];
  const wanted = Math.min(giveaway.winner_count, standings.length);
  while (winners.length < wanted && pool.length) {
    const picked = pool[randomInt(pool.length)];
    winners.push(picked);
    pool = pool.filter((id) => id !== picked);
  }

  const insert = getDb().prepare(`
    INSERT INTO giveaway_winners (giveaway_id, user_id, drawn_at) VALUES (?, ?, ?)
  `);
  const stamp = nowIso();
  const saveAll = getDb().transaction((ids) => {
    for (const id of ids) insert.run(giveawayId, id, stamp);
  });
  saveAll(winners);

  getDb().prepare("UPDATE giveaways SET status = 'drawn', ended_at = COALESCE(ended_at, ?) WHERE id = ?")
    .run(stamp, giveawayId);

  return { ok: true, winners, standings };
}

export function getWinners(giveawayId) {
  return getDb().prepare(`
    SELECT user_id FROM giveaway_winners WHERE giveaway_id = ? ORDER BY id ASC
  `).all(giveawayId).map((r) => r.user_id);
}

import { getDb } from '../db/database.js';
import { nowIso } from '../utils/permissions.js';

export function ensureBuyer(discordId) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM buyers WHERE discord_id = ?').get(discordId);
  if (existing) return existing;

  const ts = nowIso();
  db.prepare(`
    INSERT INTO buyers (discord_id, is_banned, created_at, updated_at)
    VALUES (?, 0, ?, ?)
  `).run(discordId, ts, ts);

  return db.prepare('SELECT * FROM buyers WHERE discord_id = ?').get(discordId);
}

export function getBuyer(discordId) {
  return getDb().prepare('SELECT * FROM buyers WHERE discord_id = ?').get(discordId);
}

/**
 * Find buyers by the shipping name, which is what a label printer prints.
 * Case and surrounding whitespace are ignored. More than one buyer can share
 * a name, so this returns all of them and the caller decides.
 */
export function findBuyersByName(name) {
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return [];
  return getDb()
    .prepare('SELECT * FROM buyers WHERE LOWER(TRIM(name)) = ?')
    .all(needle);
}

export function isBuyerBanned(discordId) {
  const buyer = getBuyer(discordId);
  return Boolean(buyer?.is_banned);
}

export function hasCompleteShippingDetails(buyerOrId) {
  const buyer = typeof buyerOrId === 'string' ? getBuyer(buyerOrId) : buyerOrId;
  if (!buyer) return false;
  return Boolean(
    buyer.name?.trim()
    && buyer.phone?.trim()
    && buyer.shipping_address?.trim()
    && buyer.city?.trim()
    && buyer.state?.trim()
    && buyer.zip?.trim(),
  );
}

export function buyerDetailsFromRow(buyer) {
  if (!buyer || !hasCompleteShippingDetails(buyer)) return null;
  return {
    name: buyer.name,
    phone: buyer.phone,
    shippingAddress: buyer.shipping_address,
    city: buyer.city,
    state: buyer.state,
    zip: buyer.zip,
  };
}

export function updateBuyerDetails(discordId, {
  name,
  phone,
  shippingAddress,
  city,
  state,
  zip,
}) {
  ensureBuyer(discordId);
  getDb().prepare(`
    UPDATE buyers
    SET name = ?, phone = ?, shipping_address = ?, city = ?, state = ?, zip = ?, updated_at = ?
    WHERE discord_id = ?
  `).run(name, phone, shippingAddress, city, state, zip, nowIso(), discordId);
}

export function setBanned(discordId, banned, reason, staffId = null) {
  ensureBuyer(discordId);
  const db = getDb();
  const ts = nowIso();

  db.prepare(`
    UPDATE buyers SET is_banned = ?, updated_at = ? WHERE discord_id = ?
  `).run(banned ? 1 : 0, ts, discordId);

  db.prepare(`
    INSERT INTO ban_history (buyer_id, action, reason, staff_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(discordId, banned ? 'ban' : 'unban', reason, staffId, ts);
}

export function recordAppeal(discordId, reason) {
  ensureBuyer(discordId);
  getDb().prepare(`
    INSERT INTO ban_history (buyer_id, action, reason, staff_id, created_at)
    VALUES (?, 'appeal_submitted', ?, NULL, ?)
  `).run(discordId, reason, nowIso());
}

export function recordAppealOutcome(discordId, accepted, staffId, reason) {
  getDb().prepare(`
    INSERT INTO ban_history (buyer_id, action, reason, staff_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    discordId,
    accepted ? 'appeal_accepted' : 'appeal_rejected',
    reason,
    staffId,
    nowIso(),
  );
}

/**
 * Everyone banned right now, newest ban first: the reason and who did it
 * (no staff id = the bot, for a no-show), and whether they appealed since.
 */
export function listBannedBuyers() {
  return getDb().prepare(`
    SELECT b.discord_id, b.name, h.reason, h.staff_id, h.created_at AS banned_at,
      (SELECT COUNT(*) FROM ban_history a
        WHERE a.buyer_id = b.discord_id AND a.action = 'appeal_submitted'
          AND a.created_at >= COALESCE(h.created_at, '')) AS appeals
    FROM buyers b
    LEFT JOIN ban_history h ON h.id = (
      SELECT id FROM ban_history
      WHERE buyer_id = b.discord_id AND action = 'ban'
      ORDER BY created_at DESC, id DESC LIMIT 1
    )
    WHERE b.is_banned = 1
    ORDER BY h.created_at DESC
  `).all();
}

/** Bans lifted in the last `days` days, newest first, for buyers not banned again since. */
export function listRecentUnbans(days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return getDb().prepare(`
    SELECT h.buyer_id AS discord_id, b.name, h.reason, h.staff_id, h.created_at AS unbanned_at
    FROM ban_history h JOIN buyers b ON b.discord_id = h.buyer_id
    WHERE h.action = 'unban' AND h.created_at >= ? AND b.is_banned = 0
    ORDER BY h.created_at DESC
  `).all(since);
}

export function getBanHistory(discordId) {
  return getDb()
    .prepare('SELECT * FROM ban_history WHERE buyer_id = ? ORDER BY created_at DESC')
    .all(discordId);
}

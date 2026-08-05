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
    && buyer.shipping_address?.trim(),
  );
}

export function updateBuyerDetails(discordId, { name, phone, shippingAddress }) {
  ensureBuyer(discordId);
  getDb().prepare(`
    UPDATE buyers
    SET name = ?, phone = ?, shipping_address = ?, updated_at = ?
    WHERE discord_id = ?
  `).run(name, phone, shippingAddress, nowIso(), discordId);
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

export function getBanHistory(discordId) {
  return getDb()
    .prepare('SELECT * FROM ban_history WHERE buyer_id = ? ORDER BY created_at DESC')
    .all(discordId);
}

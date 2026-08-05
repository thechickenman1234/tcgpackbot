import { getDb } from '../db/database.js';

export function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM bot_meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

export function setMeta(key, value) {
  getDb().prepare(`
    INSERT INTO bot_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

export function clearMeta(key) {
  getDb().prepare('DELETE FROM bot_meta WHERE key = ?').run(key);
}

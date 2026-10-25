import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Instagram DMs for @tcgpackbot, through Zernio (the same account that
 * schedules the posts). Zernio calls the bot's /hooks/zernio the moment a
 * DM arrives, and the bot replies through Zernio's inbox API.
 *
 * Instagram only lets a business reply inside 24 hours of the other side's
 * last message. A quote Lachy taps Send on is a person answering a shop, so
 * outside those 24 hours it's retried as a human agent's reply, which
 * Instagram allows for 7 days. Past that, or for anything else, the text
 * comes back for Lachy to send from the app.
 */

const BASE = 'https://zernio.com/api/v1';
// Instagram turns longer DMs down, so a long quote goes as several.
const MAX_DM = 950;

export const zernioReady = () => Boolean(config.zernioApiKey);

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.zernioApiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const error = new Error(json?.error || json?.message || `Zernio answered ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return json;
}

/** Splits a long message on line breaks so no piece is over Instagram's limit. */
export function chunks(text, max = MAX_DM) {
  const out = [];
  let current = '';
  for (const line of String(text).split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= max) { current = next; continue; }
    if (current) out.push(current);
    current = line.slice(0, max);
  }
  if (current) out.push(current);
  return out;
}

/**
 * Sends a DM into a conversation. Returns { ok } or { error, outsideWindow }.
 *
 * `humanAgent` allows the retry as a human agent's reply. Meta keeps that tag
 * for a person answering someone who asked, so it's only for sends Lachy
 * tapped in reply to a shop; anything the bot sends by itself, or asks of the
 * supplier, stays inside the normal 24 hours.
 */
export async function sendDm(conversationId, text, { humanAgent = false } = {}) {
  if (!zernioReady()) return { error: 'ZERNIO_API_KEY is not set on Railway yet, so the bot can\'t send DMs.' };
  if (!conversationId) return { error: 'There is no Instagram chat with them on @tcgpackbot yet.' };
  const path = `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`;
  for (const piece of chunks(text)) {
    const body = { accountId: config.zernioInstagramId, message: piece };
    try {
      await call('POST', path, body);
    } catch (err) {
      if (err.status >= 500) return { error: `Zernio failed: ${err.message}` };
      if (!humanAgent) return { error: `Instagram turned it down (most likely more than 24 hours since their last message): ${err.message}`, outsideWindow: true };
      try {
        await call('POST', path, { ...body, messagingType: 'MESSAGE_TAG', messageTag: 'HUMAN_AGENT' });
      } catch (again) {
        return { error: `Instagram turned it down: ${again.message}`, outsideWindow: true };
      }
    }
  }
  return { ok: true };
}

/** The @tcgpackbot chat with someone, by their Instagram username. */
export async function findConversation(username) {
  if (!zernioReady()) return null;
  const want = String(username || '').replace(/^@/, '').toLowerCase();
  const res = await call('GET', `/inbox/conversations?accountId=${config.zernioInstagramId}&platform=instagram&limit=100`);
  return (res?.data || []).find((c) => String(c.participantUsername || '').toLowerCase() === want) || null;
}

/** Zernio signs each delivery: lowercase hex HMAC-SHA256 of the raw body. */
export function verifySignature(rawBody, signature) {
  if (!config.zernioWebhookSecret || !signature) return false;
  const expected = crypto.createHmac('sha256', config.zernioWebhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature).trim().toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

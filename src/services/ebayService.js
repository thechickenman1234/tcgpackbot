import crypto from 'node:crypto';
import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { clearMeta, getMeta, setMeta } from './metaService.js';

/**
 * The bot's link to Lachy's eBay account (eBay Australia), through eBay's
 * own APIs and his own developer keys: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET
 * and EBAY_RUNAME on Railway, from developer.ebay.com.
 *
 * He connects once, from the dashboard: eBay asks him to agree, then sends
 * him back to /ebay/callback with a code. That's swapped for a refresh
 * token (good for about 18 months), kept encrypted in bot_meta, and every
 * call after that uses a 2-hour access token made from it. When eBay ends
 * the connection, the dashboard and the health check say to connect again.
 *
 * eBay also requires every app that keeps buyer details to hear about
 * closed accounts: /ebay/account-deletion answers eBay's check with
 * EBAY_VERIFY_TOKEN and wipes a closed account's name and address.
 *
 * Calls go to eBay's REST APIs (orders, messages, feedback, account) and,
 * for the listings Lachy makes in Seller Hub, the older Trading API, which
 * is the one that can change their quantity and price.
 */

const API = 'https://api.ebay.com';
const IDENTITY = 'https://apiz.ebay.com';
const AUTHORIZE = 'https://auth.ebay.com/oauth2/authorize';
const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const TRADING_URL = 'https://api.ebay.com/ws/api.dll';
export const MARKETPLACE = 'EBAY_AU';
const SITE_ID = '15';
const TRADING_LEVEL = '1349';
const AUTH_KEY = 'ebay_auth';
const STATE_KEY = 'ebay_connect_state';
const MINUTE = 60000;

// Messages and feedback are newer APIs. If eBay won't give them to the app,
// connecting again without them still gets orders, stock and prices going.
const CORE_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
];
const EXTRA_SCOPES = [
  'https://api.ebay.com/oauth/api_scope/commerce.message',
  'https://api.ebay.com/oauth/api_scope/commerce.feedback',
];
const scopesFor = (set) => (set === 'core' ? CORE_SCOPES : [...CORE_SCOPES, ...EXTRA_SCOPES]);

export class EbayError extends Error {
  constructor(message, status = null, body = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export const ebayKeys = () => Boolean(config.ebayClientId && config.ebayClientSecret && config.ebayRuName);
export const deletionUrl = () => `${config.publicUrl}/ebay/account-deletion`;
export const callbackUrl = () => `${config.publicUrl}/ebay/callback`;

// ---------------------------------------------------------------- the stored connection

// The refresh token is sealed with a key made from the client secret, so the
// database alone can't be used to act on the eBay account.
const sealKey = () => crypto.createHash('sha256').update(`${config.ebayClientSecret}:tcgpackbot-ebay-v1`).digest();

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

function unseal(text) {
  try {
    const [iv, tag, data] = String(text || '').split('.').map((s) => Buffer.from(s, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', sealKey(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

function loadAuth() {
  try {
    return JSON.parse(getMeta(AUTH_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveAuth(auth) {
  setMeta(AUTH_KEY, JSON.stringify(auth));
}

/** Who's connected, what kind of account and store it is, and whether the link still works. */
export function ebayAccount() {
  const a = loadAuth();
  if (!a?.tokens) return null;
  const { tokens, ...rest } = a;
  return rest;
}

export const ebayConnected = () => Boolean(ebayKeys() && loadAuth()?.tokens && !loadAuth()?.broken);
export const hasExtras = () => ebayAccount()?.scopeSet !== 'core';

export function disconnectEbay() {
  clearMeta(AUTH_KEY);
  cached = null;
}

// ---------------------------------------------------------------- tokens

async function tokenCall(params) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${config.ebayClientId}:${config.ebayClientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams(params).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new EbayError(json.error_description || json.error || `eBay said ${res.status}`, res.status, json);
    err.code = json.error || null;
    throw err;
  }
  return json;
}

let cached = null;
let appCached = null;

/** A user access token, made fresh from the refresh token when it's within 5 minutes of running out. */
export async function accessToken() {
  if (cached && cached.exp - Date.now() > 5 * MINUTE) return cached.token;
  const auth = loadAuth();
  const sealed = auth?.tokens ? unseal(auth.tokens) : null;
  if (!sealed?.refresh) throw new EbayError('eBay isn\'t connected. Press Connect eBay on the dashboard.', 401);
  try {
    const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: sealed.refresh, scope: scopesFor(auth.scopeSet).join(' ') });
    cached = { token: t.access_token, exp: Date.now() + Number(t.expires_in || 7200) * 1000 };
    if (auth.broken) {
      delete auth.broken;
      saveAuth(auth);
    }
    return cached.token;
  } catch (err) {
    // invalid_grant: the refresh token has run out or been taken back.
    if (err.code === 'invalid_grant') {
      auth.broken = 'eBay ended the connection. Press Connect eBay on the dashboard to connect again.';
      saveAuth(auth);
    }
    throw err;
  }
}

/** An app token, for reading public listings (the price check). */
async function appToken() {
  if (appCached && appCached.exp - Date.now() > 5 * MINUTE) return appCached.token;
  const t = await tokenCall({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' });
  appCached = { token: t.access_token, exp: Date.now() + Number(t.expires_in || 7200) * 1000 };
  return appCached.token;
}

// ---------------------------------------------------------------- connecting

/** Where Connect eBay sends him: eBay's agree page, with a one-time state that comes back. */
export function connectUrl({ scopeSet = 'full' } = {}) {
  const state = crypto.randomBytes(18).toString('base64url');
  setMeta(STATE_KEY, JSON.stringify({ state, scopeSet, exp: Date.now() + 15 * MINUTE }));
  const query = new URLSearchParams({
    client_id: config.ebayClientId,
    redirect_uri: config.ebayRuName,
    response_type: 'code',
    scope: scopesFor(scopeSet).join(' '),
    state,
  });
  return `${AUTHORIZE}?${query.toString().replace(/\+/g, '%20')}`;
}

/**
 * eBay sent him back. Swaps the code for tokens, then reads who the account
 * is. Returns { ok, username } or { error, retryCore }.
 */
export async function finishConnect({ code, state, error }) {
  let saved = null;
  try {
    saved = JSON.parse(getMeta(STATE_KEY) || 'null');
  } catch {
    saved = null;
  }
  clearMeta(STATE_KEY);
  const fresh = Boolean(saved && state && saved.state === state && saved.exp > Date.now());
  if (error) {
    if (error === 'invalid_scope' && fresh && saved.scopeSet !== 'core') return { error: 'eBay wouldn\'t allow messages and feedback for this app yet.', retryCore: true };
    return { error: error === 'access_denied' ? 'You said no on eBay, so nothing was connected.' : `eBay said: ${error}` };
  }
  if (!code) return { error: 'eBay didn\'t send a code back. Press Connect eBay on the dashboard again.' };
  if (!fresh) return { error: 'That eBay link has expired. Press Connect eBay on the dashboard again.' };
  const t = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: config.ebayRuName });
  saveAuth({
    tokens: seal({ refresh: t.refresh_token }),
    refreshUntil: new Date(Date.now() + Number(t.refresh_token_expires_in || 0) * 1000).toISOString(),
    scopeSet: saved.scopeSet || 'full',
    connectedAt: new Date().toISOString(),
  });
  cached = { token: t.access_token, exp: Date.now() + Number(t.expires_in || 7200) * 1000 };
  const account = await refreshAccount().catch((err) => ({ error: err.message }));
  return { ok: true, username: account?.username || null };
}

const pretty = (s) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Reads the account's name, whether it's a business, its store plan and its monthly selling limit. */
export async function refreshAccount() {
  const me = await ebayApi('GET', '/commerce/identity/v1/user/', { host: IDENTITY });
  const subs = await ebayApi('GET', '/sell/account/v1/subscription').catch(() => null);
  const priv = await ebayApi('GET', '/sell/account/v1/privilege').catch(() => null);
  const store = (subs?.subscriptions || []).find((s) => /STORE/i.test(s.subscriptionType || '') && (!s.marketplaceId || s.marketplaceId === MARKETPLACE));
  const limit = priv?.sellingLimit;
  const auth = loadAuth() || {};
  Object.assign(auth, {
    username: me.username || auth.username || null,
    userId: me.userId || null,
    accountType: me.accountType || null,
    store: store ? pretty(store.subscriptionLevel) : null,
    limit: limit ? {
      quantity: limit.quantity ?? null,
      amountCents: limit.amount?.value != null ? Math.round(Number(limit.amount.value) * 100) : null,
    } : null,
    registered: priv ? priv.sellerRegistrationCompleted !== false : null,
    checkedAt: new Date().toISOString(),
  });
  saveAuth(auth);
  return auth;
}

/** Remembers whether out-of-stock control is on (ebayListings checks it). */
export function noteAccount(fields) {
  const auth = loadAuth();
  if (!auth) return;
  saveAuth({ ...auth, ...fields });
}

// ---------------------------------------------------------------- calls

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function errorText(json, text, status) {
  const errs = json?.errors || json?.error ? (json.errors || [json.error]) : [];
  const words = errs.map((e) => (typeof e === 'string' ? e : e?.longMessage || e?.message)).filter(Boolean).join(' ');
  return words || `eBay said ${status}${text && !json ? `: ${String(text).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
}

/**
 * A REST call. `app` uses the app token (public listings); everything else
 * acts as Lachy. Busy and server errors are tried again twice.
 */
export async function ebayApi(method, path, { query = null, body = null, app = false, host = API, headers = {} } = {}) {
  const token = app ? await appToken() : await accessToken();
  const url = new URL(host + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Accept-Language': 'en-AU',
        'Content-Language': 'en-AU',
        'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE,
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) throw new EbayError(errorText(json, text, res.status), res.status, json);
    return json || {};
  }
}

// ---------------------------------------------------------------- the Trading API (XML)

export const xmlEscape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

function addChild(node, name, value) {
  if (!(name in node)) node[name] = value;
  else if (Array.isArray(node[name])) node[name].push(value);
  else node[name] = [node[name], value];
}

/**
 * Just enough XML for Trading API answers: elements become keys, repeated
 * elements arrays, and an element with no children its text. Attributes are
 * dropped (eBay only puts currency codes in them).
 */
export function parseXml(xml) {
  const root = {};
  const stack = [{ node: root, name: null, text: '' }];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += decode(m[6]);
    else if (m[3]) {
      const name = m[3].replace(/^[\w.-]+:/, '');
      if (m[2]) {
        if (stack.length > 1) {
          const done = stack.pop();
          addChild(stack[stack.length - 1].node, done.name, Object.keys(done.node).length ? done.node : done.text.trim());
        }
      } else if (m[5]) addChild(top.node, name, '');
      else stack.push({ node: {}, name, text: '' });
    }
  }
  return root;
}

export const asArray = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);

/** One Trading API call, as Lachy. Returns the parsed <CallResponse>; a Failure throws with eBay's words. */
export async function trading(call, innerXml) {
  const token = await accessToken();
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<${call}Request xmlns="urn:ebay:apis:eBLBaseComponents">${innerXml}<ErrorLanguage>en_AU</ErrorLanguage><WarningLevel>High</WarningLevel></${call}Request>`;
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(TRADING_URL, {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': call,
        'X-EBAY-API-SITEID': SITE_ID,
        'X-EBAY-API-COMPATIBILITY-LEVEL': TRADING_LEVEL,
        'X-EBAY-API-IAF-TOKEN': token,
        'Content-Type': 'text/xml',
      },
      body,
    });
    if (res.status >= 500 && attempt < 2) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    const answer = parseXml(await res.text())[`${call}Response`] || {};
    const errors = asArray(answer.Errors).filter((e) => e.SeverityCode !== 'Warning');
    if (!res.ok || answer.Ack === 'Failure' || (answer.Ack === 'PartialFailure' && errors.length)) {
      const words = errors.map((e) => e.LongMessage || e.ShortMessage).filter(Boolean).join(' ');
      throw new EbayError(words || `eBay said ${res.status}`, res.status, answer);
    }
    return answer;
  }
}

// ---------------------------------------------------------------- closed accounts

/** eBay's check on /ebay/account-deletion: sha256 of the challenge, our token and the address, in that order. */
export function deletionChallenge(code) {
  return crypto.createHash('sha256').update(String(code)).update(config.ebayVerifyToken).update(deletionUrl()).digest('hex');
}

export const ebayBuyerId = (username) => `ext:ebay-${String(username || 'buyer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'buyer'}`;

/**
 * A closed eBay account: its name, phone and address go, and its messages.
 * A buyer still waiting on a parcel keeps their address until it's posted
 * (the sync wipes it after), since a stray notice can't be told from a real
 * one without the address on the label.
 */
export function forgetEbayUser(username, { now = new Date() } = {}) {
  if (!username) return { forgotten: false };
  const db = getDb();
  const id = ebayBuyerId(username);
  const open = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE buyer_id = ? AND status = 'paid'").get(id).n;
  db.prepare('DELETE FROM ebay_inbox WHERE LOWER(who) = LOWER(?)').run(username);
  if (open) {
    const pending = new Set(JSON.parse(getMeta('ebay_forget') || '[]'));
    pending.add(username);
    setMeta('ebay_forget', JSON.stringify([...pending]));
    return { forgotten: false, waiting: open };
  }
  db.prepare(`
    UPDATE buyers SET name = 'Closed eBay account', phone = NULL, shipping_address = NULL, city = NULL, state = NULL, zip = NULL, updated_at = ?
    WHERE discord_id = ?
  `).run(now.toISOString(), id);
  db.prepare('UPDATE ebay_orders SET buyer = NULL WHERE LOWER(buyer) = LOWER(?)').run(username);
  return { forgotten: true };
}

/** Wipes the closed accounts that were waiting on a parcel, once it's gone. */
export function forgetWaitingUsers() {
  const pending = JSON.parse(getMeta('ebay_forget') || '[]');
  if (!pending.length) return;
  const still = pending.filter((u) => !forgetEbayUser(u).forgotten);
  setMeta('ebay_forget', JSON.stringify(still));
}

import { config } from '../config.js';

/**
 * Wholesale box prices, worked out exactly as the wholesale price page
 * (site/wholesale-pricing.html) does it, so a quote from the bot always
 * matches what the shop saw:
 *
 *   price per box  supplier cost in AUD plus a markup that drops with volume
 *
 *                    1-9 boxes   10-19 boxes   20+ boxes
 *       Japan           10%          9%            8%
 *       China           12%         11%           10%
 *
 *   The tier is set by the total boxes per country, across every set.
 *   The sheet's AUD already carries 10%, so cost is that divided by 1.10.
 *
 * Change the tiers or the sets on offer in both places, or the page and the
 * bot will quote different prices.
 */

const SHEET_MARKUP = 1.10;
export const TIERS = {
  jp: [
    { from: 1, markup: 1.10, label: '1–9 boxes' },
    { from: 10, markup: 1.09, label: '10–19 boxes' },
    { from: 20, markup: 1.08, label: '20+ boxes' },
  ],
  cn: [
    { from: 1, markup: 1.12, label: '1–9 boxes' },
    { from: 10, markup: 1.11, label: '10–19 boxes' },
    { from: 20, markup: 1.10, label: '20+ boxes' },
  ],
};
export const MIN_BOXES = 5;
export const REGION_NAMES = { jp: 'Japanese', cn: 'Chinese' };

const KEEP = {
  jp: [
    /^Storm Emeralda/i, /^Abyss Eye/i, /^Ninja Spinner/i, /^Nihil Zero/i,
    /^Mega Dream ex/i, /^Inferno X/i, /^Mega Symphonia/i, /^Mega Brave/i,
    /^Black Volt/i, /^White Flare/i, /^Glory of Team Rocket/i,
    /^Terastal Festa/i, /^Ruler of Black Flame/i, /^VSTAR Universe/i,
    /^Pokemon Card 151/i, /^30th/i,
  ],
  cn: [
    /30th/i, /^Espeon & Umbreon Display/i, /^Greninja Display/i,
    /^Sylveon Display/i, /^Umbreon Premium/i, /^Espeon Premium/i,
    /^Gem /i, /^CSV10C/i, /^CSV9\.5C/i, /^CSV9C/i,
    /Team Rocket's Ambition/i, /^Altaria gift box/i, /^151 vol/i,
  ],
};
const keep = (region, name) => KEEP[region].some((re) => re.test(name));

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const money = (s) => {
  const n = parseFloat(String(s || '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const cleanName = (s) => String(s || '').replace(/^\s*\d+\s*:\s*/, '').replace(/　/g, ' ')
  .replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim();

/** Same rounding as the page: never dearer per box for a bigger order. */
export function tierPrices(aud, tiers) {
  const cost = aud / SHEET_MARKUP;
  const p = tiers.map((t) => {
    if (t.markup === SHEET_MARKUP) return Math.ceil(aud);
    return t.markup > SHEET_MARKUP ? Math.ceil(cost * t.markup) : Math.round(cost * t.markup);
  });
  for (let i = 1; i < p.length; i += 1) p[i] = Math.min(p[i], p[i - 1]);
  return p;
}

export function buildJP(rows) {
  const out = [];
  for (const r of rows) {
    if (r.length < 11) continue;
    const name = cleanName(r[0]);
    if (!name || name === 'Product') continue;
    let aud = null;
    let hasBox = false;
    for (const [f, a] of [[r[1], r[3]], [r[4], r[6]], [r[7], r[9]]]) {
      if (String(f).trim().toUpperCase() !== 'BOX') continue;
      hasBox = true;
      if (money(a)) { aud = money(a); break; }
    }
    const stock = (r[10] || '').trim();
    if (!hasBox || !keep('jp', name)) continue;
    if (aud === null && /sold\s*out/i.test(stock)) continue;
    out.push({ region: 'jp', name, spec: 'Sealed box', stock, aud, prices: aud === null ? null : tierPrices(aud, TIERS.jp) });
  }
  return out;
}

export function buildCN(rows) {
  const out = [];
  for (const r of rows) {
    if (r.length < 6) continue;
    const name = cleanName(r[0]);
    if (!name || name === 'Product' || !keep('cn', name)) continue;
    const aud = money(r[5]);
    out.push({ region: 'cn', name, spec: (r[1] || '').trim() || 'Sealed box', stock: '', aud, prices: aud === null ? null : tierPrices(aud, TIERS.cn) });
  }
  return out;
}

let cache = null;
const CACHE_MS = 10 * 60000;

/** Today's sets and prices from the supplier sheets, cached for ten minutes. */
export async function loadPrices({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache;
  const get = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`price sheet answered ${res.status}`);
    return res.text();
  };
  const [jp, cn] = await Promise.all([get(config.wholesaleCsvJp), get(config.wholesaleCsvCn)]);
  cache = { at: Date.now(), jp: buildJP(parseCsv(jp)), cn: buildCN(parseCsv(cn)) };
  return cache;
}

/** For tests: price from rows already in hand. */
export function setPricesForTest(data) {
  cache = { at: Date.now(), ...data };
}

function tierIndex(region, boxes) {
  let i = 0;
  TIERS[region].forEach((t, n) => { if (boxes >= t.from) i = n; });
  return i;
}

const findProduct = (data, line) => (data[line.region] || []).find((p) => p.name === line.name && p.spec === line.spec) || null;

/**
 * Prices an order: [{ region, name, spec, qty }] in, each line with its
 * price per box and total out, plus the per-country tiers and the minimum.
 */
export function priceLines(lines, data) {
  const boxes = { jp: 0, cn: 0 };
  for (const l of lines) if (l.override != null || findProduct(data, l)?.prices) boxes[l.region] += l.qty;
  const tier = { jp: tierIndex('jp', boxes.jp), cn: tierIndex('cn', boxes.cn) };
  const priced = lines.map((l) => {
    const p = findProduct(data, l);
    // A price typed on the line ("@ 95") wins: the Chinese sheet often has none.
    const sheet = p?.prices ? p.prices[Math.min(tier[l.region], p.prices.length - 1)] : null;
    const price = l.override ?? sheet;
    return { ...l, price, total: price == null ? null : price * l.qty, cost: p?.aud ? p.aud / SHEET_MARKUP : null };
  });
  const sub = (region) => priced.filter((l) => l.region === region && l.total != null).reduce((t, l) => t + l.total, 0);
  return {
    lines: priced,
    jp: { boxes: boxes.jp, sub: sub('jp'), tierLabel: TIERS.jp[tier.jp].label },
    cn: { boxes: boxes.cn, sub: sub('cn'), tierLabel: TIERS.cn[tier.cn].label },
    total: sub('jp') + sub('cn'),
    unpriced: priced.filter((l) => l.price == null).map((l) => l.name),
    short: ['jp', 'cn'].filter((r) => boxes[r] > 0 && boxes[r] < MIN_BOXES),
  };
}

/**
 * The text the price page's "Copy my order" makes:
 *
 *   TCG Pack Bot — wholesale order
 *   JAPANESE
 *     10x VSTAR Universe @ $281 = $2,810
 *   CHINESE
 *     20x Gem vol.5 (12 boxes per case) @ $95 = $1,900
 *
 * Returns the lines, or null when the text isn't one.
 */
export function parseCartText(text) {
  const t = String(text || '');
  if (!/wholesale order/i.test(t)) return null;
  let region = null;
  const lines = [];
  for (const raw of t.split(/\r?\n/)) {
    const s = raw.trim();
    if (/^JAPANESE$/i.test(s)) { region = 'jp'; continue; }
    if (/^CHINESE$/i.test(s)) { region = 'cn'; continue; }
    const m = s.match(/^(\d+)\s*x\s+(.+?)\s+@\s+\$/i);
    if (!m || !region) continue;
    let name = m[2];
    let spec = 'Sealed box';
    const specMatch = name.match(/^(.*) \(([^()]+)\)$/);
    if (specMatch) { name = specMatch[1]; spec = specMatch[2]; }
    lines.push({ region, name, spec, qty: Number(m[1]) });
  }
  return lines.length ? lines : null;
}

const tokens = (s) => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9.]+/g, ' ').replace(/\b(vol|v)\.?\s*(\d)/g, 'vol $2').replace(/\./g, ' ')
  .split(/\s+/).filter(Boolean);

/**
 * Lines typed by hand, one per line or comma: "10 vstar universe",
 * "5x terastal festa", "gem vol 5 x20", "jp 30th x 10". A line naming
 * Japanese or Chinese (jp, cn) only matches that country's sets. "@ 95" on
 * the end sets the price per box; with jp or cn named, that also works for a
 * set that isn't on the sheet at all.
 */
export function matchTyped(text, data) {
  const lines = [];
  const unmatched = [];
  for (const raw of String(text || '').split(/[\n;]+|,(?!\d)/)) {
    let s = raw.trim();
    if (!s) continue;
    let override = null;
    const at = s.match(/\s*@\s*\$?\s*(\d+(?:\.\d+)?)\s*$/);
    if (at) { override = Number(at[1]); s = s.slice(0, at.index).trim(); }
    let qty = null;
    let m = s.match(/^(\d[\d,]*)\s*x?\s+(.+)$/i);
    if (m) { qty = Number(m[1].replace(/,/g, '')); s = m[2]; } else if ((m = s.match(/^(.+?)\s*(?:x\s*|\s)(\d+)$/i))) { qty = Number(m[2]); s = m[1]; }
    if (!qty) { unmatched.push(raw.trim()); continue; }
    let region = null;
    const lang = s.match(/^(jp|jpn|japanese|cn|chn|chinese)\b\s*/i);
    if (lang) { region = /^j/i.test(lang[1]) ? 'jp' : 'cn'; s = s.slice(lang[0].length); }
    const want = tokens(s);
    if (!want.length) { unmatched.push(raw.trim()); continue; }
    const pool = region ? data[region] : [...data.jp, ...data.cn];
    const hits = pool.filter((p) => {
      const have = tokens(`${p.name} ${p.spec}`);
      return want.every((w) => have.some((h) => h === w || (w.length >= 3 && h.startsWith(w))));
    });
    // Priced sets first, then the shortest name: "vstar universe" means the box, not a variant of it.
    hits.sort((a, b) => (b.prices ? 1 : 0) - (a.prices ? 1 : 0) || a.name.length - b.name.length);
    const best = hits[0];
    const rivals = hits.filter((h) => h !== best && h.name.length === best.name.length && Boolean(h.prices) === Boolean(best.prices));
    if (rivals.length) {
      const label = (h) => `${REGION_NAMES[h.region]} ${h.name}${h.spec !== 'Sealed box' ? ` (${h.spec})` : ''}`;
      unmatched.push(`${raw.trim()} (could be ${[best, ...rivals].map(label).join(' or ')})`);
      continue;
    }
    if (!best) {
      // Not on the sheet: fine when they said which country and what it costs.
      if (region && override != null) lines.push({ region, name: s, spec: 'Sealed box', qty, override });
      else unmatched.push(`${raw.trim()}${override != null && !region ? ' (say jp or cn for a set not on the sheet)' : ''}`);
      continue;
    }
    if (!best.prices && override == null) {
      unmatched.push(`${raw.trim()} (no price on the sheet today: add one like "@ 95")`);
      continue;
    }
    lines.push({ region: best.region, name: best.name, spec: best.spec, qty, ...(override != null ? { override } : {}) });
  }
  return { lines, unmatched };
}

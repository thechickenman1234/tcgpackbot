import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { getMeta, setMeta } from './metaService.js';
import { findProductByName, getProductById } from './productService.js';
import { asArray, ebayAccount, ebayApi, noteAccount, trading, xmlEscape } from './ebayService.js';

/**
 * eBay listings, kept in step with the shelf.
 *
 * Lachy makes each listing once in Seller Hub (photos, title, description,
 * postage and returns: eBay's own form does that best). The bot finds them;
 * he picks the product each one sells and how many are on the shelf for
 * eBay, and from then on the bot keeps the listing right:
 *
 *   quantity  what's on the shelf. A sale takes one off here as eBay takes
 *             one off the listing; stock that arrives is added on the
 *             dashboard and the listing goes back up.
 *   price     his landed cost, plus his margin, plus postage, grossed up for
 *             eBay's fees, so every sale makes the margin he set. A typed
 *             price instead overrides it.
 *
 * The cheapest Australian sellers are shown next to his price for
 * reference only, never copied: plenty of the cheapest boxes are fakes.
 * A price that would jump more than a third either way (a typo in a cost)
 * is held for him to OK first. Out-of-stock control keeps a listing alive
 * at 0, hidden from search, so its sales history is there for the restock.
 */

const SETTINGS_KEY = 'ebay_settings';
const DAY = 86400000;
const PRICE_SWING = { low: 0.67, high: 1.5 };

export const DEFAULT_SETTINGS = {
  // Profit on top of the landed cost, after eBay's fees and the postage.
  marginPct: 20,
  // Label Pro label plus packing for one box, paid by us (postage is free to the buyer).
  postageCents: 500,
  // eBay Australia, Collectables: 13.4% of the total plus 30c an order (checked Sept 2026).
  feePct: 13.4,
  feeFlatCents: 30,
  thankYou: true,
  thankText: 'Hi {name}, thanks for buying from us! Your {item} should have arrived by now. If anything isn\'t right, reply here and we\'ll sort it out fast. If you\'re happy with it, we\'d really appreciate your feedback. Cheers, Lachy',
};

export function ebaySettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(getMeta(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const num = (v) => (v === '' || v === null || v === undefined ? null : Number(String(v).replace(/[$,%\s]/g, '')));
const dollarsToCents = (v) => {
  const n = num(v);
  return n === null || !Number.isFinite(n) ? null : Math.round(n * 100);
};

/** Saves the defaults typed on the dashboard. Returns { settings } or { error }. */
export function saveEbaySettings(input = {}) {
  const s = ebaySettings();
  if (input.marginPct !== undefined) {
    const m = num(input.marginPct);
    if (m === null || !Number.isFinite(m) || m < 0 || m > 300) return { error: 'Margin should be a percentage, like 15.' };
    s.marginPct = m;
  }
  if (input.postage !== undefined) {
    const c = dollarsToCents(input.postage);
    if (c === null || c < 0 || c > 10000) return { error: 'Postage should be dollars, like 5.' };
    s.postageCents = c;
  }
  if (input.feePct !== undefined) {
    const f = num(input.feePct);
    if (f === null || !Number.isFinite(f) || f < 0 || f > 40) return { error: 'eBay\'s fee should be a percentage, like 13.4.' };
    s.feePct = f;
  }
  if (input.thankYou !== undefined) s.thankYou = input.thankYou !== false;
  if (input.thankText !== undefined) {
    const text = String(input.thankText || '').trim();
    if (text.length < 20 || text.length > 1500) return { error: 'The thank-you should be a sentence or two (under 1,500 letters).' };
    // eBay removes messages that send buyers off eBay.
    if (/https?:|www\.|discord|instagram|tcgpackbot\.com|@/i.test(text)) return { error: 'Leave links, Discord and Instagram out: eBay blocks messages that send buyers off eBay.' };
    s.thankText = text;
  }
  setMeta(SETTINGS_KEY, JSON.stringify(s));
  return { settings: s };
}

// ---------------------------------------------------------------- the maths

/** The price that makes `marginPct` on the cost after fees and postage, ending in .95. */
export function marginPrice(costCents, { marginPct, postageCents, feePct, feeFlatCents }) {
  if (!costCents) return null;
  const net = costCents * (1 + marginPct / 100) + postageCents + feeFlatCents;
  const gross = net / (1 - feePct / 100);
  return Math.ceil((gross + 5) / 100) * 100 - 5;
}

/** What one sale at `priceCents` leaves after eBay's cut, the postage and the box. */
export function profitAt(priceCents, costCents, { postageCents, feePct, feeFlatCents }) {
  if (!priceCents || !costCents) return null;
  return Math.round(priceCents * (1 - feePct / 100) - feeFlatCents - postageCents - costCents);
}

function terms(row, s = ebaySettings()) {
  return {
    marginPct: row.margin_pct ?? s.marginPct,
    postageCents: row.postage_cents ?? s.postageCents,
    feePct: s.feePct,
    feeFlatCents: s.feeFlatCents,
  };
}

/** What the listing should show: quantity, price, and whether a price change is held. */
export function wanted(row, s = ebaySettings()) {
  const product = row.product_id ? getProductById(row.product_id) : null;
  const t = terms(row, s);
  const auto = product ? marginPrice(product.cost_cents, t) : null;
  const price = row.fixed_price_cents || auto;
  return {
    product,
    qty: row.on_hand,
    price,
    priceFrom: row.fixed_price_cents ? 'typed' : auto ? 'margin' : null,
    profit: price && product ? profitAt(price, product.cost_cents, t) : null,
    terms: t,
  };
}

// ---------------------------------------------------------------- reading the listings

export const getListing = (itemId) => getDb().prepare('SELECT * FROM ebay_listings WHERE item_id = ?').get(String(itemId));
export const allListings = () => getDb().prepare('SELECT * FROM ebay_listings ORDER BY active DESC, title').all();

const cents = (v) => (v === undefined || v === null || v === '' ? null : Math.round(Number(typeof v === 'object' ? v.value ?? v : v) * 100));

function saveSeen(it, now) {
  const db = getDb();
  const itemId = String(it.ItemID);
  const sold = Number(it.SellingStatus?.QuantitySold || 0);
  const qty = it.QuantityAvailable !== undefined ? Number(it.QuantityAvailable) : Math.max(0, Number(it.Quantity || 0) - sold);
  const price = cents(it.SellingStatus?.CurrentPrice) ?? cents(it.BuyItNowPrice) ?? cents(it.StartPrice);
  const fixed = !it.ListingType || /FixedPrice/i.test(it.ListingType);
  const values = {
    title: String(it.Title || itemId).slice(0, 200),
    sku: it.SKU ? String(it.SKU) : null,
    url: it.ListingDetails?.ViewItemURL || `https://www.ebay.com.au/itm/${itemId}`,
    image: it.PictureDetails?.GalleryURL || (Array.isArray(it.PictureDetails?.PictureURL) ? it.PictureDetails.PictureURL[0] : it.PictureDetails?.PictureURL) || null,
  };
  if (db.prepare('SELECT 1 FROM ebay_listings WHERE item_id = ?').get(itemId)) {
    db.prepare(`
      UPDATE ebay_listings SET title = ?, sku = ?, url = ?, image_url = COALESCE(?, image_url), ebay_qty = ?, ebay_price_cents = ?,
        active = ?, seen_at = ? WHERE item_id = ?
    `).run(values.title, values.sku, values.url, values.image, qty, price, fixed ? 1 : 0, now, itemId);
  } else {
    db.prepare(`
      INSERT INTO ebay_listings (item_id, title, sku, url, image_url, ebay_qty, ebay_price_cents, active, seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(itemId, values.title, values.sku, values.url, values.image, qty, price, fixed ? 1 : 0, now, now);
  }
  return itemId;
}

/** Every active listing on the account, from Seller Hub's own list. Ended ones stay, marked inactive. */
export async function syncListings({ now = new Date() } = {}) {
  const stamp = now.toISOString();
  const seen = [];
  for (let page = 1; page <= 10; page += 1) {
    const r = await trading('GetMyeBaySelling',
      `<ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList>`);
    const list = r.ActiveList || {};
    for (const it of asArray(list.ItemArray?.Item)) seen.push(saveSeen(it, stamp));
    if (page >= Number(list.PaginationResult?.TotalNumberOfPages || 1)) break;
  }
  const db = getDb();
  const gone = db.prepare('SELECT item_id FROM ebay_listings WHERE active = 1').all().map((r) => r.item_id).filter((id) => !seen.includes(id));
  for (const id of gone) db.prepare('UPDATE ebay_listings SET active = 0 WHERE item_id = ?').run(id);
  return { listings: seen.length, ended: gone.length };
}

// ---------------------------------------------------------------- what he changes

/**
 * Links a listing to a product and sets its stock and pricing. The first
 * time, the shelf count starts at what the listing already shows, so
 * linking alone changes nothing on eBay.
 */
export function setListing(itemId, input = {}) {
  const row = getListing(itemId);
  if (!row) return { error: 'That listing is gone. Press Sync now.' };
  const db = getDb();
  const changes = {};
  if (input.productId !== undefined) {
    const product = input.productId ? getProductById(Number(input.productId)) : null;
    if (input.productId && !product) return { error: 'Pick the product it sells.' };
    changes.product_id = product ? product.id : null;
    if (product && row.on_hand === null && input.onHand === undefined) changes.on_hand = row.ebay_qty ?? 0;
  }
  const whole = (v, label) => {
    const n = num(v);
    if (n === null) return null;
    if (!Number.isInteger(n) || n < 0 || n > 9999) throw new Error(`${label} should be a whole number.`);
    return n;
  };
  try {
    if (input.onHand !== undefined) changes.on_hand = whole(input.onHand, 'On the shelf');
    if (input.target !== undefined) changes.target = whole(input.target, 'Keep in stock');
  } catch (err) {
    return { error: err.message };
  }
  if (input.marginPct !== undefined) {
    const m = num(input.marginPct);
    if (m !== null && (!Number.isFinite(m) || m < 0 || m > 300)) return { error: 'Margin should be a percentage, like 15.' };
    changes.margin_pct = m;
  }
  if (input.postage !== undefined) {
    const c = dollarsToCents(input.postage);
    if (c !== null && (c < 0 || c > 10000)) return { error: 'Postage should be dollars, like 5.' };
    changes.postage_cents = c;
  }
  if (input.fixedPrice !== undefined) {
    const c = dollarsToCents(input.fixedPrice);
    if (c !== null && (c < 100 || c > 5000000)) return { error: 'Type the price in dollars, like 159.95, or leave it blank to use your margin.' };
    changes.fixed_price_cents = c;
  }
  if (input.marketQuery !== undefined) changes.market_query = String(input.marketQuery || '').trim().slice(0, 100) || null;
  const keys = Object.keys(changes);
  if (!keys.length) return { error: 'Nothing to change.' };
  db.prepare(`UPDATE ebay_listings SET ${keys.map((k) => `${k} = ?`).join(', ')}, held_price_cents = NULL, last_error = NULL WHERE item_id = ?`)
    .run(...keys.map((k) => changes[k]), row.item_id);
  if (changes.product_id) relinkStandIn(row.item_id, getProductById(changes.product_id));
  return { row: getListing(row.item_id) };
}

/**
 * Orders that came in before the listing was linked were put under a hidden
 * stand-in product ("ebay <item>"). Linking moves them to the real product,
 * so their labels, stock and profit read right.
 */
function relinkStandIn(itemId, product) {
  const standIn = findProductByName(`ebay ${itemId}`);
  if (!standIn || !product || standIn.id === product.id) return 0;
  const db = getDb();
  const moved = db.prepare('UPDATE orders SET product_id = ?, product_name = ? WHERE product_id = ?').run(product.id, product.name, standIn.id).changes;
  for (const o of db.prepare('SELECT order_id, lines FROM ebay_orders WHERE lines LIKE ?').all(`%"itemId":"${itemId}"%`)) {
    const lines = JSON.parse(o.lines).map((l) => (l.itemId === itemId ? { ...l, linked: true } : l));
    db.prepare('UPDATE ebay_orders SET lines = ? WHERE order_id = ?').run(JSON.stringify(lines), o.order_id);
  }
  // Nothing points at the stand-in now, so it goes, and stops showing in the product pickers.
  db.prepare('DELETE FROM products WHERE id = ? AND NOT EXISTS (SELECT 1 FROM orders WHERE product_id = ?)').run(standIn.id, standIn.id);
  return moved;
}

/** Boxes in or out of the eBay shelf: + when stock arrives, - when one goes elsewhere. */
export function adjustShelf(itemId, delta) {
  const row = getListing(itemId);
  if (!row) return { error: 'That listing is gone. Press Sync now.' };
  const d = Number(delta);
  if (!Number.isInteger(d) || d === 0 || Math.abs(d) > 999) return { error: 'Type how many came in (or went out).' };
  if (row.on_hand === null) return { error: 'Pick the product it sells first.' };
  const onHand = Math.max(0, row.on_hand + d);
  getDb().prepare('UPDATE ebay_listings SET on_hand = ? WHERE item_id = ?').run(onHand, row.item_id);
  return { row: getListing(row.item_id), onHand };
}

/** One sold on eBay: off the shelf here, and off the listing (eBay already did that itself). */
export function takeSold(itemId, qty) {
  const row = itemId ? getListing(itemId) : null;
  if (!row) return null;
  getDb().prepare(`
    UPDATE ebay_listings SET sold = sold + ?, ebay_qty = MAX(0, COALESCE(ebay_qty, 0) - ?),
      on_hand = CASE WHEN on_hand IS NULL THEN NULL ELSE MAX(0, on_hand - ?) END
    WHERE item_id = ?
  `).run(qty, qty, qty, row.item_id);
  return getListing(row.item_id);
}

/** A cancelled order's boxes go back on the shelf (eBay puts them back on the listing itself). */
export function putBack(itemId, qty) {
  const row = itemId ? getListing(itemId) : null;
  if (!row) return null;
  getDb().prepare(`
    UPDATE ebay_listings SET sold = MAX(0, sold - ?), ebay_qty = COALESCE(ebay_qty, 0) + ?,
      on_hand = CASE WHEN on_hand IS NULL THEN NULL ELSE on_hand + ? END
    WHERE item_id = ?
  `).run(qty, qty, qty, row.item_id);
  return getListing(row.item_id);
}

// ---------------------------------------------------------------- pushing to eBay

const priceText = (c) => (c / 100).toFixed(2);

/**
 * Brings listings in line with the shelf and the price maths, four at a
 * time (the most eBay takes in one call). `itemIds` limits it to those;
 * `acceptHeld` lets a held price through.
 */
export async function pushListings({ itemIds = null, acceptHeld = false, now = new Date() } = {}) {
  const s = ebaySettings();
  const account = ebayAccount() || {};
  const db = getDb();
  const rows = (itemIds ? itemIds.map(getListing).filter(Boolean) : allListings())
    .filter((r) => r.active && r.product_id && r.on_hand !== null);
  const jobs = [];
  for (const row of rows) {
    const w = wanted(row, s);
    const job = { row };
    // At 0 without out-of-stock control, eBay would end the listing and lose its history.
    if (w.qty !== row.ebay_qty && !(w.qty === 0 && account.oos !== true)) job.qty = w.qty;
    if (w.price && w.price !== row.ebay_price_cents) {
      const current = row.ebay_price_cents;
      // Only a worked-out price is checked: a price he typed is meant.
      const swing = w.priceFrom === 'margin' && current && (w.price < current * PRICE_SWING.low || w.price > current * PRICE_SWING.high);
      if (swing && !(acceptHeld && row.held_price_cents === w.price)) {
        if (row.held_price_cents !== w.price) db.prepare('UPDATE ebay_listings SET held_price_cents = ? WHERE item_id = ?').run(w.price, row.item_id);
      } else job.price = w.price;
    }
    if (job.qty !== undefined || job.price !== undefined) jobs.push(job);
  }
  const out = { pushed: 0, failed: [] };
  for (let i = 0; i < jobs.length; i += 4) {
    const batch = jobs.slice(i, i + 4);
    const xml = batch.map((j) => `<InventoryStatus><ItemID>${xmlEscape(j.row.item_id)}</ItemID>${j.qty !== undefined ? `<Quantity>${j.qty}</Quantity>` : ''}${j.price !== undefined ? `<StartPrice>${priceText(j.price)}</StartPrice>` : ''}</InventoryStatus>`).join('');
    try {
      const r = await trading('ReviseInventoryStatus', xml);
      const back = new Map(asArray(r.InventoryStatus).map((x) => [String(x.ItemID), x]));
      for (const j of batch) {
        const b = back.get(j.row.item_id) || {};
        db.prepare(`
          UPDATE ebay_listings SET ebay_qty = ?, ebay_price_cents = ?, held_price_cents = NULL, pushed_at = ?, last_error = NULL WHERE item_id = ?
        `).run(
          b.Quantity !== undefined ? Number(b.Quantity) : j.qty ?? j.row.ebay_qty,
          b.StartPrice !== undefined ? cents(b.StartPrice) : j.price ?? j.row.ebay_price_cents,
          now.toISOString(),
          j.row.item_id,
        );
        out.pushed += 1;
      }
    } catch (err) {
      for (const j of batch) {
        db.prepare('UPDATE ebay_listings SET last_error = ? WHERE item_id = ?').run(String(err.message).slice(0, 300), j.row.item_id);
        out.failed.push(`${j.row.title}: ${err.message}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- out-of-stock control

export async function checkOutOfStockControl() {
  const r = await trading('GetUserPreferences', '<ShowOutOfStockControlPreference>true</ShowOutOfStockControlPreference>');
  const on = String(r.OutOfStockControlPreference) === 'true';
  noteAccount({ oos: on });
  return on;
}

export async function turnOnOutOfStockControl() {
  await trading('SetUserPreferences', '<OutOfStockControlPreference>true</OutOfStockControlPreference>');
  noteAccount({ oos: true });
  return true;
}

// ---------------------------------------------------------------- the market, for reference

const STOP = new Set(['au', 'seller', 'ships', 'ship', 'from', 'melbourne', 'new', 'sealed', 'factory', 'free', 'post', 'postage', 'fast', 'tcg', 'the', 'and', 'with', 'box', 'in', 'stock', 'authentic', 'genuine', 'card', 'cards', 'game', 'x1', '1x']);

/** What to search eBay for: the listing's own query, else the product's long name, else the title's words. */
export function marketQuery(row) {
  if (row.market_query) return row.market_query;
  const product = row.product_id ? getProductById(row.product_id) : null;
  const base = product?.display_name || row.title;
  const words = String(base).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
  if (!words.includes('pokemon')) words.push('pokemon');
  if (/booster box/i.test(base) && !words.includes('box')) words.push('box');
  return words.slice(0, 9).join(' ');
}

/**
 * The cheapest new, Buy It Now copies listed by sellers in Australia,
 * delivered price, his own left out. For reference: never fed into the price.
 */
export async function checkMarket(itemId, { now = new Date() } = {}) {
  const row = getListing(itemId);
  if (!row) return null;
  const q = marketQuery(row);
  const r = await ebayApi('GET', '/buy/browse/v1/item_summary/search', {
    app: true,
    query: { q, filter: 'buyingOptions:{FIXED_PRICE},conditions:{NEW},itemLocationCountry:AU,deliveryCountry:AU', sort: 'price', limit: 50 },
    headers: { 'X-EBAY-C-ENDUSERCTX': `contextualLocation=country%3DAU%2Czip%3D${encodeURIComponent(config.fromPostcode || '3000')}` },
  });
  const me = String(ebayAccount()?.username || '').toLowerCase();
  const words = q.split(' ').filter((w) => w.length > 2 && w !== 'pokemon');
  const need = Math.max(1, Math.ceil(words.length * 0.6));
  const found = (r.itemSummaries || [])
    .filter((i) => String(i.seller?.username || '').toLowerCase() !== me && String(i.legacyItemId || '') !== row.item_id)
    .filter((i) => words.filter((w) => String(i.title || '').toLowerCase().includes(w)).length >= need)
    .map((i) => {
      const ship = i.shippingOptions?.[0]?.shippingCost?.value;
      return {
        title: String(i.title || '').slice(0, 90),
        url: i.itemWebUrl || null,
        cents: cents(i.price?.value) + (ship ? cents(ship) : 0),
        seller: i.seller?.username || null,
        score: i.seller?.feedbackScore ?? null,
        pct: i.seller?.feedbackPercentage ?? null,
      };
    })
    .filter((i) => i.cents > 0)
    .sort((a, b) => a.cents - b.cents)
    .slice(0, 5);
  getDb().prepare('UPDATE ebay_listings SET market = ?, market_at = ? WHERE item_id = ?').run(JSON.stringify({ q, found }), now.toISOString(), row.item_id);
  return found;
}

/** Checks the market for linked listings not checked in the last day. */
export async function checkMarkets({ now = new Date(), limit = 10 } = {}) {
  const stale = allListings()
    .filter((r) => r.active && r.product_id && (!r.market_at || now.getTime() - Date.parse(r.market_at) > DAY))
    .slice(0, limit);
  const errors = [];
  for (const row of stale) {
    try {
      await checkMarket(row.item_id, { now });
    } catch (err) {
      errors.push(`${row.title}: ${err.message}`);
    }
  }
  return { checked: stale.length - errors.length, errors };
}

/** The listings as the dashboard shows them. */
export function listingsView() {
  const s = ebaySettings();
  return allListings().map((row) => {
    const w = wanted(row, s);
    let market = null;
    try {
      market = row.market ? JSON.parse(row.market) : null;
    } catch {
      market = null;
    }
    const restock = row.target != null && row.on_hand != null ? Math.max(0, row.target - row.on_hand) : 0;
    let status = 'linked';
    if (!row.active) status = 'ended';
    else if (!row.product_id) status = 'unlinked';
    else if (row.last_error) status = 'error';
    else if (row.held_price_cents) status = 'held';
    else if (w.qty !== row.ebay_qty || (w.price && w.price !== row.ebay_price_cents)) status = 'updating';
    return {
      itemId: row.item_id,
      title: row.title,
      url: row.url,
      image: row.image_url,
      active: Boolean(row.active),
      productId: row.product_id,
      product: w.product ? (w.product.display_name || w.product.name) : null,
      cost: w.product?.cost_cents ?? null,
      costActual: Boolean(w.product?.cost_actual),
      onHand: row.on_hand,
      target: row.target,
      restock,
      sold: row.sold,
      marginPct: row.margin_pct,
      postage: row.postage_cents,
      fixedPrice: row.fixed_price_cents,
      price: w.price,
      priceFrom: w.priceFrom,
      profit: w.profit,
      terms: w.terms,
      ebayQty: row.ebay_qty,
      ebayPrice: row.ebay_price_cents,
      held: row.held_price_cents,
      error: row.last_error,
      status,
      marketQuery: marketQuery(row),
      market: market?.found || null,
      marketAt: row.market_at,
    };
  });
}

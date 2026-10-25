import { getDb } from '../db/database.js';
import { readLabelsFromFile } from './labelReader.js';
import { matchLabel, ordersAwaitingParcels, parcelByTracking, parcelMessage, recordParcel } from './labelParcels.js';
import { getOrderById } from './orderService.js';
import { markPosted } from './shippingService.js';
import { pushToSheetInBackground } from './sheetService.js';

/**
 * Tracking codes uploaded on the dashboard, in bulk: Label Pro's label PDFs
 * (read the same way as dropping them in the shipping channel), or a pasted
 * list or CSV of names and codes. Each code is matched to its order the
 * same way the label drop does (the TCG reference first, then the name) and
 * then waits. Nothing is sent until staff tick that parcel as shipped; only
 * then is it recorded and the buyer told in their ticket.
 *
 * A code that can't be matched for sure waits for staff to pick its order.
 * A code for an order already marked shipped without tracking gets a Send
 * button of its own. A code that went out some other way (the label drop)
 * is noticed and cleared.
 */

const MAX_CODES = 400;
const cleanCode = (code) => String(code || '').replace(/\s+/g, '').toUpperCase();
const validCode = (code) => /^[A-Z0-9-]{8,40}$/.test(code);
const short = (code) => (code.length > 10 ? `…${code.slice(-6)}` : code);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------- reading

function csvCells(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Codes from text: a CSV with a header that names a tracking column (and a
 * name or reference column), or one parcel per line, "name: code" or with a
 * TCG reference anywhere in it.
 */
export function readCodesFromText(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const head = csvCells(lines[0]).map((h) => h.toLowerCase());
  const col = (re) => head.findIndex((h) => re.test(h));
  const codeCol = lines[0].includes(',') ? col(/track|article|consignment|barcode|parcel ?id/) : -1;
  if (codeCol >= 0) {
    const nameCol = col(/^to_name$|recipient|deliver|customer|^name$|to name|full name/);
    const refCol = col(/ref/);
    return lines.slice(1).map(csvCells).map((cells) => ({
      tracking: cleanCode(cells[codeCol]),
      name: nameCol >= 0 ? cells[nameCol] : null,
      ref: refCol >= 0 ? cells[refCol] : null,
    })).filter((e) => e.tracking);
  }
  return lines.map((line) => parseLine(line) || { tracking: null, name: null, ref: null, unreadable: line });
}

/**
 * One pasted line: a name (and maybe a TCG reference) and a code, either way
 * round. A code can be typed in groups, the way AusPost prints it
 * ("33QW 1234 5678"): the pieces with digits in them at the end (or start)
 * of the line are joined, stopping at a word or a TCG reference.
 */
function parseLine(line) {
  const tokens = line.split(/[\s,;]+/).map((t) => t.replace(/^[:=]+|[:=]+$/g, '')).filter(Boolean);
  const isCodePiece = (t) => !/^TCG-/i.test(t) && /\d/.test(t) && /^[A-Za-z0-9-]+$/.test(t);
  const take = (fromEnd) => {
    const rest = [...tokens];
    const pieces = [];
    while (rest.length && isCodePiece(fromEnd ? rest[rest.length - 1] : rest[0]) && pieces.join('').length < 40) {
      if (fromEnd) pieces.unshift(rest.pop()); else pieces.push(rest.shift());
    }
    return { code: cleanCode(pieces.join('')), rest: rest.join(' ') };
  };
  let found = take(true);
  if (!validCode(found.code)) found = take(false);
  if (!validCode(found.code)) return null;
  const ref = /TCG-[0-9A-Z]{6}/i.test(found.rest) ? found.rest : null;
  const name = found.rest.replace(/TCG-[0-9A-Z]{6}.*$/i, '').replace(/[\s:,=—-]+$/, '').trim();
  return { tracking: found.code, name: name || null, ref };
}

/** Codes from uploaded files: label PDFs or pictures are read like the label drop; CSV and text like a paste. */
export async function readCodesFromFiles(files = []) {
  const out = [];
  for (const f of files) {
    const buffer = Buffer.from(String(f.data || ''), 'base64');
    if (!buffer.length) continue;
    if (/\.(csv|txt)$/i.test(f.name || '')) {
      out.push(...readCodesFromText(buffer.toString('utf8')).map((e) => ({ ...e, file: f.name })));
      continue;
    }
    try {
      const labels = await readLabelsFromFile(buffer, f.name || '');
      if (!labels.length) out.push({ tracking: null, unreadable: `${f.name}: no label in it`, file: f.name });
      for (const l of labels) out.push({ tracking: cleanCode(l.tracking), name: l.name, ref: l.ref, file: f.name, unreadable: l.tracking ? null : `${f.name}: a label with no barcode read${l.name ? ` (to ${l.name})` : ''}` });
    } catch (err) {
      out.push({ tracking: null, unreadable: `${f.name}: couldn't be read (${err.message})`, file: f.name });
    }
  }
  return out;
}

// ---------------------------------------------------------------- storing and matching

function waitingRows() {
  return getDb().prepare("SELECT * FROM tracking_codes WHERE status = 'waiting' ORDER BY id").all();
}

/** Codes that went out some other way (the label drop) are done here too. */
function clearSentElsewhere() {
  for (const row of waitingRows()) {
    if (parcelByTracking(row.tracking_code)) {
      getDb().prepare("UPDATE tracking_codes SET status = 'sent', sent_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    }
  }
}

/** Saves the codes, each matched to its order where that's certain. Returns what happened, in counts. */
export function addCodes(entries, source = 'upload') {
  clearSentElsewhere();
  const db = getDb();
  const awaiting = ordersAwaitingParcels();
  const holding = new Set(waitingRows().filter((r) => r.order_id).map((r) => r.order_id));
  const result = { added: 0, matched: 0, toMatch: 0, alreadySent: 0, duplicates: 0, unreadable: [] };
  for (const e of entries.slice(0, MAX_CODES)) {
    const code = cleanCode(e.tracking);
    if (!code || !validCode(code)) {
      result.unreadable.push(e.unreadable || `${e.name || 'A line'}: no tracking number`);
      continue;
    }
    if (parcelByTracking(code)) { result.alreadySent += 1; continue; }
    if (db.prepare('SELECT 1 FROM tracking_codes WHERE tracking_code = ?').get(code)) { result.duplicates += 1; continue; }
    const m = matchLabel({ name: e.name, ref: e.ref }, awaiting);
    // Sure of the order, and it isn't already holding a code: attach it.
    // Anything else waits for staff to pick.
    const order = m.order && (!holding.has(m.order.id) || m.qty) ? m.order : null;
    db.prepare(`INSERT INTO tracking_codes (tracking_code, order_id, quantity, label_name, label_ref, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(code, order?.id ?? null, m.qty || null, e.name || null, e.ref || null, e.file ? `file: ${e.file}` : source, new Date().toISOString());
    result.added += 1;
    if (order) {
      result.matched += 1;
      holding.add(order.id);
    } else result.toMatch += 1;
  }
  return result;
}

export function summaryText(r) {
  const parts = [`${plural(r.added, 'code')} added`];
  if (r.added) parts.push(`${r.matched} matched to their parcel`);
  if (r.toMatch) parts.push(`${r.toMatch} to match by hand`);
  if (r.alreadySent) parts.push(`${r.alreadySent} already sent before`);
  if (r.duplicates) parts.push(`${r.duplicates} already uploaded`);
  if (r.unreadable.length) parts.push(`${r.unreadable.length} not read: ${r.unreadable.slice(0, 3).join('; ')}`);
  return `${parts.join(', ')}.`;
}

const orderOption = (o) => ({
  id: o.id,
  text: `${o.buyer_name || 'No name'} · ${o.quantity}x ${o.product_name} · ${o.reference_code}${o.status === 'shipped' ? ' (marked shipped)' : ''}`,
});

/**
 * What the Shipping section needs: the code waiting on each parcel, the
 * codes to match by hand (with the likeliest orders first), and the codes
 * for parcels already marked shipped without tracking.
 */
export function codesForBoard() {
  clearSentElsewhere();
  const rows = waitingRows();
  const byOrder = new Map();
  const unmatched = [];
  const forShipped = [];
  let awaiting = null;
  for (const r of rows) {
    if (r.order_id) {
      const order = getOrderById(r.order_id);
      if (!order || order.status === 'cancelled') {
        getDb().prepare('UPDATE tracking_codes SET order_id = NULL WHERE id = ?').run(r.id);
        r.order_id = null;
      } else if (order.status === 'paid') {
        if (!byOrder.has(order.id)) byOrder.set(order.id, { id: r.id, code: r.tracking_code, short: short(r.tracking_code), qty: r.quantity });
        continue;
      } else {
        const b = getDb().prepare('SELECT name FROM buyers WHERE discord_id = ?').get(order.buyer_id);
        forShipped.push({ id: r.id, code: r.tracking_code, short: short(r.tracking_code), buyer: b?.name || 'No name', what: `${order.quantity}x ${order.product_name}`, ref: order.reference_code });
        continue;
      }
    }
    awaiting = awaiting || ordersAwaitingParcels();
    const m = matchLabel({ name: r.label_name, ref: r.label_ref }, awaiting);
    const likely = m.order ? [m.order] : m.candidates || [];
    const seen = new Set(likely.map((o) => o.id));
    const options = [...likely, ...(m.suggestions || []).filter((o) => !seen.has(o.id))].slice(0, 25).map(orderOption);
    unmatched.push({ id: r.id, code: r.tracking_code, short: short(r.tracking_code), name: r.label_name, ref: r.label_ref, options, likely: likely.length });
  }
  return { byOrder, unmatched, forShipped, waiting: rows.length };
}

export function matchCode(id, orderId) {
  const row = getDb().prepare("SELECT * FROM tracking_codes WHERE id = ? AND status = 'waiting'").get(Number(id));
  if (!row) return { error: 'That code is gone. Reload the page.' };
  const order = getOrderById(Number(orderId));
  if (!order || !['paid', 'shipped'].includes(order.status)) return { error: 'Pick the order it\'s for.' };
  getDb().prepare('UPDATE tracking_codes SET order_id = ? WHERE id = ?').run(order.id, row.id);
  return { ok: true, text: `${short(row.tracking_code)} matched to ${order.reference_code}.` };
}

export function unmatchCode(id) {
  const r = getDb().prepare("UPDATE tracking_codes SET order_id = NULL WHERE id = ? AND status = 'waiting'").run(Number(id));
  return r.changes ? { ok: true, text: 'Code taken off that parcel. It\'s under Codes to match.' } : { error: 'That code is gone. Reload the page.' };
}

export function skipCode(id) {
  const r = getDb().prepare("UPDATE tracking_codes SET status = 'skipped' WHERE id = ? AND status = 'waiting'").run(Number(id));
  return r.changes ? { ok: true, text: 'Code removed.' } : { error: 'That code is gone. Reload the page.' };
}

// ---------------------------------------------------------------- sending

async function tellBuyer(client, order, text) {
  if (!order.thread_id) return false;
  try {
    const thread = await client.channels.fetch(order.thread_id);
    await thread.send(text);
    return true;
  } catch (err) {
    console.error(`Tracking: could not post in ticket ${order.thread_id}:`, err.message);
    return false;
  }
}

/**
 * Records each code's parcel and tells its buyer, the same as the label drop.
 * An eBay buyer has no ticket: their code goes to eBay instead (ebayOrders).
 */
export async function sendCodes(client, ids) {
  const out = { sent: [], told: 0, ebay: 0, noTicket: [], failed: 0 };
  for (const id of ids) {
    const row = getDb().prepare("SELECT * FROM tracking_codes WHERE id = ? AND status = 'waiting' AND order_id IS NOT NULL").get(Number(id));
    if (!row) continue;
    const r = recordParcel(row.order_id, row.tracking_code, row.quantity);
    getDb().prepare("UPDATE tracking_codes SET status = 'sent', sent_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    if (r.error || r.duplicate) {
      if (r.error) out.failed += 1;
      continue;
    }
    out.sent.push(r.order);
    if (r.order.source === 'ebay') out.ebay += 1;
    else if (await tellBuyer(client, r.order, parcelMessage(r.order, r, row.tracking_code))) out.told += 1;
    else {
      const b = getDb().prepare('SELECT name FROM buyers WHERE discord_id = ?').get(r.order.buyer_id);
      out.noTicket.push(`${b?.name || r.order.reference_code} (${row.tracking_code})`);
    }
  }
  if (out.sent.length) pushToSheetInBackground(out.sent, 'tracking');
  return out;
}

/**
 * The parcels staff ticked as shipped: those with a code waiting are sent
 * with it (and the buyer told); the rest are marked posted, telling nobody.
 */
export async function shipTicked(client, orderIds) {
  const ids = [...new Set((Array.isArray(orderIds) ? orderIds : []).map(Number))].filter(Number.isInteger);
  if (!ids.length) return { error: 'Tick the parcels that went out.' };
  if (ids.length > 300) return { error: 'That\'s a lot at once. Do 300 or fewer.' };
  const { byOrder } = codesForBoard();
  const withCode = ids.filter((id) => byOrder.has(id));
  const sent = await sendCodes(client, withCode.map((id) => byOrder.get(id).id));
  const plain = markPosted(ids.filter((id) => !byOrder.has(id)));
  if (plain.length) pushToSheetInBackground(plain, 'posted');
  const shipped = [...sent.sent, ...plain];
  if (!shipped.length) return { error: 'Those are already marked as shipped. Reload the page.' };
  let text = `${plural(shipped.length, 'parcel')} marked as shipped`;
  if (sent.told) text += `, ${sent.told} told their tracking in their ticket`;
  if (sent.ebay) text += `, ${sent.ebay} with tracking going to eBay`;
  text += '.';
  if (sent.noTicket.length) text += ` No ticket to message: ${sent.noTicket.slice(0, 4).join(', ')}${sent.noTicket.length > 4 ? '…' : ''}.`;
  const ebayBare = plain.filter((o) => o.source === 'ebay').length;
  if (ebayBare) text += ` ${plural(ebayBare, 'eBay parcel')} went with no tracking: add it under Tracking, so eBay counts it as posted.`;
  return { shipped, text, told: sent.told, ebay: sent.ebay + ebayBare, noTicket: sent.noTicket };
}

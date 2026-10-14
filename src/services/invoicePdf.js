/**
 * A one-page invoice PDF, written by hand.
 *
 * No library: a single page of text and lines in Helvetica is a few hundred
 * bytes of PDF, and the bot cannot run anything locally that needs native
 * modules, so this keeps it testable and dependency-free. Helvetica is one of
 * the 14 fonts every PDF reader already has, so nothing is embedded.
 *
 * The layout mirrors make_invoice.py, so invoices look the same whichever
 * made them.
 */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MM = 72 / 25.4;
const LEFT = 20 * MM;
const WIDTH = PAGE_W - 2 * LEFT;

const INK = [0.102, 0.102, 0.102];
const MUTED = [0.42, 0.42, 0.42];
const RULE = [0.847, 0.847, 0.847];
const ACCENT = [0.769, 0.51, 0.055];
const GREEN = [0.13, 0.55, 0.29];

// Helvetica and Helvetica-Bold advance widths for ASCII 32-126, per 1000 em,
// from the standard AFM files. Needed to right-align money and wrap text.
const WIDTHS = {
  F1: [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611,
    778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
    278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556,
    556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584],
  F2: [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611,
    778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
    333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611,
    611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584],
};

/**
 * Down to what Helvetica can draw. Dashes become hyphens, smart quotes go
 * straight, anything outside Latin-1 (Chinese set names, emoji) becomes "?"
 * rather than breaking the file.
 */
export function pdfSafe(text) {
  return String(text ?? '')
    .replace(/[‒-―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[ 　]/g, ' ')
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, '?');
}

export function textWidth(text, font, size) {
  let w = 0;
  for (const ch of pdfSafe(text)) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? WIDTHS[font][c - 32] : 556;
  }
  return (w * size) / 1000;
}

/** Splits text into lines no wider than maxWidth, breaking on spaces. */
export function wrap(text, font, size, maxWidth) {
  const out = [];
  for (const para of pdfSafe(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(next, font, size) > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}

const esc = (s) => pdfSafe(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const n = (v) => Number(v.toFixed(2));
const rgb = (c) => c.map(n).join(' ');

/** Drawing on a page measured from the top-left, in points. */
class Page {
  constructor() { this.ops = []; }

  text(x, y, str, { font = 'F1', size = 9.5, color = INK, align = 'left' } = {}) {
    const w = textWidth(str, font, size);
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.ops.push(`BT /${font} ${n(size)} Tf ${rgb(color)} rg ${n(left)} ${n(PAGE_H - y)} Td (${esc(str)}) Tj ET`);
  }

  line(x1, y, x2, { width = 0.4, color = RULE } = {}) {
    this.ops.push(`${n(width)} w ${rgb(color)} RG ${n(x1)} ${n(PAGE_H - y)} m ${n(x2)} ${n(PAGE_H - y)} l S`);
  }
}

/** Assembles the objects into a valid PDF file with a cross-reference table. */
function assemble(content, title, author) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
      + '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title (${esc(title)}) /Author (${esc(author)}) /Producer (TCG Pack Bot) >>`,
  ];

  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let size = chunks[0].length;
  const offsets = [];
  const push = (buf) => { chunks.push(buf); size += buf.length; };

  objects.forEach((body, i) => {
    offsets.push(size);
    if (i === 3) {
      const stream = Buffer.from(content, 'latin1');
      push(Buffer.from(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n`, 'latin1'));
      push(stream);
      push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    } else {
      push(Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1'));
    }
  });

  const xref = size;
  const table = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `)].join('\n');
  push(Buffer.from(`${table}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

export const money = (cents) => `$${(cents / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * invoice: {
 *   number, issued, due, paidOn,            dates already formatted
 *   from: [lines], billTo: [lines],
 *   items: [{ description, qty, unitCents }],
 *   shippingCents, shippingLabel, note,
 *   payment: [[label, value]],              shown only when unpaid
 * }
 */
export function invoicePdf(inv) {
  const p = new Page();
  const right = LEFT + WIDTH;
  let y = 18 * MM + 26;

  p.text(LEFT, y, 'INVOICE', { font: 'F2', size: 26 });
  if (inv.paidOn) p.text(right, y, 'PAID', { font: 'F2', size: 26, color: GREEN, align: 'right' });

  y += 20;
  p.text(LEFT, y, inv.number, { font: 'F2', size: 9.5 });
  p.text(right, y - 6, `Issued  ${inv.issued}`, { size: 8.5, color: MUTED, align: 'right' });
  p.text(right, y + 6, inv.paidOn ? `Paid  ${inv.paidOn}` : `Due  ${inv.due}`, { size: 8.5, color: MUTED, align: 'right' });
  y += 12;
  p.line(LEFT, y, right, { width: 1.2, color: ACCENT });

  // From / Bill to
  y += 26;
  const col2 = LEFT + 85 * MM;
  p.text(LEFT, y, 'FROM', { font: 'F2', size: 7.5, color: MUTED });
  p.text(col2, y, 'BILL TO', { font: 'F2', size: 7.5, color: MUTED });
  const from = inv.from.flatMap((l) => wrap(l, 'F1', 9.5, 82 * MM));
  const billTo = inv.billTo.flatMap((l) => wrap(l, 'F1', 9.5, 82 * MM));
  from.forEach((l, i) => p.text(LEFT, y + 15 + i * 14, l));
  billTo.forEach((l, i) => p.text(col2, y + 15 + i * 14, l));
  y += 15 + Math.max(from.length, billTo.length) * 14 + 22;

  // Items
  const qtyX = LEFT + 95 * MM + 7.5 * MM;
  const unitR = LEFT + 140 * MM;
  const head = { font: 'F2', size: 8, color: MUTED };
  p.text(LEFT, y, 'Description', head);
  p.text(qtyX, y, 'Qty', { ...head, align: 'center' });
  p.text(unitR, y, 'Unit price', { ...head, align: 'right' });
  p.text(right, y, 'Amount', { ...head, align: 'right' });
  y += 5;
  p.line(LEFT, y, right, { width: 0.8, color: INK });

  let goods = 0;
  let units = 0;
  inv.items.forEach((item, i) => {
    const lines = wrap(item.description, 'F1', 9.5, 92 * MM);
    const amount = item.qty * item.unitCents;
    goods += amount;
    units += item.qty;
    const top = y + 17;
    lines.forEach((l, k) => p.text(LEFT, top + k * 14, l));
    p.text(qtyX, top, String(item.qty), { align: 'center' });
    p.text(unitR, top, money(item.unitCents), { align: 'right' });
    p.text(right, top, money(amount), { align: 'right' });
    y = top + (lines.length - 1) * 14 + 9;
    if (i < inv.items.length - 1) p.line(LEFT, y, right);
  });

  // Totals
  const labelR = LEFT + 110 * MM;
  const total = goods + inv.shippingCents;
  y += 24;
  p.text(labelR, y, `Goods subtotal (${units} item${units === 1 ? '' : 's'})`, { color: MUTED, align: 'right' });
  p.text(right, y, money(goods), { color: MUTED, align: 'right' });
  y += 19;
  p.text(labelR, y, inv.shippingLabel || 'Shipping', { color: MUTED, align: 'right' });
  p.text(right, y, money(inv.shippingCents), { color: MUTED, align: 'right' });
  y += 9;
  p.line(LEFT, y, right, { width: 1.2, color: ACCENT });
  y += 19;
  p.text(labelR, y, inv.paidOn ? 'Total paid' : 'Total due', { font: 'F2', size: 13, align: 'right' });
  p.text(right, y, `${money(total)} AUD`, { font: 'F2', size: 13, align: 'right' });

  y += 36;
  if (inv.note) {
    wrap(inv.note, 'F1', 9.5, WIDTH).forEach((l) => { p.text(LEFT, y, l); y += 14; });
    y += 6;
  }
  p.text(LEFT, y, 'No GST has been charged on this invoice.');

  y += 28;
  if (inv.paidOn) {
    p.text(LEFT, y, 'Paid in full. Thank you.', { font: 'F2', size: 9.5, color: GREEN });
  } else if (inv.payment?.length) {
    p.text(LEFT, y, 'PAYMENT DETAILS', { font: 'F2', size: 7.5, color: MUTED });
    y += 6;
    for (const [label, value] of inv.payment) {
      y += 18;
      p.text(LEFT, y, label, { size: 8.5, color: MUTED });
      p.text(LEFT + 35 * MM, y, value);
      p.line(LEFT + 35 * MM, y + 5, right);
    }
    y += 24;
    p.text(LEFT, y, `Please use ${inv.number} as the payment reference.`, { size: 8.5, color: MUTED });
  }

  return { pdf: assemble(p.ops.join('\n'), `Invoice ${inv.number}`, inv.from[0] || ''), totalCents: total };
}

/**
 * The dashboard's HTML: one self-contained page (styles and script inline,
 * nothing loaded from elsewhere) that reads /dash/api/data (costs, profit,
 * expenses), /dash/api/ops (stock tracker, health) and /dash/api/stats
 * (everything else) and posts changes back.
 * Built for a phone first: the alerts, key numbers and trend come first so
 * one look says how things are going, and the detail sits below. Every name
 * from the database goes in with textContent, never as HTML.
 *
 * STYLE and SCRIPT are plain strings inside template literals, so neither
 * may contain a backtick or a dollar-brace.
 */

const STYLE = `
:root {
  --bg: #f6f5f1; --card: #ffffff; --ink: #1d1d1b; --soft: #6b6a64; --line: #e4e1d8;
  --accent: #2f6f4f; --accent-soft: #b9d8c6; --accent-ink: #ffffff; --warn: #a15c00; --warn-bg: #fff3df;
  --bad: #b3261e; --good: #2f6f4f; --good-bg: #e6f2ea; --chip: #efede6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151514; --card: #1f1f1d; --ink: #f1efe8; --soft: #a3a198; --line: #34332f;
    --accent: #6cc495; --accent-soft: #2e5a42; --accent-ink: #0e1a13; --warn: #f0b45c; --warn-bg: #3a2c14;
    --bad: #ff8a80; --good: #6cc495; --good-bg: #1d3326; --chip: #2a2a27;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 0 16px 80px; display: grid; gap: 26px; }
header.top { position: sticky; top: 0; z-index: 5; background: var(--bg); padding: 10px 0 8px; border-bottom: 1px solid var(--line); display: grid; gap: 8px; }
.toprow { display: flex; align-items: center; gap: 12px; }
.toprow .titles { flex: 1 1 auto; min-width: 0; }
h1 { font-size: 19px; margin: 0; line-height: 1.2; }
#updated { margin: 0; font-size: 12px; }
h2 { font-size: 17px; margin: 0 0 10px; scroll-margin-top: 100px; }
h3 { font-size: 15px; margin: 0 0 8px; }
.toprow select { width: auto; max-width: 52%; padding: 7px 10px; }
.head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: baseline; }
nav.jump { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
nav.jump a { flex: 0 0 auto; font-size: 13px; padding: 5px 10px; border-radius: 99px; background: var(--chip); color: var(--ink); text-decoration: none; }
.sub { color: var(--soft); font-size: 14px; margin: 2px 0 0; }
.grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
@media (max-width: 640px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.tile, .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px; min-width: 0; }
.tile .k { font-size: 13px; color: var(--soft); }
.tile .v { font-size: 24px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.tile .s { font-size: 13px; color: var(--soft); margin-top: 2px; }
.delta { font-size: 12px; font-weight: 650; margin-left: 4px; white-space: nowrap; }
.up { color: var(--good); } .down, .neg { color: var(--bad); }
.list { display: grid; gap: 8px; }
.stack { display: grid; gap: 12px; }
.alerts { display: flex; flex-wrap: wrap; gap: 8px; }
.alert { font-size: 14px; padding: 8px 12px; border-radius: 12px; background: var(--warn-bg); color: var(--ink); border: 1px solid var(--warn); text-decoration: none; }
.alert.soft { background: var(--chip); border-color: var(--line); }
.alert.ok { background: var(--good-bg); border-color: var(--accent-soft); }
.todo { border-color: var(--warn); background: var(--warn-bg); }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.grow { flex: 1 1 auto; min-width: 0; }
.name { font-weight: 650; overflow-wrap: anywhere; }
.rank { color: var(--soft); font-variant-numeric: tabular-nums; min-width: 1.6em; }
.num { font-variant-numeric: tabular-nums; font-weight: 650; }
.meta { color: var(--soft); font-size: 14px; }
.insight { font-size: 14px; margin: 10px 0 0; }
.insight b { font-variant-numeric: tabular-nums; }
input, select, button { font: inherit; }
input[type=text], input[type=date], select {
  width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--card); color: var(--ink); min-width: 0;
}
.edit { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; margin-top: 10px; }
@media (max-width: 420px) { .edit { grid-template-columns: 1fr 1fr; } .edit input { grid-column: 1 / -1; } }
button { padding: 10px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--chip); color: var(--ink); cursor: pointer; white-space: nowrap; }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 650; }
button.link { background: none; border: none; padding: 4px 6px; color: var(--accent); }
button:disabled { opacity: .5; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.seg button { border: 0; border-radius: 0; padding: 6px 12px; font-size: 14px; background: var(--card); }
.seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.chip { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 99px; background: var(--chip); color: var(--soft); white-space: nowrap; }
.chip.real, .chip.active { background: var(--good-bg); color: var(--good); }
.chip.est, .chip.quiet { background: var(--warn-bg); color: var(--warn); }
.lines { display: grid; gap: 6px; }
.lines div { display: flex; justify-content: space-between; gap: 12px; font-variant-numeric: tabular-nums; }
.lines .total { font-weight: 700; border-top: 1px solid var(--line); padding-top: 6px; }
.note { font-size: 13px; color: var(--soft); margin: 8px 0 0; }
.hint { font-size: 13px; color: var(--soft); margin: 6px 0 0; }
label.check { display: flex; gap: 6px; align-items: center; font-size: 13px; color: var(--soft); grid-column: 1 / -1; }
.bars { display: grid; gap: 7px; }
.bar { display: grid; grid-template-columns: minmax(0, 40%) minmax(0, 1fr) auto; gap: 10px; align-items: center; font-size: 14px; }
.bar .lbl { overflow-wrap: anywhere; }
.bar .track { height: 10px; border-radius: 5px; background: var(--chip); overflow: hidden; }
.bar .fill { height: 100%; background: var(--accent); border-radius: 5px; }
.bar .val { font-variant-numeric: tabular-nums; color: var(--soft); min-width: 3.5em; text-align: right; }
.split { display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: var(--chip); }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 13px; color: var(--soft); margin-top: 8px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
svg.chart { width: 100%; height: auto; display: block; }
.axis { display: flex; justify-content: space-between; font-size: 12px; color: var(--soft); margin-top: 4px; }
.hours { display: grid; grid-template-columns: repeat(24, minmax(0, 1fr)); gap: 2px; align-items: end; height: 70px; }
.hours div { background: var(--accent); border-radius: 2px 2px 0 0; min-height: 2px; }
.hourlbl { display: grid; grid-template-columns: repeat(4, 1fr); font-size: 11px; color: var(--soft); margin-top: 4px; }
.expense-form { display: grid; grid-template-columns: 150px minmax(0, 1fr) 120px auto; gap: 8px; }
@media (max-width: 600px) { .expense-form { grid-template-columns: 1fr 1fr; } .expense-form .what { grid-column: 1 / -1; order: -1; } }
#toast { position: fixed; left: 16px; right: 16px; bottom: 16px; max-width: 520px; margin: 0 auto; padding: 12px 14px; border-radius: 12px; background: var(--ink); color: var(--bg); font-size: 15px; opacity: 0; transform: translateY(10px); transition: .2s; pointer-events: none; z-index: 10; }
#toast.show { opacity: 1; transform: none; }
.empty { color: var(--soft); font-size: 14px; }
.card.bad { border-color: var(--bad); }
.steps { display: grid; gap: 4px; margin: 10px 0 4px; font-size: 14px; }
.steps .s { display: flex; gap: 8px; align-items: center; min-height: 30px; }
.steps .s.now { font-weight: 650; }
.steps .s.later { color: var(--soft); }
.steps .s button.link { padding: 2px 6px; font-size: 14px; }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: 0 0 auto; background: var(--line); }
.dot.ok { background: var(--good); } .dot.warn { background: var(--warn); } .dot.bad { background: var(--bad); }
.stuck { font-size: 14px; font-weight: 650; margin: 6px 0 0; }
.stuck.bad { color: var(--bad); } .stuck.warn { color: var(--warn); }
.indent { margin-left: 18px; }
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
let state = null;
let stats = null;
let ops = null;
let period = 'month';
let buyerView = 'period';
const shown = {};

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) e.append(kid.nodeType ? kid : String(kid));
  return e;
}
function svgEl(tag, attrs, ...kids) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  for (const kid of kids) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}

const money = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dollars = (c) => c == null ? '-' : (c < 0 ? '-' : '') + '$' + Math.round(Math.abs(c) / 100).toLocaleString('en-AU');
const pct = (r, dp) => r == null ? '-' : (r * 100).toFixed(dp == null ? 0 : dp) + '%';
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
const day = (iso) => iso ? new Date(iso).toLocaleDateString('en-AU', { timeZone: 'Australia/Melbourne', day: 'numeric', month: 'short' }) : '-';
const weekday = (iso) => iso ? new Date(iso).toLocaleDateString('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', day: 'numeric', month: 'short' }) : '-';
const month = (iso) => new Date(iso).toLocaleDateString('en-AU', { timeZone: 'Australia/Melbourne', month: 'long', year: 'numeric' });
const hours = (h) => h == null ? '-' : h < 1 ? Math.round(h * 60) + ' min' : h < 48 ? h.toFixed(1) + ' h' : (h / 24).toFixed(1) + ' days';
const days = (d) => d == null ? '-' : d < 1 ? Math.round(d * 24) + ' h' : d.toFixed(1) + ' days';
const nightDate = (d) => weekday(d + 'T09:00:00Z');

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(path, body) {
  const res = await fetch(path, body ? {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Dash': '1' }, body: JSON.stringify(body),
  } : { credentials: 'same-origin' });
  const data = await res.json().catch(() => ({ ok: false, error: 'No answer from the bot.' }));
  if (!data.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

async function load() {
  try {
    const q = '?period=' + encodeURIComponent(period);
    // Stock and health are extras: the rest of the page still loads if they can't.
    const [d, s, o] = await Promise.all([api('/dash/api/data' + q), api('/dash/api/stats' + q), api('/dash/api/ops').catch(() => null)]);
    state = d;
    stats = s;
    ops = o;
    render();
  } catch (err) {
    $('app').replaceChildren(el('p', { class: 'empty' }, err.message));
  }
}

function delta(now, before, { invert } = {}) {
  if (before == null || now == null || !stats.previous) return null;
  if (before === 0) return now === 0 ? null : el('span', { class: 'delta up' }, 'new');
  const r = (now - before) / Math.abs(before);
  if (Math.abs(r) < 0.005) return el('span', { class: 'delta' }, '0%');
  const good = invert ? r < 0 : r > 0;
  return el('span', { class: 'delta ' + (good ? 'up' : 'down') }, (r > 0 ? '▲ ' : '▼ ') + Math.abs(Math.round(r * 100)) + '%');
}

function tile(k, v, s, d, cls) {
  return el('div', { class: 'tile' }, el('div', { class: 'k' }, k), el('div', { class: 'v' + (cls ? ' ' + cls : '') }, v, d), s ? el('div', { class: 's' }, s) : null);
}

function bars(rows, { label, value, fmt, max }) {
  const top = max || Math.max(1, ...rows.map(value));
  return el('div', { class: 'bars' }, rows.map((r) => el('div', { class: 'bar' },
    el('span', { class: 'lbl' }, label(r)),
    el('div', { class: 'track' }, el('div', { class: 'fill', style: 'width:' + Math.max(2, (value(r) / top) * 100) + '%' })),
    el('span', { class: 'val' }, fmt(r)),
  )));
}

function more(key, total, limit) {
  if (total <= limit) return null;
  return el('button', { type: 'button', class: 'link', onclick: () => { shown[key] = !shown[key]; render(); } }, shown[key] ? 'Show fewer' : 'Show all ' + total);
}

// ---------------------------------------------------------------- top

function renderAlerts() {
  const n = stats.now;
  const items = [];
  const a = (text, href, soft) => items.push(el('a', { class: 'alert' + (soft ? ' soft' : ''), href }, text));
  if (n.costsMissing) a(plural(n.costsMissing, 'product') + ' sold with no cost', '#costs');
  if (state.money && state.money.untagged.length) a(plural(state.money.untagged.length, 'Wise payment') + ' to tag', '#money');
  if (n.screenshots) a(plural(n.screenshots, 'payment screenshot') + ' to check', '#speed');
  if (n.toPost) a(plural(n.toPost, 'paid order') + ' to post' + (n.oldestToPostDays ? ' (oldest ' + plural(n.oldestToPostDays, 'day') + ')' : ''), '#speed', n.oldestToPostDays < 3);
  if (n.partOrders) a(plural(n.partOrders, 'part order') + ' waiting for the rest', '#speed');
  if (n.unpaid) a(plural(n.unpaid, 'unpaid claim') + ' (' + dollars(n.unpaidValue) + ')', '#speed', true);
  if (n.estimates) a(plural(n.estimates, 'product') + ' on estimated costs', '#costs', true);
  if (ops) {
    for (const h of ops.health.filter((x) => x.status === 'bad')) a(h.name + ' stopped working', '#health');
    for (const v of ops.stock.active.filter((x) => x.stuck)) a('Stock, ' + v.title + ': ' + v.stuck.text, '#stock', v.stuck.level !== 'bad');
  }
  return el('section', null,
    el('h2', { id: 'now' }, 'Needs you now'),
    items.length ? el('div', { class: 'alerts' }, items) : el('div', { class: 'alerts' }, el('span', { class: 'alert ok' }, 'All clear. Nothing waiting on you.')),
  );
}

function renderKey() {
  const t = stats.totals;
  const p = stats.previous || {};
  const vs = stats.previous ? 'vs the same time before' : null;
  const profitNote = t.uncountedSales ? dollars(t.uncountedSales) + ' of sales has no cost yet' : t.estimatedSales ? 'partly on estimated costs' : (t.margin != null ? pct(t.margin, 1) + ' margin' : null);
  return el('section', null,
    el('h2', { id: 'overview' }, stats.period.label),
    el('div', { class: 'grid' },
      tile('Sales', dollars(t.sales), plural(t.orders, 'order'), delta(t.sales, p.sales)),
      tile('Profit', dollars(t.net), profitNote, delta(t.net, p.net), t.net < 0 ? 'neg' : null),
      tile('Average order', dollars(t.avgOrder), 'middle order ' + dollars(t.medianOrder), delta(t.avgOrder, p.avgOrder)),
      tile('Buyers', String(t.buyers), plural(t.newBuyers, 'new buyer'), delta(t.buyers, p.buyers)),
      tile('Units sold', String(t.units), t.over1k ? plural(t.over1k, 'order') + ' over $1k' : 'no orders over $1k', delta(t.units, p.units)),
      tile('Returning buyers', pct(t.buyers ? t.returningBuyers / t.buyers : null), t.returningBuyers + ' had bought before', null),
      tile('Spent per buyer', dollars(t.avgPerBuyer), 'middle buyer ' + dollars(t.medianPerBuyer), delta(t.avgPerBuyer, p.avgPerBuyer)),
      tile('New buyers', String(t.newBuyers), 'first ever order', delta(t.newBuyers, p.newBuyers)),
    ),
    vs ? el('p', { class: 'note' }, 'Arrows compare with the same stretch one period earlier.') : null,
  );
}

function weeklyChart(weeks) {
  const W = 600, H = 190, pad = 4, gap = 8;
  const max = Math.max(1, ...weeks.map((w) => w.sales));
  const bw = (W - pad * 2) / weeks.length - gap;
  const svg = svgEl('svg', { class: 'chart', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Sales and profit by week, last 12 weeks' });
  const describe = (w) => 'Week of ' + day(w.start) + ': ' + dollars(w.sales) + ' sales, ' + dollars(w.profit) + ' profit, '
    + plural(w.orders, 'order') + ', ' + plural(w.buyers, 'buyer') + '.';
  const info = el('p', { class: 'meta', style: 'margin:8px 0 0', 'aria-live': 'polite' }, describe(weeks[weeks.length - 1]));
  weeks.forEach((w, i) => {
    const x = pad + i * (bw + gap);
    const h = (w.sales / max) * (H - 20);
    const ph = Math.max(0, (w.profit / max) * (H - 20));
    const g = svgEl('g', { style: 'cursor:pointer' }, svgEl('title', null, describe(w)));
    // A clear full-height strip, so a week with no sales can still be tapped.
    g.append(svgEl('rect', { x: x - gap / 2, y: 0, width: bw + gap, height: H, fill: 'transparent' }));
    g.append(svgEl('rect', { x, y: H - h, width: bw, height: Math.max(1, h), rx: 3, fill: 'var(--accent-soft)' }));
    if (ph) g.append(svgEl('rect', { x: x + bw * 0.22, y: H - ph, width: bw * 0.56, height: ph, rx: 2, fill: 'var(--accent)' }));
    g.addEventListener('click', () => { info.textContent = describe(w); });
    svg.append(g);
  });
  const mid = weeks[Math.floor(weeks.length / 2)];
  return el('div', null,
    el('p', { class: 'meta', style: 'margin:0 0 6px' }, 'Best week ' + dollars(max) + '. Tap a bar to see that week.'),
    svg,
    el('div', { class: 'axis' }, el('span', null, day(weeks[0].start)), el('span', null, day(mid.start)), el('span', null, 'this week')),
    info);
}

function renderTrend() {
  const firstSale = stats.monthly.findIndex((m) => m.sales > 0);
  const months = firstSale === -1 ? stats.monthly.slice(-1) : stats.monthly.slice(firstSale);
  return el('section', null,
    el('h2', { id: 'trend' }, 'Trend'),
    el('div', { class: 'card' },
      el('h3', null, 'Sales by week, last 12 weeks'),
      weeklyChart(stats.weekly),
      el('div', { class: 'legend' }, el('span', null, el('i', { style: 'background:var(--accent-soft)' }), 'Sales'), el('span', null, el('i', { style: 'background:var(--accent)' }), 'Profit (where costs are in)')),
    ),
    el('div', { class: 'card', style: 'margin-top:10px' },
      el('h3', null, 'Month by month'),
      el('div', { class: 'list' }, months.slice().reverse().map((m) => el('div', null,
        el('div', { class: 'head' }, el('span', { class: 'name' }, month(m.start)), el('span', { class: 'num' }, dollars(m.sales))),
        el('div', { class: 'meta' }, plural(m.orders, 'order') + ' · ' + plural(m.buyers, 'buyer') + ' (' + m.newBuyers + ' new) · average ' + dollars(m.avgOrder)
          + (m.profit ? ' · profit ' + dollars(m.profit) : '')),
      ))),
    ),
  );
}

// ---------------------------------------------------------------- stock and health

function tapStep(v, s, btn, slot) {
  if (!s.tapped && s.key === 'onway') {
    const note = el('input', { type: 'text', placeholder: 'Tracking or arrival date (optional)', 'aria-label': 'Tracking or arrival date' });
    const save = el('button', { class: 'primary', type: 'button' }, 'Save');
    save.addEventListener('click', () => post('/dash/api/stock/step', { id: v.id, step: 'onway', done: true, note: note.value }, [save]));
    slot.replaceChildren(el('div', { class: 'edit', style: 'grid-template-columns:minmax(0,1fr) auto' }, note, save));
    note.focus();
    return;
  }
  post('/dash/api/stock/step', { id: v.id, step: s.key, done: !s.tapped }, [btn]);
}

function stockCard(v) {
  const slot = el('div');
  const u = v.units;
  const steps = v.steps.map((s) => {
    let extra = s.done && s.at ? ' · ' + day(s.at) + (s.auto ? ' (auto)' : '') : '';
    if (s.key === 'onway' && v.note) extra += ' · ' + v.note;
    if (s.key === 'packed' && !s.done && u.packed) extra += ' · ' + u.packed + ' of ' + u.paid;
    if (s.key === 'posted' && !s.done && u.posted) extra += ' · ' + u.posted + ' of ' + u.paid;
    const button = !s.manual ? null
      : s.tapped ? el('button', { type: 'button', class: 'link', onclick: (e) => tapStep(v, s, e.target, slot) }, 'Untick')
        : !s.done && !s.implied ? el('button', { type: 'button', class: s.key === v.stage ? 'primary' : '', onclick: (e) => tapStep(v, s, e.target, slot) }, 'Tick')
          : null;
    return el('div', { class: 's' + (s.key === v.stage ? ' now' : !s.done && !s.implied ? ' later' : '') },
      el('span', null, s.done ? '✅' : s.implied ? '☑️' : s.key === v.stage ? '👉' : '⬜'),
      el('span', { class: 'grow' }, s.label + extra),
      button);
  });
  return el('div', { class: 'card' + (v.stuck && v.stuck.level === 'bad' ? ' bad' : '') },
    el('div', { class: 'name' }, v.title),
    el('div', { class: 'meta' }, 'Claims closed ' + weekday(v.closedAt) + ' · ' + u.paid + ' paid' + (u.toPay ? ', ' + u.toPay + ' to pay' : '') + ' · ' + u.posted + ' posted'),
    v.stuck ? el('p', { class: 'stuck ' + v.stuck.level }, v.stuck.text) : null,
    el('div', { class: 'steps' }, steps),
    slot);
}

function renderStock() {
  if (!ops) return null;
  const st = ops.stock;
  return el('section', null,
    el('h2', { id: 'stock' }, 'Stock'),
    st.active.length ? el('div', { class: 'list' }, st.active.map(stockCard))
      : el('p', { class: 'empty' }, 'Nothing in progress. Each sale night shows here from the moment its claims close.'),
    st.done.length ? el('details', { class: 'card', style: 'margin-top:10px' },
      el('summary', null, 'All posted this week (' + st.done.length + ')'),
      el('div', { class: 'list', style: 'margin-top:10px' }, st.done.map((v) => el('div', { class: 'row' },
        el('span', { class: 'grow' }, v.title), el('span', { class: 'meta' }, day(v.doneAt)))))) : null,
    el('p', { class: 'note' }, 'Tick Ordered, Supplier paid, On its way and Arrived here or on the card in the staff log. The rest tick themselves: supplier paid from a Wise payment tagged as stock, arrived and packed from printed labels, posted from tracking.'));
}

const HEALTH_WORDS = { ok: 'working', warn: 'worth a look', bad: 'broken', off: 'not set up' };

function renderHealth() {
  if (!ops) return null;
  return el('section', null,
    el('h2', { id: 'health' }, 'Health'),
    el('div', { class: 'card' }, el('div', { class: 'list' }, ops.health.map((h) => el('div', null,
      el('div', { class: 'row' }, el('span', { class: 'dot ' + h.status }), el('span', { class: 'name grow' }, h.name), el('span', { class: 'meta' }, HEALTH_WORDS[h.status])),
      el('div', { class: 'meta indent' }, h.text),
      h.fix && (h.status === 'bad' || h.status === 'warn') ? el('div', { class: 'hint indent' }, 'Fix: ' + h.fix) : null)))),
    el('p', { class: 'note' }, 'Checked every 15 minutes. When a part breaks, the staff log gets one ping saying how to fix it.'));
}

// ---------------------------------------------------------------- buyers

function renderBuyers() {
  const b = stats.buyers;
  const list = buyerView === 'period' ? b.top : b.topAllTime;
  const limit = shown.buyers ? 25 : 10;
  const seg = el('div', { class: 'seg' },
    el('button', { type: 'button', 'aria-pressed': String(buyerView === 'period'), onclick: () => { buyerView = 'period'; render(); } }, stats.period.label),
    el('button', { type: 'button', 'aria-pressed': String(buyerView === 'all'), onclick: () => { buyerView = 'all'; render(); } }, 'All time'));
  const rows = list.slice(0, limit).map((x, i) => el('div', { class: 'card' },
    el('div', { class: 'head' },
      el('span', { class: 'name' }, el('span', { class: 'rank' }, '#' + (i + 1) + ' '), x.name),
      el('span', { class: 'num' }, dollars(x.spent))),
    el('div', { class: 'meta' }, plural(x.orders, 'order') + ' · ' + x.mostly + (x.via ? ' · ' + x.via : '')),
    el('div', { class: 'row', style: 'margin-top:4px' },
      el('span', { class: 'meta grow' }, 'Last bought ' + day(x.lastAt) + ' · first ' + day(x.firstAt)),
      el('span', { class: 'chip ' + (x.active ? 'active' : 'quiet') }, x.active ? 'active' : 'gone quiet')),
  ));
  return el('section', null,
    el('div', { class: 'row' }, el('h2', { id: 'buyers', class: 'grow' }, 'Biggest buyers'), seg),
    list.length ? el('div', { class: 'list' }, rows) : el('p', { class: 'empty' }, 'No buyers in this period.'),
    more('buyers', Math.min(list.length, 25), 10),
    buyerView === 'period' && stats.totals.buyers > 10 ? el('p', { class: 'insight' },
      'Your top 10 buyers made ', el('b', null, pct(b.top10Share)), ' of sales',
      stats.totals.buyers > 20 ? [' and your top 20 made ', el('b', null, pct(b.top20Share))] : null,
      b.bigOrdersShare ? ['. Orders over $1k were ', el('b', null, pct(b.bigOrdersShare)), '.'] : '.') : null,
    buyerView === 'period' && stats.totals.buyers > 1 && stats.totals.buyers <= 10 && b.bigOrdersShare ? el('p', { class: 'insight' },
      'Orders over $1k were ', el('b', null, pct(b.bigOrdersShare)), ' of sales.') : null,
    b.quiet.length ? el('div', { class: 'card todo', style: 'margin-top:12px' },
      el('h3', null, 'Gone quiet: ' + plural(b.quiet.length, 'big buyer') + ', ' + dollars(b.quietSpent) + ' between them'),
      el('p', { class: 'meta', style: 'margin:0 0 8px' }, "From your top 30, no order in 30+ days. Worth a message when something they like comes in."),
      el('div', { class: 'list' }, b.quiet.map((q) => el('div', null,
        el('div', { class: 'head' }, el('span', { class: 'name' }, q.name), el('span', { class: 'num' }, dollars(q.spent))),
        el('div', { class: 'meta' }, 'Last bought ' + day(q.lastAt) + ' · ' + q.mostly)))),
    ) : null,
    b.loyal.length ? el('p', { class: 'insight' }, 'Most sale nights joined: ', b.loyal.map((l, i) => [i ? ' · ' : '', el('b', null, l.name), ' ' + l.nights])) : null,
    el('div', { class: 'card', style: 'margin-top:12px' },
      el('h3', null, 'What people spend in total (all time)'),
      bars(b.spendGroups, { label: (r) => r.label, value: (r) => r.buyers, fmt: (r) => plural(r.buyers, 'buyer') })),
  );
}

// ---------------------------------------------------------------- products, nights

const LANG_COLOURS = { Japanese: 'var(--accent)', Chinese: 'var(--warn)', English: '#5b7bd5', Other: 'var(--soft)' };

function renderProducts() {
  const ps = stats.products;
  const limit = shown.products ? ps.length : 8;
  const total = stats.languages.reduce((t, l) => t + l.sales, 0) || 1;
  return el('section', null,
    el('h2', { id: 'products' }, 'What sells'),
    ps.length ? el('div', { class: 'list' }, ps.slice(0, limit).map((p) => el('div', { class: 'card' },
      el('div', { class: 'head' }, el('span', { class: 'name' }, p.name), el('span', { class: 'num' }, dollars(p.sales))),
      el('div', { class: 'meta' }, plural(p.units, 'unit') + ' · ' + plural(p.buyers, 'buyer') + ' · ' + dollars(p.perUnit) + ' each · ',
        p.missing && !p.costedSales ? el('span', { class: 'chip est' }, 'no cost') : el('span', { class: p.profit < 0 ? 'neg' : '' }, 'profit ' + dollars(p.profit) + (p.margin != null ? ' (' + pct(p.margin, 1) + ')' : '') + (p.estimated ? ' est.' : ''))),
    ))) : el('p', { class: 'empty' }, 'Nothing sold in this period.'),
    more('products', ps.length, 8),
    stats.languages.length ? el('div', { class: 'card', style: 'margin-top:12px' },
      el('h3', null, 'Japanese, Chinese or English'),
      el('div', { class: 'split' }, stats.languages.map((l) => el('div', { style: 'width:' + (l.sales / total) * 100 + '%;background:' + (LANG_COLOURS[l.key] || 'var(--soft)'), title: l.key }))),
      el('div', { class: 'legend' }, stats.languages.map((l) => el('span', null, el('i', { style: 'background:' + (LANG_COLOURS[l.key] || 'var(--soft)') }), l.key + ' ' + pct(l.sales / total) + ' (' + dollars(l.sales) + ')')))) : null,
  );
}

function renderNights() {
  const ns = stats.nights;
  const best = ns.slice().sort((a, b) => b.sales - a.sales)[0];
  const limit = shown.nights ? ns.length : 8;
  return el('section', null,
    el('h2', { id: 'nights' }, 'Sale nights'),
    ns.length ? el('div', { class: 'list' }, ns.slice(0, limit).map((n) => el('div', { class: 'card' },
      el('div', { class: 'head' },
        el('span', { class: 'name' }, (n === best ? '★ ' : '') + n.name),
        el('span', { class: 'num' }, dollars(n.sales))),
      el('div', { class: 'meta' }, nightDate(n.date) + ' · ' + n.units + ' sold of ' + n.claimedUnits + ' claimed'
        + (n.noShowUnits ? ' (' + n.noShowUnits + ' never paid)' : '') + ' · ' + plural(n.buyers, 'buyer') + (n.newBuyers ? ', ' + n.newBuyers + ' new' : '')
        + (n.lateUnits ? ' · ' + n.lateUnits + ' late' : '')),
    ))) : el('p', { class: 'empty' }, 'No sale nights in this period.'),
    more('nights', ns.length, 8),
    stats.newBuyersFrom.length ? el('p', { class: 'insight' }, 'New buyers came from: ',
      stats.newBuyersFrom.map((s, i) => [i ? ' · ' : '', el('b', null, s.key), ' ' + s.buyers])) : null,
  );
}

// ---------------------------------------------------------------- speed, customers, server

function renderSpeed() {
  const s = stats.speed;
  const n = stats.now;
  return el('section', null,
    el('h2', { id: 'speed' }, 'Speed and bottlenecks'),
    el('div', { class: 'grid' },
      tile('Time to pay', hours(s.payHoursMedian), 'middle claim, claim to paid'),
      tile('Paid on time', pct(s.paidOnTime), 'before the deadline'),
      tile('Never paid', String(s.noShows), s.noShows ? pct(s.noShowRate) + ' of claims · ' + dollars(s.noShowValue) + ' lost' : 'no no-shows', null, s.noShows ? 'neg' : null),
      tile('Claimed vs paid', s.paidUnits + ' / ' + s.claimedUnits, 'units paid of units claimed'),
      tile('Time to post', days(s.postDaysMedian), 'middle order, paid to posted'),
      tile('Posted with tracking', pct(s.trackedShare), 'of orders posted'),
      tile('Late claims', pct(s.lateShare), 'of sales (+10% window)'),
      tile('Express', pct(s.expressShare), 'of orders that shipped'),
    ),
    el('div', { class: 'card', style: 'margin-top:10px' },
      el('h3', null, 'Waiting right now'),
      el('div', { class: 'lines' },
        el('div', null, el('span', null, 'Paid, not posted yet'), el('span', null, plural(n.toPost, 'order') + ' (' + n.toPostUnits + ' units)' + (n.oldestToPostDays != null ? ', oldest ' + plural(n.oldestToPostDays, 'day') : ''))),
        el('div', null, el('span', null, 'Part sent, rest to go'), el('span', null, plural(n.partOrders, 'order'))),
        el('div', null, el('span', null, 'Payment screenshots to check'), el('span', null, String(n.screenshots))),
        el('div', null, el('span', null, 'Claimed, not paid yet'), el('span', null, plural(n.unpaid, 'order') + ', ' + dollars(n.unpaidValue))),
      )),
  );
}

function renderCustomers() {
  const c = stats.customers;
  const box = (title, rows) => rows.length ? el('div', { class: 'card' }, el('h3', null, title),
    bars(rows.slice(0, 8), { label: (r) => r.key, value: (r) => r.sales, fmt: (r) => dollars(r.sales) + ' · ' + r.buyers })) : null;
  return el('section', null,
    el('h2', { id: 'customers' }, 'Where sales come from'),
    el('div', { class: 'stack' },
      box('Channel', c.sources),
      box('State', c.states),
      box('Shipping', c.shipping),
    ),
    el('p', { class: 'note' }, 'Each line: sales · number of buyers.'),
  );
}

function sparkline(points) {
  const W = 600, H = 120;
  const vals = points.map((p) => p.members);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(1, hi - lo);
  const xy = points.map((p, i) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * (W - 20) + 10) + ',' + (H - 10 - ((p.members - lo) / span) * (H - 30)));
  const svg = svgEl('svg', { class: 'chart', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Members over time' });
  svg.append(svgEl('polyline', { points: xy.join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 3, 'stroke-linejoin': 'round' }));
  const first = points[0];
  const last = points[points.length - 1];
  return el('div', null, svg, el('div', { class: 'axis' },
    el('span', null, day(first.date + 'T02:00:00Z') + ': ' + first.members),
    el('span', null, day(last.date + 'T02:00:00Z') + ': ' + last.members)));
}

function renderServer() {
  const c = stats.community;
  const growth = c.growth.filter((g) => g.members != null);
  const chat = c.chat;
  const maxHour = Math.max(1, ...chat.hours);
  const busiest = chat.hours.map((n, h) => ({ n, h })).sort((a, b) => b.n - a.n).slice(0, 3).filter((x) => x.n)
    .map((x) => (x.h % 12 || 12) + (x.h < 12 ? 'am' : 'pm'));
  return el('section', null,
    el('h2', { id: 'server' }, 'The server'),
    c.members != null ? el('div', { class: 'grid' },
      tile('Members', String(c.members), c.joined30 + ' joined in 30 days'),
      tile('Have bought', pct(c.boughtShare), c.boughtMembers + ' of ' + c.humans + ' members'),
      tile('New members who bought', c.newJoiners60 ? pct(c.newJoinersBought / c.newJoiners60) : '-', c.newJoinersBought + ' of ' + c.newJoiners60 + ' who joined in 60 days'),
      tile('Chatting', chat.since ? String(chat.active30) : '-', chat.since ? 'talked in 30 days · ' + chat.active7 + ' this week' : 'tracking from today'),
    ) : el('p', { class: 'empty' }, "Couldn't reach Discord for the member numbers."),
    el('div', { class: 'card', style: 'margin-top:10px' },
      el('h3', null, 'Members over time'),
      growth.length > 1 ? sparkline(growth) : el('p', { class: 'empty' }, 'Counting members once a day from today, so this fills in as the days go by.')),
    el('div', { class: 'card', style: 'margin-top:10px' },
      el('h3', null, 'Chat'),
      chat.since ? [
        el('p', { class: 'meta', style: 'margin:0 0 8px' }, (chat.perDay7 != null ? chat.perDay7 + ' messages a day this week · ' : '') + chat.active90 + ' people talked in 90 days' + (busiest.length ? ' · busiest at ' + busiest.join(', ') : '')),
        el('div', { class: 'hours' }, chat.hours.map((n, h) => el('div', { style: 'height:' + Math.max(3, (n / maxHour) * 100) + '%', title: (h % 12 || 12) + (h < 12 ? 'am' : 'pm') + ': ' + n }))),
        el('div', { class: 'hourlbl' }, el('span', null, '12am'), el('span', null, '6am'), el('span', null, '12pm'), el('span', null, '6pm')),
        el('p', { class: 'note' }, 'Messages by hour of day, last 30 days. Counted since ' + day(chat.since + 'T02:00:00Z') + '; tickets are left out.'),
      ] : el('p', { class: 'empty' }, 'Counting messages from today (just how many and when, never what was said).')),
    el('div', { class: 'card', style: 'margin-top:10px' },
      el('h3', null, 'Which invite links bring people'),
      c.invites.links.length ? [
        el('div', { class: 'list' }, c.invites.links.slice(0, 10).map((l) => el('div', null,
          el('div', { class: 'head' }, el('span', { class: 'name' }, l.code ? 'discord.gg/' + l.code : "Link couldn't be told"), el('span', { class: 'num' }, l.bought + ' bought')),
          el('div', { class: 'meta' }, plural(l.joins, 'join') + ' · ' + l.stayed + ' still here' + (l.inviter ? ' · made by ' + l.inviter : ''))))),
        el('p', { class: 'note' }, 'Last 90 days, counted since ' + day(c.invites.since) + '. Make one invite link per place (Instagram bio, TikTok, website) to see which one brings buyers.'),
      ] : el('p', { class: 'empty' }, 'Noting which invite link each new member uses from today. Tip: make a separate link for your Instagram bio, TikTok and website, and this shows which one brings buyers.')),
  );
}

// ---------------------------------------------------------------- costs and profit

async function saveCost(id, input, actual, fix, buttons) {
  if (!input.value.trim()) { toast('Type the cost first.'); input.focus(); return; }
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const r = await api('/dash/api/cost', { productId: id, value: input.value, actual, fix });
    toast(r.text);
    await load();
  } catch (err) {
    toast(err.message);
    buttons.forEach((b) => { b.disabled = false; });
  }
}

function costEditor(p, opts) {
  const realOnly = opts && opts.realOnly;
  const input = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'e.g. 101.50 or 3524/40', 'aria-label': 'Cost per unit for ' + p.name });
  const fix = el('input', { type: 'checkbox' });
  const real = el('button', { class: 'primary', type: 'button' }, 'Real cost');
  const est = realOnly ? null : el('button', { type: 'button' }, 'Estimate');
  const buttons = [real, est].filter(Boolean);
  real.addEventListener('click', () => saveCost(p.id, input, true, fix.checked, buttons));
  if (est) est.addEventListener('click', () => saveCost(p.id, input, false, fix.checked, buttons));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') real.click(); });
  return el('div', null,
    el('div', { class: 'edit' }, input, real, est || el('span')),
    el('p', { class: 'hint' }, 'Cost of one unit, landed. Paid a total? Type it over how many, like 3524/40.'),
    p.cost != null ? el('label', { class: 'check' }, fix, 'Also re-price orders already sold at an older cost (for a cost typed wrong)') : null,
  );
}

function costChip(p) {
  if (p.cost == null) return el('span', { class: 'chip' }, 'no cost');
  return el('span', { class: 'chip ' + (p.actual ? 'real' : 'est') }, money(p.cost) + ' each · ' + (p.actual ? 'real' : 'estimate'));
}

function renderTodo() {
  const { noCost, estimated } = state.todo;
  const cards = [
    ...noCost.map((p) => el('div', { class: 'card todo' },
      el('div', { class: 'name' }, p.name),
      el('div', { class: 'meta' }, plural(p.units, 'unit') + " sold, no cost yet, so its profit isn't counted"),
      costEditor(p),
    )),
    ...estimated.map((p) => el('div', { class: 'card' },
      el('div', { class: 'row' }, el('div', { class: 'name grow' }, p.name), costChip({ cost: p.cost, actual: false })),
      el('div', { class: 'meta' }, plural(p.units, 'unit') + ' sold on the estimate. Know the real cost yet?'),
      costEditor(p, { realOnly: true }),
    )),
  ];
  return el('div', null,
    el('h3', null, cards.length ? 'Costs to put in (' + cards.length + ')' : 'Costs to put in'),
    cards.length ? el('div', { class: 'list' }, cards) : el('p', { class: 'empty' }, 'Nothing to do. Every product that sold has its real cost.'),
  );
}

function renderBreakdown() {
  const d = state.detail;
  const line = (k, v, cls) => el('div', { class: cls || '' }, el('span', null, k), el('span', { class: v < 0 ? 'neg' : '' }, money(v)));
  return el('div', null,
    el('h3', null, 'Profit, ' + d.label.toLowerCase()),
    el('div', { class: 'card' },
      d.orders ? el('div', { class: 'lines' },
        line('Sales (' + plural(d.orders, 'order') + ', ' + plural(d.units, 'unit') + ')', d.sales),
        line('Stock cost', -d.stock),
        line('Postage (Label Pro)', -d.postage),
        line('Profit' + (d.margin != null ? ' · ' + (d.margin * 100).toFixed(1) + '%' : ''), d.profit, 'total'),
        d.expenses ? line('Other expenses', -d.expenses) : null,
        d.expenses ? line('Profit after expenses', d.net, 'total') : null,
      ) : el('p', { class: 'empty' }, 'No sales in this period.'),
      d.estimatedSales ? el('p', { class: 'note' }, Math.round(d.estimatedSales / (d.sales - d.uncountedSales) * 100) + '% of this profit uses estimated costs.') : null,
      d.uncountedSales ? el('p', { class: 'note' }, money(d.uncountedSales) + " of sales has no cost yet and isn't in the profit.") : null,
    ),
  );
}

function renderCostList() {
  const limit = shown.costs ? state.products.length : 12;
  const rows = state.products.slice(0, limit).map((p) => {
    const box = el('div', { class: 'card' });
    const toggle = el('button', { class: 'link', type: 'button' }, 'Edit');
    let open = null;
    toggle.addEventListener('click', () => {
      if (open) { open.remove(); open = null; toggle.textContent = 'Edit'; return; }
      open = costEditor(p);
      box.append(open);
      toggle.textContent = 'Close';
      open.querySelector('input').focus();
    });
    box.append(
      el('div', { class: 'row' }, el('div', { class: 'name grow' }, p.name), costChip(p), toggle),
      el('div', { class: 'meta' }, (p.display ? p.display + ' · ' : '') + plural(p.sold90, 'unit') + ' sold in 90 days'),
    );
    return box;
  });
  return el('div', null, el('h3', null, 'Every product'), el('div', { class: 'list' }, rows), more('costs', state.products.length, 12));
}

function renderExpenses() {
  const date = el('input', { type: 'date', value: state.today, 'aria-label': 'Date' });
  const what = el('input', { type: 'text', class: 'what', placeholder: 'What for, e.g. bubble mailers', 'aria-label': 'What for' });
  const amount = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'Amount', 'aria-label': 'Amount' });
  const add = el('button', { class: 'primary', type: 'button' }, 'Add');
  add.addEventListener('click', async () => {
    add.disabled = true;
    try {
      await api('/dash/api/expense', { date: date.value, what: what.value, amount: amount.value });
      toast('Expense added.');
      await load();
    } catch (err) { toast(err.message); add.disabled = false; }
  });
  const list = state.expenses.map((x) => el('div', { class: 'card row' },
    el('div', { class: 'grow' }, el('div', { class: 'name' }, x.what), el('div', { class: 'meta' }, day(x.spent_on))),
    el('span', null, money(x.amount_cents)),
    el('button', { class: 'link', type: 'button', 'aria-label': 'Delete ' + x.what, onclick: async () => {
      if (!confirm('Delete "' + x.what + '"?')) return;
      try { await api('/dash/api/expense/delete', { id: x.id }); toast('Deleted.'); await load(); } catch (err) { toast(err.message); }
    } }, '✕'),
  ));
  return el('div', null,
    el('h3', null, 'Other expenses'),
    el('div', { class: 'card' }, el('div', { class: 'expense-form' }, date, what, amount, add),
      el('p', { class: 'hint' }, 'Packaging, fees, tools. Not stock or labels: those are already counted on every order.')),
    list.length ? el('div', { class: 'list', style: 'margin-top:10px' }, list) : el('p', { class: 'empty' }, 'None since last month.'),
  );
}

// ---------------------------------------------------------------- money: Wise and wholesale

function productSelect(label, allowNew) {
  const sel = el('select', { 'aria-label': label },
    el('option', { value: '' }, 'Pick the product'),
    state.products.map((p) => el('option', { value: String(p.id) }, p.name + (p.display ? ' · ' + p.display : ''))),
    allowNew ? el('option', { value: 'new' }, 'New product…') : null);
  return sel;
}

function amountText(p) {
  const main = p.aud_cents != null ? money(p.aud_cents) + (p.aud_estimated ? ' (about)' : '') : (p.amount / 100).toLocaleString('en-AU') + ' ' + p.currency;
  const other = p.other_currency ? ' · ' + (p.other_amount / 100).toLocaleString('en-AU') + ' ' + p.other_currency
    : p.currency !== 'AUD' && p.aud_cents != null ? ' · ' + (p.amount / 100).toLocaleString('en-AU') + ' ' + p.currency : '';
  return main + other;
}

async function post(path, body, buttons) {
  (buttons || []).forEach((b) => { b.disabled = true; });
  try {
    const r = await api(path, body);
    toast(r.text);
    await load();
  } catch (err) {
    toast(err.message);
    (buttons || []).forEach((b) => { b.disabled = false; });
  }
}

function wholesaleForm(prefill) {
  const pre = prefill || {};
  const customer = el('input', { type: 'text', placeholder: 'Customer', 'aria-label': 'Customer', value: pre.customer || '' });
  const product = productSelect('Product', true);
  const newName = el('input', { type: 'text', placeholder: 'New product name', 'aria-label': 'New product name', style: 'display:none' });
  product.addEventListener('change', () => { newName.style.display = product.value === 'new' ? '' : 'none'; });
  const qty = el('input', { type: 'text', inputmode: 'numeric', placeholder: 'How many', 'aria-label': 'How many' });
  const total = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'Total they paid', 'aria-label': 'Total they paid', value: pre.total || '' });
  const date = el('input', { type: 'date', 'aria-label': 'Date', value: pre.date || state.today });
  const sent = el('input', { type: 'checkbox', checked: true });
  const save = el('button', { class: 'primary', type: 'button' }, 'Save sale');
  save.addEventListener('click', () => post('/dash/api/wholesale', {
    customer: customer.value, productId: product.value && product.value !== 'new' ? product.value : null,
    productName: product.value === 'new' ? newName.value : null, quantity: qty.value, total: total.value,
    date: date.value, sent: sent.checked, paymentId: pre.paymentId || null,
  }, [save]));
  return el('div', { class: 'stack', style: 'gap:8px;margin-top:10px' },
    el('div', { class: 'grid', style: 'grid-template-columns:repeat(2,minmax(0,1fr))' }, customer, date, product, newName, qty, total),
    el('label', { class: 'check' }, sent, 'Already sent or picked up (no label needed)'),
    el('div', null, save),
    el('p', { class: 'hint' }, 'Counts as a sale in your profit, at the product\\u2019s cost. A product you type new is added, never put on sale.'),
  );
}

function tagForm(p, tag) {
  if (tag === 'wholesale') {
    return wholesaleForm({ customer: p.counterparty || '', total: p.aud_cents != null ? (p.aud_cents / 100).toFixed(2) : '', date: new Date(p.happened_at).toLocaleDateString('en-CA', { timeZone: 'Australia/Melbourne' }), paymentId: p.id });
  }
  const note = el('input', { type: 'text', placeholder: tag === 'expense' ? 'What for (optional)' : 'Note (optional)', 'aria-label': 'Note' });
  const save = el('button', { class: 'primary', type: 'button' }, 'Save');
  if (tag === 'expense') {
    save.addEventListener('click', () => post('/dash/api/wise/tag', { id: p.id, tag, note: note.value }, [save]));
    return el('div', { class: 'edit', style: 'grid-template-columns:minmax(0,1fr) auto' }, note, save);
  }
  const product = productSelect('Product', false);
  const units = el('input', { type: 'text', inputmode: 'numeric', placeholder: tag === 'stock' ? 'Units it paid for' : 'Units it carried', 'aria-label': 'Units' });
  const setCost = el('input', { type: 'checkbox', checked: true });
  save.addEventListener('click', () => post('/dash/api/wise/tag', { id: p.id, tag, productId: product.value, units: units.value, setCost: setCost.checked, note: note.value }, [save]));
  return el('div', { class: 'stack', style: 'gap:8px;margin-top:10px' },
    el('div', { class: 'grid', style: 'grid-template-columns:repeat(2,minmax(0,1fr))' }, product, units),
    el('label', { class: 'check' }, setCost, tag === 'stock' ? 'Set the real cost per unit from this payment' : 'Add this freight to its real cost per unit'),
    el('div', { class: 'row' }, el('div', { class: 'grow' }, note), save),
    tag === 'freight' ? el('p', { class: 'hint' }, 'Freight with no product? Tag it Expense instead.') : null,
  );
}

function paymentCard(p) {
  const box = el('div', { class: 'card' });
  const slot = el('div');
  const open = (tag) => { slot.replaceChildren(tagForm(p, tag)); };
  const buttons = p.direction === 'out'
    ? [['Stock', 'stock'], ['Freight', 'freight'], ['Expense', 'expense']]
    : [['Wholesale sale', 'wholesale']];
  const ignore = el('button', { type: 'button', onclick: (e) => post('/dash/api/wise/tag', { id: p.id, tag: 'ignore' }, [e.target]) }, 'Not business');
  box.append(
    el('div', { class: 'row' },
      el('span', { class: 'chip ' + (p.direction === 'in' ? 'real' : 'est') }, p.direction === 'in' ? 'Money in' : 'Money out'),
      el('span', { class: 'name grow' }, p.counterparty || 'Unknown'),
      el('span', { class: 'num' }, amountText(p))),
    el('div', { class: 'meta' }, day(p.happened_at) + (p.reference ? ' · ' + p.reference : '') + (p.status ? ' · ' + p.status.replace(/_/g, ' ') : '')),
    el('div', { class: 'row', style: 'margin-top:8px' }, buttons.map(([label, tag]) => el('button', { type: 'button', onclick: () => open(tag) }, label)), ignore),
    slot,
  );
  return box;
}

const TAG_NAMES = { stock: 'Stock', freight: 'Freight', expense: 'Expense', wholesale: 'Wholesale sale', ignore: 'Not business' };

function renderMoney() {
  const m = state.money;
  const s = m.status;
  const limit = shown.wise ? m.untagged.length : 6;
  const lastErr = s.last && s.last.errors && s.last.errors.length ? s.last.errors.join('; ') : null;
  const syncBtn = el('button', { type: 'button', onclick: (e) => post('/dash/api/wise/sync', {}, [e.target]) }, 'Sync now');
  return el('section', null,
    el('h2', { id: 'money' }, 'Money in and out'),
    el('div', { class: 'stack' },
      s.connected
        ? el('div', { class: 'card row' },
          el('span', { class: 'grow meta' }, 'Wise ' + (s.syncedAt ? 'synced ' + day(s.syncedAt) + ' ' + new Date(s.syncedAt).toLocaleTimeString('en-AU', { timeZone: 'Australia/Melbourne', hour: 'numeric', minute: '2-digit' }) : 'not synced yet') + ' · ' + plural(m.untagged.length, 'payment') + ' to tag' + (lastErr ? ' · ' + lastErr : '')),
          syncBtn)
        : el('div', { class: 'card todo' },
          el('h3', null, 'Connect Wise (2 minutes)'),
          el('p', { class: 'meta', style: 'margin:0' }, '1. In Wise: Settings, then API tokens, then Add new token. Pick Read only.'),
          el('p', { class: 'meta', style: 'margin:0' }, '2. In Railway: tcgpackbot, then Variables, then New variable: WISE_API_TOKEN, and paste the token.'),
          el('p', { class: 'meta', style: 'margin:0' }, '3. The bot pulls your payments every 3 hours. Tag each one here once.')),
      el('div', { class: 'grid' },
        tile('Money in', dollars(m.cash.in), 'sales, ' + m.period.toLowerCase()),
        tile('Money out', dollars(m.cash.out), 'tagged stock, freight, expenses + labels'),
        tile('Cash left', dollars(m.cash.net), 'in minus out', null, m.cash.net < 0 ? 'neg' : null),
        tile('Not tagged yet', dollars(m.byTag.untaggedOut), 'paid out of Wise, not tagged'),
      ),
      el('p', { class: 'note', style: 'margin:0' }, 'Profit at the top counts what sold, at its cost. Cash counts money when it moves, so stock bought for later shows here first.'),
      m.untagged.length ? el('div', null,
        el('h3', null, 'To tag (' + m.untagged.length + ')'),
        el('div', { class: 'list' }, m.untagged.slice(0, limit).map(paymentCard)),
        more('wise', m.untagged.length, 6)) : null,
      el('div', { class: 'card' }, el('h3', null, 'Add a wholesale sale'), wholesaleForm()),
      m.recent.length ? el('details', { class: 'card' },
        el('summary', null, 'Recently tagged (' + m.recent.length + ')'),
        el('div', { class: 'list', style: 'margin-top:10px' }, m.recent.map((p) => el('div', { class: 'row' },
          el('span', { class: 'grow' }, day(p.happened_at) + ' · ' + (p.counterparty || 'Unknown')),
          el('span', { class: 'meta' }, TAG_NAMES[p.tag] + (p.product_name ? ': ' + (p.units ? p.units + 'x ' : '') + p.product_name : '')),
          el('span', { class: 'num' }, amountText(p)),
          p.order_id ? null : el('button', { class: 'link', type: 'button', onclick: (e) => post('/dash/api/wise/untag', { id: p.id }, [e.target]) }, 'Undo'))))) : null,
    ),
  );
}

function renderCosts() {
  return el('section', null,
    el('h2', { id: 'costs' }, 'Costs and profit'),
    el('div', { class: 'stack' }, renderTodo(), renderBreakdown(), renderCostList(), renderExpenses()),
  );
}

function render() {
  $('period').value = period;
  $('updated').textContent = 'Updated ' + new Date(stats.generatedAt).toLocaleTimeString('en-AU', { timeZone: 'Australia/Melbourne', hour: 'numeric', minute: '2-digit' });
  $('app').replaceChildren(...[renderAlerts(), renderKey(), renderStock(), renderHealth(), renderTrend(), renderBuyers(), renderProducts(), renderNights(), renderSpeed(), renderCustomers(), renderServer(), renderMoney(), renderCosts()].filter(Boolean));
}

$('period').addEventListener('change', (e) => { period = e.target.value; load(); });
load();
`;

const PERIOD_OPTIONS = [
  ['today', 'Today'], ['week', 'This week'], ['last_week', 'Last week'], ['month', 'This month'],
  ['last_month', 'Last month'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['all', 'All time'],
];

const JUMPS = [
  ['now', 'Needs you'], ['overview', 'Numbers'], ['stock', 'Stock'], ['health', 'Health'], ['trend', 'Trend'], ['buyers', 'Buyers'], ['products', 'Products'],
  ['nights', 'Sale nights'], ['speed', 'Speed'], ['customers', 'Channels'], ['server', 'Server'], ['money', 'Money'], ['costs', 'Costs'],
];

export function renderDashboardPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Dashboard · TCG Pack Bot</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header class="top">
    <div class="toprow">
      <div class="titles"><h1>Dashboard</h1><p class="sub" id="updated">Loading…</p></div>
      <select id="period" aria-label="Period">${PERIOD_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
    </div>
    <nav class="jump" aria-label="Sections">${JUMPS.map(([id, l]) => `<a href="#${id}">${l}</a>`).join('')}</nav>
  </header>
  <div id="app" style="display: grid; gap: 26px;"><p class="empty">Loading…</p></div>
</main>
<div id="toast" role="status" aria-live="polite"></div>
<script>${SCRIPT}</script>
</body>
</html>`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderMessagePage(message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Dashboard · TCG Pack Bot</title>
<style>${STYLE}</style>
</head>
<body>
<main style="padding-top:18px"><div class="card"><h1>Dashboard</h1><p class="sub">${escapeHtml(message)}</p></div></main>
</body>
</html>`;
}

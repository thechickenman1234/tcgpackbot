/**
 * The dashboard's HTML: one self-contained page (styles and script inline,
 * nothing loaded from elsewhere) that reads /dash/api/data and posts changes
 * back. Built for a phone first. Every name from the database goes in with
 * textContent, never as HTML.
 */

const STYLE = `
:root {
  --bg: #f6f5f1; --card: #ffffff; --ink: #1d1d1b; --soft: #6b6a64; --line: #e4e1d8;
  --accent: #2f6f4f; --accent-ink: #ffffff; --warn: #a15c00; --warn-bg: #fff3df; --bad: #b3261e;
  --good-bg: #e6f2ea; --chip: #efede6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151514; --card: #1f1f1d; --ink: #f1efe8; --soft: #a3a198; --line: #34332f;
    --accent: #6cc495; --accent-ink: #0e1a13; --warn: #f0b45c; --warn-bg: #3a2c14; --bad: #ff8a80;
    --good-bg: #1d3326; --chip: #2a2a27;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 18px 16px 80px; display: grid; gap: 22px; }
h1 { font-size: 22px; margin: 4px 0 0; }
h2 { font-size: 17px; margin: 0 0 10px; }
.sub { color: var(--soft); font-size: 14px; margin: 2px 0 0; }
.tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
@media (max-width: 520px) { .tiles { grid-template-columns: 1fr; } }
.tile, .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px; min-width: 0; }
.tile .k { font-size: 13px; color: var(--soft); }
.tile .v { font-size: 26px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; }
.tile .s { font-size: 13px; color: var(--soft); margin-top: 2px; }
.neg { color: var(--bad); }
.list { display: grid; gap: 10px; }
.todo { border-color: var(--warn); background: var(--warn-bg); }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.grow { flex: 1 1 auto; min-width: 0; }
.name { font-weight: 650; overflow-wrap: anywhere; }
.meta { color: var(--soft); font-size: 14px; }
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
.chip { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 99px; background: var(--chip); color: var(--soft); }
.chip.real { background: var(--good-bg); color: var(--accent); }
.chip.est { background: var(--warn-bg); color: var(--warn); }
.lines { display: grid; gap: 6px; }
.lines div { display: flex; justify-content: space-between; gap: 12px; font-variant-numeric: tabular-nums; }
.lines .total { font-weight: 700; border-top: 1px solid var(--line); padding-top: 6px; }
.note { font-size: 13px; color: var(--soft); margin: 8px 0 0; }
.hint { font-size: 13px; color: var(--soft); margin: 6px 0 0; }
label.check { display: flex; gap: 6px; align-items: center; font-size: 13px; color: var(--soft); grid-column: 1 / -1; }
.expense-form { display: grid; grid-template-columns: 150px minmax(0, 1fr) 120px auto; gap: 8px; }
@media (max-width: 600px) { .expense-form { grid-template-columns: 1fr 1fr; } .expense-form .what { grid-column: 1 / -1; order: -1; } }
#toast { position: fixed; left: 16px; right: 16px; bottom: 16px; max-width: 520px; margin: 0 auto; padding: 12px 14px; border-radius: 12px; background: var(--ink); color: var(--bg); font-size: 15px; opacity: 0; transform: translateY(10px); transition: .2s; pointer-events: none; }
#toast.show { opacity: 1; transform: none; }
.empty { color: var(--soft); font-size: 14px; }
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
let state = null;
let period = 'month';

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid.nodeType ? kid : String(kid));
  return e;
}
const money = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

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
    state = await api('/dash/api/data?period=' + encodeURIComponent(period));
    render();
  } catch (err) {
    $('app').replaceChildren(el('p', { class: 'empty' }, err.message));
  }
}

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

function costEditor(p, { realOnly = false } = {}) {
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

function renderTiles() {
  return el('section', { class: 'tiles' }, state.tiles.map((t) => el('div', { class: 'tile' },
    el('div', { class: 'k' }, t.label + ' profit'),
    el('div', { class: 'v' + (t.net < 0 ? ' neg' : '') }, money(t.net)),
    el('div', { class: 's' }, money(t.sales) + ' sales' + (t.margin != null ? ' · ' + (t.margin * 100).toFixed(1) + '%' : '')
      + (t.estimated ? ' · some est.' : '') + (t.missing ? ' · ' + plural(t.missing, 'product') + ' uncounted' : '')),
  )));
}

function renderTodo() {
  const { noCost, estimated } = state.todo;
  const cards = [
    ...noCost.map((p) => el('div', { class: 'card todo' },
      el('div', { class: 'name' }, p.name),
      el('div', { class: 'meta' }, plural(p.units, 'unit') + ' sold, no cost yet, so its profit isn\\'t counted'),
      costEditor(p),
    )),
    ...estimated.map((p) => el('div', { class: 'card' },
      el('div', { class: 'row' }, el('div', { class: 'name grow' }, p.name), costChip({ cost: p.cost, actual: false })),
      el('div', { class: 'meta' }, plural(p.units, 'unit') + ' sold on the estimate. Know the real cost yet?'),
      costEditor(p, { realOnly: true }),
    )),
  ];
  return el('section', null,
    el('h2', null, cards.length ? 'To do (' + cards.length + ')' : 'To do'),
    cards.length ? el('div', { class: 'list' }, cards) : el('p', { class: 'empty' }, 'Nothing to do. Every product that sold has its real cost.'),
  );
}

function renderDetail() {
  const d = state.detail;
  const select = el('select', { 'aria-label': 'Period', onchange: (e) => { period = e.target.value; load(); } },
    Object.entries(state.periods).map(([k, label]) => el('option', { value: k, selected: k === state.period }, label)));
  const line = (k, v, cls) => el('div', { class: cls || '' }, el('span', null, k), el('span', { class: v < 0 ? 'neg' : '' }, money(v)));
  return el('section', null,
    el('div', { class: 'row' }, el('h2', { class: 'grow' }, 'Breakdown'), el('div', { style: 'width: 180px' }, select)),
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
      d.uncountedSales ? el('p', { class: 'note' }, money(d.uncountedSales) + ' of sales has no cost yet and isn\\'t in the profit.') : null,
    ),
    d.products.length ? el('div', { class: 'list', style: 'margin-top: 10px' }, d.products.map((p) => el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('div', { class: 'name grow' }, p.product),
        p.costed ? el('span', { class: p.profit < 0 ? 'neg' : '' }, money(p.profit) + (p.estimated ? ' est.' : '')) : el('span', { class: 'chip' }, 'no cost'),
      ),
      el('div', { class: 'meta' }, plural(p.units, 'unit') + ' · ' + money(p.sales) + ' sales'),
    ))) : null,
  );
}

function renderProducts() {
  const rows = state.products.slice(0, renderProducts.all ? undefined : 20).map((p) => {
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
  const more = state.products.length > 20 && !renderProducts.all
    ? el('button', { type: 'button', onclick: () => { renderProducts.all = true; render(); } }, 'Show all ' + state.products.length)
    : null;
  return el('section', null, el('h2', null, 'Costs'), el('div', { class: 'list' }, rows), more);
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
    el('div', { class: 'grow' }, el('div', { class: 'name' }, x.what), el('div', { class: 'meta' }, new Date(x.spent_on).toLocaleDateString('en-AU', { timeZone: 'Australia/Melbourne', day: 'numeric', month: 'short' }))),
    el('span', null, money(x.amount_cents)),
    el('button', { class: 'link', type: 'button', 'aria-label': 'Delete ' + x.what, onclick: async () => {
      if (!confirm('Delete "' + x.what + '"?')) return;
      try { await api('/dash/api/expense/delete', { id: x.id }); toast('Deleted.'); await load(); } catch (err) { toast(err.message); }
    } }, '✕'),
  ));
  return el('section', null,
    el('h2', null, 'Other expenses'),
    el('div', { class: 'card' }, el('div', { class: 'expense-form' }, date, what, amount, add),
      el('p', { class: 'hint' }, 'Packaging, fees, tools. Not stock or labels: those are already counted on every order.')),
    list.length ? el('div', { class: 'list', style: 'margin-top: 10px' }, list) : el('p', { class: 'empty' }, 'None since last month.'),
  );
}

function render() {
  $('app').replaceChildren(renderTiles(), renderTodo(), renderDetail(), renderProducts(), renderExpenses());
}

load();
`;

export function renderDashboardPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Profit · TCG Pack Bot</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <h1>Profit</h1>
    <p class="sub">TCG Pack Bot. Sales come from the bot, so all you add here is what things cost.</p>
  </header>
  <div id="app" style="display: grid; gap: 22px;"><p class="empty">Loading…</p></div>
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
<title>Profit · TCG Pack Bot</title>
<style>${STYLE}</style>
</head>
<body>
<main><div class="card"><h1>Profit dashboard</h1><p class="sub">${escapeHtml(message)}</p></div></main>
</body>
</html>`;
}

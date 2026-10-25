import { config } from '../config.js';
import { orderCode, summarise } from '../services/wholesaleOrders.js';
import { REGION_NAMES } from '../services/wholesalePrices.js';

/**
 * A shop's own page for its wholesale order, at tcgpackbot.com/q/<token>
 * (Netlify passes it through to the bot). The link is the only key, so it
 * shows nothing a shop wouldn't already have: their boxes, and once Lachy
 * has sent the quote, the shipping, the total and how to pay.
 *
 * The total stays hidden until the quote is sent, so a shipping figure
 * Lachy hasn't checked yet is never seen.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dollars = (n) => `$${Math.round(n).toLocaleString('en-AU')}`;
const day = (iso) => new Date(iso).toLocaleDateString('en-AU', { timeZone: 'Australia/Melbourne', day: 'numeric', month: 'long', year: 'numeric' });

const STYLE = `
:root { --ink:#1c1c1a; --soft:#66645d; --line:#e4e0d6; --bg:#f7f5ef; --card:#fff; --accent:#2f6f4f; --wait:#8a6d1d; --waitbg:#fbf3dc; --okbg:#e6f2ea; --stop:#8c2f2f; --stopbg:#f6e3e1; }
@media (prefers-color-scheme: dark) { :root { --ink:#f1ede3; --soft:#b6b0a2; --line:#3a352b; --bg:#17140f; --card:#221e17; --accent:#7fc79f; --wait:#e8c66b; --waitbg:#3a3120; --okbg:#1f3328; --stop:#ef9a91; --stopbg:#3d2321; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width:640px; margin:0 auto; padding:28px 16px 48px; }
.brand { color:var(--soft); font-size:14px; margin:0; letter-spacing:.02em; }
h1 { font-size:26px; margin:4px 0 2px; }
.sub { color:var(--soft); margin:0 0 18px; }
.status { border-radius:12px; padding:14px 16px; margin-bottom:18px; }
.status.wait { background:var(--waitbg); color:var(--wait); }
.status.ready, .status.paid { background:var(--okbg); color:var(--accent); }
.status.cancelled { background:var(--stopbg); color:var(--stop); }
.status b { display:block; font-size:17px; color:inherit; }
.card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:6px 16px; margin-bottom:18px; }
.region { font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:var(--soft); margin:14px 0 4px; }
.line { display:flex; gap:12px; justify-content:space-between; padding:8px 0; border-top:1px solid var(--line); }
.line:first-of-type { border-top:0; }
.line .what { min-width:0; }
.line .what small { display:block; color:var(--soft); }
.line .amt { white-space:nowrap; font-variant-numeric:tabular-nums; }
.totals { padding:10px 0 12px; border-top:1.5px solid var(--line); }
.totals div { display:flex; justify-content:space-between; padding:3px 0; font-variant-numeric:tabular-nums; }
.totals .grand { font-weight:700; font-size:18px; padding-top:8px; }
.pay { background:var(--card); border:1.5px solid var(--accent); border-radius:14px; padding:16px; margin-bottom:18px; }
.pay h2 { font-size:18px; margin:0 0 10px; }
.pay .row { display:flex; justify-content:space-between; gap:10px; align-items:center; padding:6px 0; border-top:1px solid var(--line); }
.pay .row:first-of-type { border-top:0; }
.pay .row span { color:var(--soft); }
.pay .row b { word-break:break-all; text-align:right; }
button.copy { margin-left:8px; border:1px solid var(--line); background:transparent; color:var(--ink); border-radius:999px; padding:3px 10px; font:inherit; font-size:13px; cursor:pointer; }
.help { color:var(--soft); font-size:14px; }
.help a { color:var(--accent); }
`;

function statusOf(order) {
  if (order.status === 'cancelled') return ['cancelled', 'This order was cancelled.', 'If that\'s a mistake, message us and we\'ll sort it out.'];
  if (order.status === 'paid') return ['paid', 'Paid. Thank you!', 'We\'ve ordered your stock in, and we\'ll send tracking when it\'s on its way.'];
  if (order.status === 'quoted' && order.shipping_cents != null) return ['ready', 'Your quote is ready.', 'Pay by PayID using the details below, and we\'ll order it straight in.'];
  return ['wait', 'We\'re getting your shipping quote.', 'Our supplier is working out shipping now. We\'ll message you with the total, usually the same day.'];
}

export function renderQuotePage(order) {
  const s = summarise(order);
  const code = orderCode(order);
  const [state, headline, detail] = statusOf(order);
  const showTotal = (state === 'ready' || state === 'paid') && s.shipping != null;

  const blocks = ['jp', 'cn'].filter((r) => s[r].lines.some((l) => l.price != null)).map((r) => [
    `<p class="region">${REGION_NAMES[r]} · ${s[r].boxes} boxes, ${esc(s[r].tierLabel)} pricing</p>`,
    ...s[r].lines.filter((l) => l.price != null).map((l) => `<div class="line"><div class="what">${l.qty} × ${esc(l.name)}${l.spec && l.spec !== 'Sealed box' ? `<small>${esc(l.spec)}</small>` : ''}<small>${dollars(l.price)} a box</small></div><div class="amt">${dollars(l.total)}</div></div>`),
  ].join('')).join('');

  const totals = [
    `<div><span>Boxes</span><span>${dollars(s.boxes)}</span></div>`,
    `<div><span>Shipping</span><span>${showTotal ? dollars(s.shipping) : 'being quoted'}</span></div>`,
    showTotal ? `<div class="grand"><span>Total</span><span>${dollars(s.total)} AUD</span></div>` : '',
  ].join('');

  const pay = state === 'ready' ? `
<section class="pay">
  <h2>How to pay</h2>
  <div class="row"><span>PayID</span><b>${esc(config.payId)}<button class="copy" type="button" data-copy="${esc(config.payId)}">Copy</button></b></div>
  <div class="row"><span>Amount</span><b>${dollars(s.total)} AUD</b></div>
  <div class="row"><span>Reference</span><b>${code}<button class="copy" type="button" data-copy="${code}">Copy</button></b></div>
</section>` : '';

  const who = [order.customer_name, order.business].filter(Boolean).map(esc).join(', ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Order ${code} · TCG Pack Bot</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="brand">TCG Pack Bot · Wholesale</p>
<h1>Order ${code}</h1>
<p class="sub">${who ? `For ${who} · ` : ''}${day(order.created_at)}</p>
<div class="status ${state}"><b>${headline}</b>${detail}</div>
<div class="card">${blocks}<div class="totals">${totals}</div></div>
${pay}
<p class="help">Questions? Message us on Instagram <a href="https://instagram.com/tcgpackbot">@tcgpackbot</a>, email <a href="mailto:lachie@tcgpackbot.com">lachie@tcgpackbot.com</a> or call <a href="tel:+61423596688">0423 596 688</a>, and quote ${code}.</p>
</main>
<script>
document.querySelectorAll('button.copy').forEach(function (b) {
  b.addEventListener('click', function () {
    var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(b.dataset.copy).then(done, done); else done();
  });
});
</script>
</body>
</html>`;
}

export function renderMissingPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Order not found · TCG Pack Bot</title><style>${STYLE}</style></head>
<body><main><p class="brand">TCG Pack Bot · Wholesale</p><h1>We couldn't find that order</h1><p class="sub">Check the link in your message, or ask us on Instagram <a href="https://instagram.com/tcgpackbot">@tcgpackbot</a> and we'll send it again.</p></main></body></html>`;
}

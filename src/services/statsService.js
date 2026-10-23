import { getDb } from '../db/database.js';
import { config } from '../config.js';
import { estimatedCosts, labelCostFor, missingCosts, periodRange, sumExpenses } from './profitService.js';
import { chatStats, inviteStats, melbourneDateHour, memberGrowth } from './activityService.js';
import { melbourneToUtc } from './scheduleService.js';

/**
 * Everything the dashboard shows about the business, worked out live from
 * the orders (the 17 Oct server rundown, kept up to date) plus what
 * activityService records about the server.
 *
 * One pass over every order, Lachy's own test orders left out. "Sold" is
 * paid, shipped or archived, dated by when it was paid. Cancelled and
 * unpaid claims still count where the question is about claims (no-shows,
 * pay speed, what's waiting).
 */

const DAY = 86400000;
const HOUR = 3600000;
const SOLD = new Set(['paid', 'shipped', 'archived']);
const CLAIM_SOURCES = new Set(['claim', 'late']);

const SOURCE_NAMES = {
  claim: 'Claim sales',
  late: 'Late claims (+10%)',
  wholesale: 'Wholesale',
  facebook: 'Facebook',
  dm: 'Discord DM',
  instagram: 'Instagram',
  in_person: 'In person',
  other: 'Other',
};

const STATES = {
  VICTORIA: 'VIC', 'NEW SOUTH WALES': 'NSW', QUEENSLAND: 'QLD', 'WESTERN AUSTRALIA': 'WA',
  'SOUTH AUSTRALIA': 'SA', TASMANIA: 'TAS', 'AUSTRALIAN CAPITAL TERRITORY': 'ACT', 'NORTHERN TERRITORY': 'NT',
};

const ms = (iso) => (iso ? Date.parse(iso) : null);
/** "2026-10-10" as "10 Oct". */
const shortDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const iso = (t) => (t == null ? null : new Date(t).toISOString());
const sum = (xs, f) => xs.reduce((t, x) => t + f(x), 0);
const ratio = (a, b) => (b ? a / b : null);

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function languageOf(o) {
  const t = `${o.product_display || ''} ${o.product_name || ''}`.toLowerCase();
  if (/japan|\bjp\b|\bjap\b/.test(t)) return 'Japanese';
  if (/chin|\bcn\b|\bchi\b/.test(t)) return 'Chinese';
  if (/english|\ben\b/.test(t)) return 'English';
  return 'Other';
}

function stateOf(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return 'Unknown';
  return STATES[s] || s;
}

function loadOrders() {
  const ex = config.profitExcludeBuyerIds;
  const notTests = ex.length ? `WHERE o.buyer_id NOT IN (${ex.map(() => '?').join(', ')})` : '';
  const rows = getDb().prepare(`
    SELECT o.*, b.name AS buyer_name, b.state AS buyer_state, p.display_name AS product_display,
      COALESCE(o.unit_cost_cents, p.cost_cents) AS cost_each,
      CASE WHEN o.unit_cost_cents IS NOT NULL THEN COALESCE(o.unit_cost_actual, 0) ELSE p.cost_actual END AS cost_actual,
      (SELECT COUNT(*) FROM order_parcels op WHERE op.order_id = o.id) AS parcels
    FROM orders o
    LEFT JOIN buyers b ON b.discord_id = o.buyer_id
    LEFT JOIN products p ON p.id = o.product_id
    ${notTests}
  `).all(...ex);
  return rows.map((o) => {
    const sold = SOLD.has(o.status);
    const costed = o.cost_each != null;
    return {
      ...o,
      name: o.product_display || o.product_name,
      sold,
      soldAt: sold ? ms(o.paid_at) ?? ms(o.claimed_at) : null,
      claimedAt: ms(o.claimed_at),
      paidAt: ms(o.paid_at),
      shippedAt: ms(o.shipped_at),
      deadlineAt: ms(o.payment_deadline_at),
      costed,
      profit: costed ? o.total_cents - o.cost_each * o.quantity - labelCostFor(o) : null,
      language: languageOf(o),
    };
  });
}

const toRange = (r) => ({ since: ms(r.sinceIso), until: ms(r.untilIso), label: r.label });
const inRange = (t, r) => t != null && (r.since == null || t >= r.since) && (r.until == null || t < r.until);

/** The stretch to compare against: the same span one period earlier. */
function previousRange(key, r, now) {
  const n = now.getTime();
  switch (key) {
    case 'today': return { since: r.since - DAY, until: n - DAY };
    case 'week': return { since: r.since - 7 * DAY, until: n - 7 * DAY };
    case 'month': {
      const p = toRange(periodRange('last_month', now));
      return { since: p.since, until: Math.min(p.until, p.since + (n - r.since)) };
    }
    case 'last_week': return { since: r.since - 7 * DAY, until: r.since };
    case 'last_month': return toRange(periodRange('last_month', new Date(r.since + 2 * DAY)));
    case '30d': return { since: r.since - 30 * DAY, until: r.since };
    case '90d': return { since: r.since - 90 * DAY, until: r.since };
    default: return null;
  }
}

function totals(sold, firstSold, r) {
  const buyers = new Map();
  for (const o of sold) buyers.set(o.buyer_id, (buyers.get(o.buyer_id) || 0) + o.total_cents);
  const sales = sum(sold, (o) => o.total_cents);
  const costed = sold.filter((o) => o.costed);
  const costedSales = sum(costed, (o) => o.total_cents);
  const profit = sum(costed, (o) => o.profit);
  const newBuyers = [...buyers.keys()].filter((id) => inRange(firstSold.get(id), r)).length;
  return {
    sales,
    orders: sold.length,
    units: sum(sold, (o) => o.quantity),
    avgOrder: sold.length ? Math.round(sales / sold.length) : null,
    medianOrder: median(sold.map((o) => o.total_cents)),
    over1k: sold.filter((o) => o.total_cents >= 100000).length,
    buyers: buyers.size,
    newBuyers,
    returningBuyers: buyers.size - newBuyers,
    avgPerBuyer: buyers.size ? Math.round(sales / buyers.size) : null,
    medianPerBuyer: median([...buyers.values()]),
    profit,
    costedSales,
    estimatedSales: sum(costed.filter((o) => !o.cost_actual), (o) => o.total_cents),
    uncountedSales: sales - costedSales,
    margin: ratio(profit, costedSales),
  };
}

function bucketOf(list, since, until) {
  const rows = list.filter((o) => o.soldAt >= since && (until == null || o.soldAt < until));
  const costed = rows.filter((o) => o.costed);
  return {
    sales: sum(rows, (o) => o.total_cents),
    profit: sum(costed, (o) => o.profit),
    orders: rows.length,
    buyers: new Set(rows.map((o) => o.buyer_id)).size,
    rows,
  };
}

function weeklyTrend(sold, now, weeks = 12) {
  const thisMonday = ms(periodRange('week', now).sinceIso);
  const monday = (i) => ms(periodRange('week', new Date(thisMonday - i * 7 * DAY + 12 * HOUR)).sinceIso);
  const out = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const since = monday(i);
    const { rows, ...b } = bucketOf(sold, since, i === 0 ? null : monday(i - 1));
    out.push({ start: iso(since), ...b });
  }
  return out;
}

function monthlyTrend(sold, firstSold, now, months = 6) {
  const { date } = melbourneDateHour(now.getTime());
  const [y, m] = date.split('-').map(Number);
  const start = (back) => {
    const d = new Date(Date.UTC(y, m - 1 - back, 1));
    return melbourneToUtc(d.toISOString().slice(0, 10), '00:00').getTime();
  };
  const out = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const since = start(i);
    const until = i === 0 ? null : start(i - 1);
    const { rows, ...b } = bucketOf(sold, since, until);
    const r = { since, until };
    out.push({
      start: iso(since),
      ...b,
      avgOrder: rows.length ? Math.round(b.sales / rows.length) : null,
      over1k: rows.filter((o) => o.total_cents >= 100000).length,
      newBuyers: [...new Set(rows.map((o) => o.buyer_id))].filter((id) => inRange(firstSold.get(id), r)).length,
    });
  }
  return out;
}

function buyerRows(sold, lastSold, firstSold, now) {
  const map = new Map();
  for (const o of sold) {
    const b = map.get(o.buyer_id) || { id: o.buyer_id, name: o.buyer_name || 'No name', spent: 0, orders: 0, units: 0, products: new Map(), sources: new Map() };
    b.spent += o.total_cents;
    b.orders += 1;
    b.units += o.quantity;
    b.products.set(o.name, (b.products.get(o.name) || 0) + o.quantity);
    b.sources.set(o.source, (b.sources.get(o.source) || 0) + 1);
    map.set(o.buyer_id, b);
  }
  return [...map.values()].sort((a, b) => b.spent - a.spent).map((b) => {
    const top = [...b.products.entries()].sort((x, y) => y[1] - x[1]);
    const via = [...b.sources.entries()].sort((x, y) => y[1] - x[1])[0][0];
    const last = lastSold.get(b.id);
    return {
      id: b.id,
      name: b.name,
      spent: b.spent,
      orders: b.orders,
      units: b.units,
      mostly: top.slice(0, 2).map(([p, n]) => `${n}x ${p}`).join(', ') + (top.length > 2 ? ` +${top.length - 2} more` : ''),
      via: CLAIM_SOURCES.has(via) ? null : SOURCE_NAMES[via] || via,
      firstAt: iso(firstSold.get(b.id)),
      lastAt: iso(last),
      active: last != null && now.getTime() - last <= 30 * DAY,
    };
  });
}

function productRows(sold) {
  const map = new Map();
  for (const o of sold) {
    const p = map.get(o.product_name) || {
      product: o.product_name, name: o.name, language: o.language, sales: 0, units: 0, goods: 0,
      buyers: new Set(), profit: 0, costedSales: 0, estimated: false, missing: false,
    };
    p.sales += o.total_cents;
    p.units += o.quantity;
    p.goods += o.unit_price_cents * o.quantity;
    p.buyers.add(o.buyer_id);
    if (o.costed) {
      p.profit += o.profit;
      p.costedSales += o.total_cents;
      if (!o.cost_actual) p.estimated = true;
    } else {
      p.missing = true;
    }
    map.set(o.product_name, p);
  }
  return [...map.values()].sort((a, b) => b.sales - a.sales).map((p) => ({
    ...p,
    buyers: p.buyers.size,
    perUnit: p.units ? Math.round(p.goods / p.units) : null,
    margin: ratio(p.profit, p.costedSales),
  }));
}

/**
 * Sale nights, rebuilt from the orders themselves so nights from before the
 * scheduler count too: a product's claims on one evening (claims after
 * midnight belong to the evening before), with its late claims folded in.
 */
function saleNights(all, firstOrderId) {
  const nights = new Map();
  const claims = all.filter((o) => CLAIM_SOURCES.has(o.source) && o.claimedAt != null).sort((a, b) => a.claimedAt - b.claimedAt);
  const nightOf = (o) => melbourneDateHour(o.claimedAt - 6 * HOUR).date;
  const add = (key, date, o) => {
    const n = nights.get(key) || {
      date, product: o.product_name, name: o.name, sales: 0, units: 0, buyers: new Set(), newBuyers: 0,
      claimedUnits: 0, noShowUnits: 0, lateUnits: 0, orders: 0,
    };
    n.claimedUnits += o.quantity;
    if (o.status === 'cancelled' && o.cancel_reason === 'payment_deadline_expired') n.noShowUnits += o.quantity;
    if (o.sold) {
      n.sales += o.total_cents;
      n.units += o.quantity;
      n.orders += 1;
      n.buyers.add(o.buyer_id);
      if (o.source === 'late') n.lateUnits += o.quantity;
      if (firstOrderId.get(o.buyer_id) === o.id) n.newBuyers += 1;
    }
    nights.set(key, n);
  };
  for (const o of claims.filter((c) => c.source === 'claim')) {
    const date = nightOf(o);
    add(`${o.product_name}|${date}`, date, o);
  }
  for (const o of claims.filter((c) => c.source === 'late')) {
    const date = nightOf(o);
    const earlier = [...nights.values()]
      .filter((n) => n.product === o.product_name && n.date <= date && Date.parse(date) - Date.parse(n.date) <= 2 * DAY)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    add(earlier ? `${earlier.product}|${earlier.date}` : `${o.product_name}|${date}`, earlier ? earlier.date : date, o);
  }
  return [...nights.values()].map((n) => ({ ...n, buyers: n.buyers.size, at: melbourneToUtc(n.date, '20:00').getTime() }));
}

function speed(all, soldInRange, r) {
  const claimed = all.filter((o) => CLAIM_SOURCES.has(o.source) && inRange(o.claimedAt, r));
  const paidClaims = claimed.filter((o) => o.sold && o.paidAt != null);
  const noShows = claimed.filter((o) => o.status === 'cancelled' && o.cancel_reason === 'payment_deadline_expired');
  const otherCancels = claimed.filter((o) => o.status === 'cancelled' && o.cancel_reason !== 'payment_deadline_expired');
  const posted = all.filter((o) => o.sold && inRange(o.paidAt, r) && o.shippedAt != null);
  const shippedWithFee = soldInRange.filter((o) => o.shipping_cents > 0);
  const salesTotal = sum(soldInRange, (o) => o.total_cents);
  return {
    claims: claimed.length,
    claimedUnits: sum(claimed, (o) => o.quantity),
    paidUnits: sum(paidClaims, (o) => o.quantity),
    payHoursMedian: median(paidClaims.map((o) => (o.paidAt - o.claimedAt) / HOUR)),
    paidOnTime: ratio(paidClaims.filter((o) => o.deadlineAt == null || o.paidAt <= o.deadlineAt).length, paidClaims.length),
    noShows: noShows.length,
    noShowUnits: sum(noShows, (o) => o.quantity),
    noShowValue: sum(noShows, (o) => o.total_cents),
    noShowRate: ratio(noShows.length, claimed.length),
    otherCancels: otherCancels.length,
    postDaysMedian: median(posted.map((o) => (o.shippedAt - o.paidAt) / DAY)),
    trackedShare: ratio(posted.filter((o) => o.tracking_code).length, posted.length),
    lateShare: ratio(sum(soldInRange.filter((o) => o.source === 'late'), (o) => o.total_cents), salesTotal),
    expressShare: ratio(shippedWithFee.filter((o) => o.shipping_method === 'express').length, shippedWithFee.length),
  };
}

function rightNow(all, now) {
  const pending = all.filter((o) => o.status === 'pending');
  const held = pending.filter((o) => o.proof_at);
  const paid = all.filter((o) => o.status === 'paid');
  const oldestPaid = Math.min(...paid.map((o) => o.paidAt ?? now.getTime()));
  return {
    unpaid: pending.length - held.length,
    unpaidValue: sum(pending.filter((o) => !o.proof_at), (o) => o.total_cents),
    screenshots: held.length,
    toPost: paid.length,
    toPostUnits: sum(paid, (o) => o.quantity),
    oldestToPostDays: paid.length ? Math.floor((now.getTime() - oldestPaid) / DAY) : null,
    partOrders: paid.filter((o) => o.parcels > 0).length,
    costsMissing: missingCosts({ now }).length,
    estimates: estimatedCosts({ now }).length,
  };
}

function grouped(list, keyOf, valueOf = (o) => o.total_cents) {
  const map = new Map();
  for (const o of list) {
    const k = keyOf(o);
    const g = map.get(k) || { key: k, sales: 0, orders: 0, buyers: new Set() };
    g.sales += valueOf(o);
    g.orders += 1;
    g.buyers.add(o.buyer_id);
    map.set(k, g);
  }
  return [...map.values()].map((g) => ({ ...g, buyers: g.buyers.size })).sort((a, b) => b.sales - a.sales);
}

/**
 * Members who've bought and how new members convert, from a members list the
 * caller fetched from Discord (null when Discord couldn't be reached).
 */
function community(members, buyerIds, now) {
  const out = { growth: memberGrowth(120, now.getTime()), chat: chatStats(now.getTime()), invites: inviteStats(buyerIds, 90, now.getTime()) };
  if (!members) return out;
  const bought = [...members.ids].filter((id) => buyerIds.has(id)).length;
  const recent = members.joined60;
  return {
    ...out,
    members: members.total,
    humans: members.ids.size,
    joined30: members.joined30,
    boughtMembers: bought,
    boughtShare: ratio(bought, members.ids.size),
    newJoiners60: recent.length,
    newJoinersBought: recent.filter((id) => buyerIds.has(id)).length,
  };
}

export function statsFor(periodKey = 'month', { now = new Date(), members = null } = {}) {
  const all = loadOrders();
  const sold = all.filter((o) => o.sold).sort((a, b) => a.soldAt - b.soldAt);

  const firstSold = new Map();
  const lastSold = new Map();
  const firstOrderId = new Map();
  for (const o of sold) {
    if (!firstSold.has(o.buyer_id)) {
      firstSold.set(o.buyer_id, o.soldAt);
      firstOrderId.set(o.buyer_id, o.id);
    }
    lastSold.set(o.buyer_id, o.soldAt);
  }
  const buyerIds = new Set(firstSold.keys());

  const range = toRange(periodRange(periodKey, now));
  const inPeriod = sold.filter((o) => inRange(o.soldAt, range));
  const current = totals(inPeriod, firstSold, range);
  current.expenses = sumExpenses({ sinceIso: iso(range.since), untilIso: iso(range.until) });
  current.net = current.profit - current.expenses;

  const prevR = previousRange(periodKey, range, now);
  const previous = prevR ? totals(sold.filter((o) => inRange(o.soldAt, prevR)), firstSold, prevR) : null;
  if (previous) {
    previous.expenses = sumExpenses({ sinceIso: iso(prevR.since), untilIso: iso(prevR.until) });
    previous.net = previous.profit - previous.expenses;
  }

  const periodBuyers = buyerRows(inPeriod, lastSold, firstSold, now);
  const allBuyers = buyerRows(sold, lastSold, firstSold, now);
  const top = (n) => sum(periodBuyers.slice(0, n), (b) => b.spent);

  // Loyalty: how many different sale nights each buyer has bought on.
  const nights = saleNights(all, firstOrderId);
  const nightsByBuyer = new Map();
  for (const o of sold.filter((x) => CLAIM_SOURCES.has(x.source))) {
    const key = `${o.product_name}|${melbourneDateHour(o.claimedAt - 6 * HOUR).date}`;
    if (!nightsByBuyer.has(o.buyer_id)) nightsByBuyer.set(o.buyer_id, new Set());
    nightsByBuyer.get(o.buyer_id).add(key);
  }
  const loyal = [...nightsByBuyer.entries()]
    .map(([id, set]) => ({ id, name: allBuyers.find((b) => b.id === id)?.name || 'No name', nights: set.size }))
    .filter((b) => b.nights > 1)
    .sort((a, b) => b.nights - a.nights)
    .slice(0, 8);

  const quiet = allBuyers.slice(0, 30).filter((b) => !b.active);
  const lifetime = allBuyers.map((b) => b.spent);
  const bucket = (lo, hi) => lifetime.filter((v) => v >= lo && (hi == null || v < hi)).length;

  const periodNights = nights.filter((n) => inRange(n.at, range)).sort((a, b) => b.at - a.at);
  const firstOrders = inPeriod.filter((o) => firstOrderId.get(o.buyer_id) === o.id);

  return {
    period: { key: periodKey, label: range.label, since: iso(range.since), until: iso(range.until) },
    generatedAt: now.toISOString(),
    totals: current,
    previous,
    allTime: {
      sales: sum(sold, (o) => o.total_cents),
      buyers: buyerIds.size,
      orders: sold.length,
      units: sum(sold, (o) => o.quantity),
      repeatBuyers: allBuyers.filter((b) => b.orders > 1).length,
      firstSale: sold[0] ? iso(sold[0].soldAt) : null,
    },
    weekly: weeklyTrend(sold, now),
    monthly: monthlyTrend(sold, firstSold, now),
    buyers: {
      top: periodBuyers.slice(0, 25),
      topAllTime: allBuyers.slice(0, 25),
      top10Share: ratio(top(10), current.sales),
      top20Share: ratio(top(20), current.sales),
      bigOrdersShare: ratio(sum(inPeriod.filter((o) => o.total_cents >= 100000), (o) => o.total_cents), current.sales),
      quiet: quiet.slice(0, 12),
      quietSpent: sum(quiet, (b) => b.spent),
      loyal,
      spendGroups: [
        { label: 'Under $200', buyers: bucket(0, 20000) },
        { label: '$200 to $500', buyers: bucket(20000, 50000) },
        { label: '$500 to $1k', buyers: bucket(50000, 100000) },
        { label: '$1k to $3k', buyers: bucket(100000, 300000) },
        { label: '$3k+', buyers: bucket(300000, null) },
      ],
    },
    products: productRows(inPeriod),
    languages: grouped(inPeriod, (o) => o.language),
    nights: periodNights.slice(0, 40),
    newBuyersFrom: grouped(firstOrders, (o) => (CLAIM_SOURCES.has(o.source)
      ? `${o.name} (${shortDate(melbourneDateHour(o.claimedAt - 6 * HOUR).date)})`
      : SOURCE_NAMES[o.source] || o.source)).slice(0, 6).map((g) => ({ key: g.key, buyers: g.buyers })),
    speed: speed(all, inPeriod, range),
    now: rightNow(all, now),
    customers: {
      states: grouped(inPeriod, (o) => stateOf(o.buyer_state)),
      sources: grouped(inPeriod, (o) => SOURCE_NAMES[o.source] || o.source),
      shipping: grouped(inPeriod, (o) => (!o.shipping_cents ? 'No shipping' : o.shipping_method === 'express' ? 'Express' : 'Standard')),
    },
    community: community(members, buyerIds, now),
  };
}

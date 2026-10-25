import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { getMeta, setMeta } from '../services/metaService.js';
import { ZONE, listPending, melbourneToUtc } from '../services/scheduleService.js';
import { estimatedCosts, missingCosts, money, profitFor, profitLines, soldOrders, summarise } from '../services/profitService.js';
import { untaggedPayments } from '../services/moneyService.js';
import { listUpcomingSales, productsFor } from '../services/scheduledSaleService.js';
import { openWholesaleOrders, orderCode } from '../services/wholesaleOrders.js';
import { listPosts } from '../services/zernioService.js';
import { healthReport } from '../services/healthService.js';
import { stuckStock } from '../services/stockTracker.js';
import { dashboardUrl } from '../dashboard/dashboard.js';
import { ebayBriefLines } from '../services/ebayBoard.js';

/**
 * One message in the staff log at 9am Melbourne, so nobody has to check five
 * places: what's on today, what's waiting on staff, how yesterday went (on
 * Mondays, last week's profit too) and whether every part is working. It
 * pings the staff role only when something needs doing.
 *
 * It replaced the Monday profit post and the 10am costs reminder. It runs
 * once a day: the day is stored before posting, so a restart or a failed
 * post never sends it twice.
 */

const BRIEF_HOUR = 9;
const DAY = 86400000;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function melbourneNow(now) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hour12: false,
  }).formatToParts(now)) parts[p.type] = p.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, hour: Number(parts.hour) % 24 };
}

const shiftDate = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const time = (iso) => new Date(iso).toLocaleTimeString('en-AU', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' }).replace(' ', '');
const title = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

/** Unpaid claims, screenshots, orders to post: the same counts as the dashboard's "Needs you now". */
function waiting(now) {
  const ex = config.profitExcludeBuyerIds;
  const notTests = ex.length ? `AND buyer_id NOT IN (${ex.map(() => '?').join(', ')})` : '';
  const rows = getDb().prepare(`
    SELECT o.status, o.proof_at, o.total_cents, o.quantity, o.paid_at,
      (SELECT COUNT(*) FROM order_parcels p WHERE p.order_id = o.id) AS parcels
    FROM orders o WHERE o.status IN ('pending', 'paid') ${notTests}
  `).all(...ex);
  const pending = rows.filter((o) => o.status === 'pending');
  const paid = rows.filter((o) => o.status === 'paid');
  const oldest = paid.map((o) => Date.parse(o.paid_at)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return {
    unpaid: pending.filter((o) => !o.proof_at),
    screenshots: pending.filter((o) => o.proof_at).length,
    toPost: paid.reduce((n, o) => n + o.quantity, 0),
    oldestDays: oldest ? Math.floor((now.getTime() - oldest) / DAY) : null,
    partOrders: paid.filter((o) => o.parcels > 0).length,
  };
}

function newBuyers(sinceIso, untilIso) {
  const ex = config.profitExcludeBuyerIds;
  const notTests = ex.length ? `AND buyer_id NOT IN (${ex.map(() => '?').join(', ')})` : '';
  return getDb().prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT buyer_id, MIN(COALESCE(paid_at, claimed_at)) AS first FROM orders
      WHERE status IN ('paid', 'shipped', 'archived') ${notTests} GROUP BY buyer_id
    ) WHERE first >= ? AND first < ?
  `).get(...ex, sinceIso, untilIso).n;
}

async function today(client, date) {
  const start = melbourneToUtc(date, '00:00').getTime();
  const end = melbourneToUtc(shiftDate(date, 1), '00:00').getTime();
  const isToday = (iso) => iso && Date.parse(iso) >= start && Date.parse(iso) < end;
  const lines = [];

  for (const sale of listUpcomingSales().filter((s) => isToday(s.start_at))) {
    const items = productsFor(sale).map((p) => `${p.display_name || p.name} (${money(p.price_cents)}, ${p.quantity_available} in stock)`);
    lines.push(`🛒 ${time(sale.start_at)} claim sale: ${items.join(', ') || 'no products left in it'}`);
  }
  try {
    const posts = (await listPosts('scheduled')).filter((p) => isToday(p.at)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const p of posts) lines.push(`📸 ${time(p.at)} ${p.platforms.map((x) => x.name).join(' + ') || 'post'}: "${p.caption}"`);
  } catch (err) {
    lines.push(`📸 Couldn't read the scheduled posts from Zernio: ${err.message}`);
  }
  const discord = listPending().filter((m) => isToday(m.send_at));
  if (discord.length) lines.push(`💬 ${plural(discord.length, 'Discord post')} queued: ${discord.slice(0, 3).map((m) => `${time(m.send_at)} <#${m.channel_id}>`).join(', ')}`);
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const events = [...(await guild.scheduledEvents.fetch()).values()]
      .filter((e) => isToday(new Date(e.scheduledStartTimestamp).toISOString()) && !/^claim sale/i.test(e.name));
    for (const e of events) lines.push(`📅 ${time(new Date(e.scheduledStartTimestamp).toISOString())} ${e.name}`);
  } catch {
    // No events is the usual answer; a failed read just leaves them out.
  }
  return lines;
}

function needsYou(now, { monday }) {
  const w = waiting(now);
  const lines = [];
  let action = false;
  const add = (text, isAction = true) => {
    lines.push(text);
    if (isAction) action = true;
  };

  if (w.screenshots) add(`🧾 ${plural(w.screenshots, 'payment screenshot')} to check`);
  if (w.toPost) add(`📦 ${plural(w.toPost, 'unit')} paid and waiting to post${w.oldestDays ? ` (oldest ${plural(w.oldestDays, 'day')})` : ''}`);
  if (w.partOrders) add(`📦 ${plural(w.partOrders, 'part order')} waiting for the rest`);
  if (w.unpaid.length) {
    add(`⏳ ${plural(w.unpaid.length, 'unpaid claim')} (${money(w.unpaid.reduce((n, o) => n + o.total_cents, 0))}): the bot chases and cancels these`, false);
  }

  const wholesale = openWholesaleOrders();
  const label = { new: 'to quote', asked: 'waiting on the supplier', quoted: 'quote sent, waiting to be paid' };
  if (wholesale.length) {
    add(`🏪 Wholesale: ${wholesale.slice(0, 6).map((o) => `${orderCode(o)} ${o.customer_name || o.customer_username || ''} ${label[o.status] || o.status}`.replace(/\s+/g, ' ')).join(' · ')}`,
      wholesale.some((o) => o.status === 'new'));
  }

  for (const s of stuckStock({ now })) add(`${s.stuck.level === 'bad' ? '🔴' : '🟡'} Stock, ${s.title}: ${s.stuck.text}`, s.stuck.level === 'bad');

  const ebay = ebayBriefLines({ now });
  for (const line of ebay.lines) lines.push(line);
  if (ebay.action) action = true;

  const missing = missingCosts({ now });
  if (missing.length) add(`💰 ${plural(missing.length, 'product')} sold with no cost: ${missing.slice(0, 5).map((m) => m.product).join(', ')}`);
  const toTag = untaggedPayments(500).length;
  if (toTag) add(`💸 ${plural(toTag, 'Wise payment')} to tag`);
  if (monday) {
    const estimates = estimatedCosts({ now });
    if (estimates.length) add(`🧾 Still on estimated costs: ${estimates.slice(0, 5).map((p) => p.product).join(', ')}. Know the real figures yet?`, false);
  }
  return { lines, action };
}

/** The brief as it would go out now: { title, description, ping }. */
export async function buildBrief(client, now = new Date()) {
  const { date, weekday } = melbourneNow(now);
  const monday = weekday === 'Mon';
  const sections = [];

  const on = await today(client, date);
  sections.push('**Today**', ...(on.length ? on : ['Nothing scheduled.']));

  const needs = needsYou(now, { monday });
  sections.push('', '**Needs you**', ...(needs.lines.length ? needs.lines : ['Nothing. 🎉']));

  const since = melbourneToUtc(shiftDate(date, -1), '00:00').toISOString();
  const until = melbourneToUtc(date, '00:00').toISOString();
  const y = summarise(soldOrders({ sinceIso: since, untilIso: until }));
  sections.push('', '**Yesterday**', y.orders
    ? `${money(y.sales)} sales · ${plural(y.orders, 'order')} · ${plural(y.units, 'unit')} · ${plural(newBuyers(since, until), 'new buyer')}`
    : 'No sales.');

  if (monday) {
    const week = profitLines(profitFor('last_week', { now }));
    sections.push('', '**Last week**', ...week.slice(0, Math.max(1, week.indexOf(''))));
  }

  const health = await healthReport({ now, fresh: true });
  const problems = health.filter((h) => h.status === 'bad' || h.status === 'warn');
  const checked = health.filter((h) => h.status !== 'off').length;
  sections.push('', '**Health**', ...(problems.length
    ? problems.map((h) => `${h.status === 'bad' ? '🔴' : '🟡'} ${h.name}: ${h.text}`)
    : [`✅ All ${checked} checks fine.`]));

  const url = dashboardUrl();
  sections.push('', url ? `Dashboard: ${url} (signed out? run \`/dashboard\`)` : 'Dashboard: run `/dashboard`.');

  return {
    title: `☀️ ${title(date)}`,
    description: sections.join('\n').slice(0, 4000),
    ping: needs.action || problems.some((h) => h.status === 'bad'),
  };
}

export async function runDailyBrief(client, now = new Date()) {
  const { date, hour } = melbourneNow(now);
  // Mornings only: a bot that was down until the evening skips the day
  // rather than pinging at night, and the missing brief says it was down.
  if (hour < BRIEF_HOUR || hour >= BRIEF_HOUR + 3 || getMeta('brief_day') === date) return false;
  setMeta('brief_day', date);
  const brief = await buildBrief(client, now);
  const channel = await client.channels.fetch(config.staffLogChannelId);
  if (!channel?.isTextBased()) return false;
  const role = brief.ping && config.staffRoleId ? config.staffRoleId : null;
  await channel.send({
    content: role ? `<@&${role}>` : undefined,
    embeds: [new EmbedBuilder().setTitle(brief.title).setDescription(brief.description).setColor(brief.ping ? 0xf39c12 : 0x27ae60).setTimestamp()],
    allowedMentions: { roles: role ? [role] : [] },
  });
  return true;
}

export function startDailyBriefJob(client, intervalMs = 5 * 60000) {
  const tick = () => {
    runDailyBrief(client).catch((err) => console.error('Daily brief failed:', err));
  };
  setTimeout(tick, 60000);
  return setInterval(tick, intervalMs);
}

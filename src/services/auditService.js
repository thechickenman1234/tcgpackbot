import { getDb } from '../db/database.js';

/**
 * The server audit: a read-only snapshot of the Discord, made so the server
 * can be improved for sales. Nothing here posts, edits or deletes anything.
 *
 * Members' words are personal data, so the report is built to keep them
 * that way: private channels show counts only, claim tickets (threads) are
 * never read, every name becomes "Member 12" or "Staff 2", and anything that
 * looks like an email, phone number, address, link or long number is blanked
 * before it reaches the file.
 */

const ZONE = 'Australia/Melbourne';

// Order matters: mentions and links first, so their digits and @ signs are
// gone before the email and number patterns look.
const REDACTIONS = [
  [/<@!?\d+>/g, '@member'],
  [/<@&\d+>/g, '@role'],
  [/<#\d+>/g, '#channel'],
  [/https?:\/\/\S+/g, '[link]'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]'],
  [/(?:\+?61|\b0)[\s-]?4(?:[\s-]?\d){8}\b/g, '[phone]'],
  [/\bbsb\b[:\s#-]*\d{3}[\s-]?\d{3}\b/gi, 'BSB [number]'],
  [/\b\d(?:[\s-]?\d){7,}\b/g, '[number]'],
  [/\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Ct|Court|Pl|Place|Cres|Crescent|Way|Lane|Ln|Pde|Parade|Hwy|Highway|Blvd|Boulevard|Cl|Close|Tce|Terrace)\b\.?/g, '[address]'],
];

/** One line of member text, safe to put in the file. */
export function redact(text, max = 200) {
  let out = String(text ?? '').replace(/\s+/g, ' ').trim();
  for (const [pattern, swap] of REDACTIONS) out = out.replace(pattern, swap);
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** Stable stand-in names for one report: the same person is the same "Member 3" throughout. */
export function pseudonymizer() {
  const names = new Map();
  let staff = 0;
  let members = 0;
  return (userId, { isStaff = false, isBot = false } = {}) => {
    if (isBot) return 'Bot';
    if (!names.has(userId)) names.set(userId, isStaff ? `Staff ${++staff}` : `Member ${++members}`);
    return names.get(userId);
  };
}

const hourFormat = new Intl.DateTimeFormat('en-AU', { timeZone: ZONE, hour: 'numeric', hourCycle: 'h23' });

export function melbourneHour(date) {
  return Number(hourFormat.format(date)) % 24;
}

function hourLabel(h) {
  const suffix = h < 12 ? 'am' : 'pm';
  return `${h % 12 === 0 ? 12 : h % 12}${suffix}`;
}

/** The busiest hours, as "8pm, 9pm, 7pm". */
export function busiestHours(hours, top = 3) {
  return hours
    .map((n, h) => ({ n, h }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, top)
    .map((x) => hourLabel(x.h))
    .join(', ');
}

/**
 * Counts for one channel, plus questions and a recent sample when the
 * channel is public. messages: [{ authorId, isBot, isStaff, createdAt, content }]
 */
export function summarizeChannel(messages, { includeText = false, pseudo = pseudonymizer(), sample = 15 } = {}) {
  const humans = messages.filter((m) => !m.isBot);
  const hours = Array(24).fill(0);
  for (const m of humans) hours[melbourneHour(m.createdAt)] += 1;
  const newestFirst = [...humans].sort((a, b) => b.createdAt - a.createdAt);

  const line = (m) => `${pseudo(m.authorId, m)}: ${redact(m.content)}`;
  const withText = newestFirst.filter((m) => m.content && m.content.trim());

  return {
    count: messages.length,
    humanCount: humans.length,
    authors: new Set(humans.map((m) => m.authorId)).size,
    staffShare: humans.length ? humans.filter((m) => m.isStaff).length / humans.length : 0,
    lastAt: messages.length ? new Date(Math.max(...messages.map((m) => m.createdAt.getTime()))) : null,
    hours,
    questions: includeText
      ? withText.filter((m) => !m.isStaff && m.content.includes('?')).slice(0, sample).map(line)
      : [],
    recent: includeText ? withText.slice(0, sample).map(line) : [],
  };
}

/** Who has bought, who came back, and what leaked: from the bot's own orders. */
export function buyerStats(sinceIso) {
  const db = getDb();
  const done = "status IN ('paid', 'shipped', 'archived')";
  const perBuyer = db.prepare(`SELECT buyer_id, COUNT(*) AS n FROM orders WHERE ${done} GROUP BY buyer_id`).all();
  const recent = db.prepare(`
    SELECT COUNT(*) AS orders, COUNT(DISTINCT buyer_id) AS buyers, COALESCE(SUM(total_cents), 0) AS cents
    FROM orders WHERE ${done} AND paid_at >= ?
  `).get(sinceIso);
  return {
    everBought: perBuyer.length,
    repeat: perBuyer.filter((b) => b.n >= 2).length,
    buyerIds: new Set(perBuyer.map((b) => b.buyer_id)),
    recentOrders: recent.orders,
    recentBuyers: recent.buyers,
    recentCents: recent.cents,
    cancelledUnpaid: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'cancelled' AND cancelled_at >= ?").get(sinceIso).n,
    pendingNow: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'").get().n,
  };
}

const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '0%');
const money = (cents) => `$${(cents / 100).toLocaleString('en-AU', { maximumFractionDigits: 0 })}`;
const cell = (value) => String(value ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');

const dayFormat = new Intl.DateTimeFormat('en-AU', { timeZone: ZONE, day: 'numeric', month: 'short', year: 'numeric' });

function ago(date, now) {
  if (!date) return 'nothing';
  const days = Math.floor((now - date) / 86400000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

/** The whole report as Markdown, for staff to read or hand to Claude. */
export function buildAuditMarkdown(r) {
  const now = r.now ?? new Date();
  const out = [];
  out.push(`# Server audit: ${r.guildName}`);
  out.push('');
  out.push(`Made ${dayFormat.format(now)}, covering the last ${r.days} days. Read-only: nothing was posted or changed. Names are replaced with "Member N" and "Staff N", private channels show counts only, claim tickets are not read, and contact details are blanked.`);
  out.push('');

  const s = r.stats;
  out.push('## At a glance');
  out.push('');
  out.push(`- **Members:** ${r.humans} people and ${r.bots} bots. Joined in the last 7 / 30 / 90 days: ${r.joined[7]} / ${r.joined[30]} / ${r.joined[90]}`);
  out.push(`- **Talked in the last ${r.days} days:** ${r.posters} (${pct(r.posters, r.humans)} of members)`);
  out.push(`- **Have ever bought:** ${s.everBought} (${pct(s.everBought, r.humans)} of members). Bought twice or more: ${s.repeat}`);
  out.push(`- **Buyer role:** ${r.buyerRoleName ? `${r.buyerRoleCount} members have "${r.buyerRoleName}"` : 'not found'}`);
  out.push(`- **Last ${r.days} days:** ${s.recentOrders} paid orders from ${s.recentBuyers} buyers, ${money(s.recentCents)}`);
  out.push(`- **Claims cancelled unpaid in the last ${r.days} days:** ${s.cancelledUnpaid}. Waiting on payment now: ${s.pendingNow}`);
  out.push(`- **Busiest hours, Melbourne time:** ${busiestHours(r.hoursAll) || 'no messages'}`);
  out.push('');

  out.push('## Setup');
  out.push('');
  out.push(`- Verification level: ${r.setup.verification}. Boosts: ${r.setup.boosts} (tier ${r.setup.tier})`);
  out.push(`- Rules channel: ${r.setup.rules || 'none'}. Join messages go to: ${r.setup.system || 'nowhere'}`);
  out.push(`- Community features: ${r.setup.features.length ? r.setup.features.join(', ') : 'none'}`);
  if (r.welcome) {
    out.push(`- Welcome screen: "${cell(r.welcome.description)}"`);
    for (const w of r.welcome.channels) out.push(`  - #${w.name}: ${cell(w.description)}`);
  } else {
    out.push('- Welcome screen: not set up');
  }
  if (r.onboarding) {
    out.push(`- Onboarding: ${r.onboarding.enabled ? 'on' : 'off'}. ${r.onboarding.defaultChannels} default channels`);
    for (const p of r.onboarding.prompts) out.push(`  - "${cell(p.title)}": ${p.options.map(cell).join(', ')}`);
  } else {
    out.push('- Onboarding: not set up');
  }
  out.push('');

  out.push('## Roles');
  out.push('');
  out.push('| Role | Members | Powers | Shown separately | Mentionable |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const role of r.roles) {
    out.push(`| ${cell(role.name)} | ${role.members} | ${role.powers || '-'} | ${role.hoist ? 'yes' : 'no'} | ${role.mentionable ? 'yes' : 'no'} |`);
  }
  out.push('');

  out.push('## Channels');
  out.push('');
  out.push(`Messages are capped at ${r.cap} per channel, so a + means there were more.`);
  out.push('');
  out.push('| Category | Channel | Members see it | Members post | Slowmode | Messages | People | Staff share | Last message |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const c of r.channels) {
    if (c.skipped) {
      out.push(`| ${cell(c.category)} | #${cell(c.name)} | ${c.public ? 'yes' : 'no'} | - | - | not readable | - | - | - |`);
      continue;
    }
    out.push(`| ${cell(c.category)} | #${cell(c.name)}${c.type === 'announcement' ? ' (news)' : ''} | ${c.public ? 'yes' : 'no'} | ${c.canPost ? 'yes' : 'no'} | ${c.slowmode ? `${c.slowmode}s` : '-'} | ${c.count}${c.capped ? '+' : ''} | ${c.authors} | ${pct(Math.round(c.staffShare * 100), 100)} | ${ago(c.lastAt, now)} |`);
  }
  if (r.otherChannels.length) {
    out.push('');
    out.push(`Not read (voice, forum, stage): ${r.otherChannels.map((c) => `#${c}`).join(', ')}`);
  }
  out.push('');

  out.push('## What people are saying');
  out.push('');
  out.push('Public channels only, newest first.');
  for (const c of r.channels.filter((x) => x.public && !x.skipped && (x.questions.length || x.recent.length))) {
    out.push('');
    out.push(`### #${c.name}`);
    if (c.topic) out.push(`Topic: ${cell(c.topic)}`);
    out.push(`Busiest hours: ${busiestHours(c.hours) || '-'}`);
    if (c.questions.length) {
      out.push('');
      out.push('**Questions members asked:**');
      for (const q of c.questions) out.push(`- ${q}`);
    }
    if (c.recent.length) {
      out.push('');
      out.push('**Latest messages:**');
      for (const m of c.recent) out.push(`- ${m}`);
    }
  }
  out.push('');
  return out.join('\n');
}

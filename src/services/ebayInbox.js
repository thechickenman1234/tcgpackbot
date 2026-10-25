import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { getMeta, setMeta } from './metaService.js';
import { ebayAccount, ebayApi, hasExtras } from './ebayService.js';

/**
 * Everything on eBay that wants an answer, in one list: buyers' messages
 * (the last word was theirs), eBay's own notices about returns, cases and
 * cancellations, and the feedback buyers leave.
 *
 * A message waiting on us, a notice, and any feedback that isn't positive
 * each ping the staff role once; good feedback just shows on the dashboard.
 * Messages can be answered from the dashboard: the reply goes through
 * eBay's messages, the same as answering in eBay.
 *
 * The first look only fills the list, so connecting doesn't set off a
 * ping for every old message.
 */

const DAY = 86400000;
const PRIMED_KEY = 'ebay_inbox_primed';
const KEEP_DAYS = 60;
// eBay's notices worth a look; the rest (tips, promotions, sold notes) aren't.
const IMPORTANT = /return|case|refund|cancel|dispute|not received|didn.t arrive|item not as described|problem|claim|defect|restrict|suspend|limit|policy|action (is )?required|respond|overdue|late/i;

export const EBAY_MESSAGES_URL = 'https://www.ebay.com.au/mye/myebay/messages';
export const EBAY_FEEDBACK_URL = 'https://www.ebay.com.au/fdbk/feedback_profile/';

function save(item, now) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM ebay_inbox WHERE id = ?').get(item.id);
  if (existing) {
    db.prepare(`
      UPDATE ebay_inbox SET who = ?, title = ?, body = ?, item_id = ?, rating = ?, needs_reply = ?, unread = ?, at = ?, ref = ? WHERE id = ?
    `).run(item.who, item.title, item.body, item.itemId, item.rating, item.needsReply ? 1 : 0, item.unread || 0, item.at, item.ref, item.id);
  } else {
    db.prepare(`
      INSERT INTO ebay_inbox (id, kind, ref, who, title, body, item_id, rating, needs_reply, unread, at, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(item.id, item.kind, item.ref, item.who, item.title, item.body, item.itemId, item.rating, item.needsReply ? 1 : 0, item.unread || 0, item.at, now.toISOString());
  }
  return db.prepare('SELECT * FROM ebay_inbox WHERE id = ?').get(item.id);
}

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

async function ping(client, { title, description, color, role = true }) {
  if (!client) return;
  try {
    const channel = await client.channels.fetch(config.staffLogChannelId);
    if (!channel?.isTextBased()) return;
    const mention = role && config.staffRoleId ? config.staffRoleId : null;
    await channel.send({
      content: mention ? `<@&${mention}>` : undefined,
      embeds: [new EmbedBuilder().setTitle(title.slice(0, 256)).setDescription(description.slice(0, 4000)).setColor(color).setTimestamp()],
      allowedMentions: { roles: mention ? [mention] : [] },
    });
  } catch (err) {
    console.error('eBay inbox: could not post to the staff log:', err.message);
  }
}

/** Reads buyers' messages, eBay's notices and new feedback, and pings for anything that needs us. */
export async function syncInbox(client, { now = new Date() } = {}) {
  if (!hasExtras()) return { skipped: true };
  const me = String(ebayAccount()?.username || '').toLowerCase();
  const primed = Boolean(getMeta(PRIMED_KEY));
  const alerts = [];
  const db = getDb();
  const mark = (row, key) => db.prepare('UPDATE ebay_inbox SET alerted = ? WHERE id = ?').run(key, row.id);

  const members = await ebayApi('GET', '/commerce/message/v1/conversation', { query: { conversation_type: 'FROM_MEMBERS', limit: 50 } });
  for (const c of members.conversations || []) {
    if (/ARCHIVE|DELETE/i.test(c.conversationStatus || '')) continue;
    const last = c.latestMessage || {};
    const fromUs = Boolean(me) && String(last.senderUsername || '').toLowerCase() === me;
    const row = save({
      id: `msg:${c.conversationId}`,
      kind: 'message',
      ref: c.conversationId,
      who: fromUs ? last.recipientUsername : last.senderUsername,
      title: clip(c.conversationTitle || last.subject, 160),
      body: clip(last.messageBody, 600),
      itemId: c.referenceType === 'LISTING' ? c.referenceId : null,
      rating: null,
      needsReply: !fromUs,
      unread: c.unreadCount || 0,
      at: last.createdDate || c.createdDate || now.toISOString(),
    }, now);
    const key = last.messageId || row.at;
    if (row.needs_reply && row.alerted !== key) {
      mark(row, key);
      if (primed) alerts.push({ title: `💬 eBay message from ${row.who || 'a buyer'}`, description: `**${row.title || 'Message'}**\n> ${clip(row.body, 400)}\n\nAnswer it on the dashboard (eBay section) or in eBay.`, color: 0x2f6f4f });
    }
  }

  const notices = await ebayApi('GET', '/commerce/message/v1/conversation', { query: { conversation_type: 'FROM_EBAY', conversation_status: 'UNREAD', limit: 25 } })
    .catch(() => ({ conversations: [] }));
  for (const c of notices.conversations || []) {
    const last = c.latestMessage || {};
    const title = clip(c.conversationTitle || last.subject, 160);
    if (!IMPORTANT.test(`${title} ${last.subject || ''}`)) continue;
    const row = save({
      id: `notice:${c.conversationId}`,
      kind: 'notice',
      ref: c.conversationId,
      who: 'eBay',
      title,
      body: clip(last.messageBody, 600),
      itemId: c.referenceType === 'LISTING' ? c.referenceId : null,
      rating: null,
      needsReply: true,
      unread: c.unreadCount || 1,
      at: last.createdDate || c.createdDate || now.toISOString(),
    }, now);
    if (!row.alerted) {
      mark(row, 'sent');
      if (primed) alerts.push({ title: `📣 eBay: ${row.title}`, description: `${clip(row.body, 500)}\n\nOpen eBay messages to deal with it.`, color: 0xa15c00 });
    }
  }
  // Notices read in eBay drop out of the unread list: they're done.
  const unreadIds = new Set((notices.conversations || []).map((c) => `notice:${c.conversationId}`));
  for (const n of db.prepare("SELECT id FROM ebay_inbox WHERE kind = 'notice' AND needs_reply = 1").all()) {
    if (!unreadIds.has(n.id)) db.prepare('UPDATE ebay_inbox SET needs_reply = 0, unread = 0 WHERE id = ?').run(n.id);
  }

  if (me) {
    const fb = await ebayApi('GET', '/commerce/feedback/v1/feedback', {
      query: { user_id: ebayAccount().username, feedback_type: 'FEEDBACK_RECEIVED', filter: 'role:BUYER', sort: 'TIME', limit: 25 },
    });
    for (const f of fb.feedbackEntries || []) {
      const row = save({
        id: `fb:${f.feedbackId}`,
        kind: 'feedback',
        ref: f.orderLineItemSummary?.orderLineItemId || null,
        who: f.providerUserDetail?.userId || null,
        title: clip(f.orderLineItemSummary?.listingTitle, 160),
        body: clip(f.feedbackComment?.commentText, 600),
        itemId: f.orderLineItemSummary?.listingId || null,
        rating: f.commentType || null,
        needsReply: false,
        unread: 0,
        at: f.feedbackEnteredDate || now.toISOString(),
      }, now);
      if (!row.alerted) {
        mark(row, 'sent');
        const bad = row.rating && row.rating !== 'POSITIVE';
        if (primed) {
          alerts.push(bad
            ? { title: `🔴 ${row.rating === 'NEGATIVE' ? 'Negative' : 'Neutral'} eBay feedback from ${row.who || 'a buyer'}`, description: `> ${row.body || '(no comment)'}\n${row.title ? `For: ${row.title}\n` : ''}\nMessage them to sort it out. Once it's fixed, eBay lets you ask them to revise it (Seller Hub, Feedback).`, color: 0xc0392b }
            : { title: '⭐ New eBay feedback', description: `> ${row.body || 'Positive'}${row.who ? `\n${row.who}` : ''}`, color: 0x27ae60, role: false });
        }
      }
    }
  }

  db.prepare("DELETE FROM ebay_inbox WHERE at < ? AND needs_reply = 0 AND kind != 'feedback'").run(new Date(now.getTime() - KEEP_DAYS * DAY).toISOString());
  if (!primed) setMeta(PRIMED_KEY, now.toISOString());
  for (const a of alerts.slice(0, 10)) await ping(client, a);
  return { alerts: alerts.length };
}

/** A reply typed on the dashboard, sent into the buyer's conversation. */
export async function replyToMessage(id, text) {
  const row = getDb().prepare("SELECT * FROM ebay_inbox WHERE id = ? AND kind = 'message'").get(String(id));
  if (!row) return { error: 'That message is gone. Reload the page.' };
  const body = String(text || '').trim();
  if (!body) return { error: 'Type your reply.' };
  if (body.length > 2000) return { error: 'eBay takes up to 2,000 letters.' };
  await ebayApi('POST', '/commerce/message/v1/send_message', { body: { conversationId: row.ref, messageText: body } });
  getDb().prepare('UPDATE ebay_inbox SET needs_reply = 0, unread = 0 WHERE id = ?').run(row.id);
  return { ok: true, text: `Reply sent to ${row.who || 'the buyer'} on eBay.` };
}

/** Says a message needs no answer (a thanks, a "got it"). */
export function markHandled(id) {
  const r = getDb().prepare('UPDATE ebay_inbox SET needs_reply = 0, unread = 0 WHERE id = ?').run(String(id));
  return r.changes ? { ok: true, text: 'Taken off the list.' } : { error: 'That one is gone. Reload the page.' };
}

const ageHours = (iso, now) => Math.max(0, (now.getTime() - Date.parse(iso)) / 3600000);

/** The inbox as the dashboard shows it. */
export function inboxView({ now = new Date() } = {}) {
  const db = getDb();
  const waiting = db.prepare("SELECT * FROM ebay_inbox WHERE needs_reply = 1 ORDER BY at ASC").all().map((r) => ({
    id: r.id, kind: r.kind, who: r.who, title: r.title, body: r.body, itemId: r.item_id, at: r.at, hours: ageHours(r.at, now),
  }));
  const feedback = db.prepare("SELECT * FROM ebay_inbox WHERE kind = 'feedback' ORDER BY at DESC LIMIT 12").all().map((r) => ({
    id: r.id, who: r.who, title: r.title, body: r.body, rating: r.rating, at: r.at,
  }));
  const yearAgo = new Date(now.getTime() - 365 * DAY).toISOString();
  const counts = db.prepare("SELECT rating, COUNT(*) AS n FROM ebay_inbox WHERE kind = 'feedback' AND at >= ? GROUP BY rating").all(yearAgo);
  const by = Object.fromEntries(counts.map((c) => [c.rating, c.n]));
  return {
    messages: waiting.filter((w) => w.kind === 'message'),
    notices: waiting.filter((w) => w.kind === 'notice'),
    feedback,
    feedbackSeen: { positive: by.POSITIVE || 0, neutral: by.NEUTRAL || 0, negative: by.NEGATIVE || 0 },
    oldestHours: waiting.length ? Math.max(...waiting.map((w) => w.hours)) : null,
    newFeedback: feedback.filter((f) => now.getTime() - Date.parse(f.at) < DAY),
    messagesUrl: EBAY_MESSAGES_URL,
  };
}

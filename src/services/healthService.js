import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { getDb } from '../db/database.js';
import { getMeta, setMeta } from './metaService.js';
import { wiseStatus } from './wiseService.js';
import { checkChat, listPosts } from './zernioService.js';
import { openWholesaleOrders } from './wholesaleOrders.js';
import { ebayAccount, ebayKeys } from './ebayService.js';

/**
 * Is every part still working? The website forms went a month without
 * reaching Discord and nobody knew, so each part now leaves a mark when it
 * works or fails (noteOk / noteFail), Zernio is asked directly, and the
 * dashboard, the morning brief and the alarm all read the same report:
 *
 *   ok    working          warn  worth a look, no ping
 *   bad   broken: pinged once in the staff log, and again only if the
 *         problem changes; a note follows when it works again
 *   off   not set up yet, so not checked
 *
 * The bot can't report itself being down. A missing morning brief is the
 * sign of that.
 */

const KEY = 'health';
const ALERTS = 'health_alerts';
const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;
// Zernio is asked at most this often; the rest is read from the bot's own notes.
const LIVE_EVERY = HOUR;
// Wise syncs every 3 hours, so 12 without one means it has stopped.
const WISE_STALE = 12 * HOUR;
const RECENT = 7 * DAY;

// The name the site's forms function posts under when it can't reach the bot.
export const BACKUP_FORM_NAME = 'Website forms';

function load(key) {
  try {
    return JSON.parse(getMeta(key) || '{}');
  } catch {
    return {};
  }
}

export function noteOk(part, now = new Date()) {
  const all = load(KEY);
  all[part] = { ...all[part], okAt: now.toISOString() };
  setMeta(KEY, JSON.stringify(all));
}

export function noteFail(part, error, now = new Date()) {
  const all = load(KEY);
  all[part] = { ...all[part], failAt: now.toISOString(), error: String(error?.message || error || 'Failed').slice(0, 300) };
  setMeta(KEY, JSON.stringify(all));
}

const failing = (r) => Boolean(r?.failAt) && (!r.okAt || r.failAt > r.okAt);

/** A form posted by the backup webhook means the bot's own path failed. */
export function watchBackupForm(message) {
  if (!message.webhookId || message.author?.username !== BACKUP_FORM_NAME) return;
  const reason = String(message.content || '').match(/\(([^)]+)\)/)?.[1];
  noteFail('forms', `A form came through the backup path${reason ? `: ${reason}` : ''}`);
}

export function ago(iso, now = new Date()) {
  if (!iso) return 'never';
  const ms = now.getTime() - Date.parse(iso);
  if (ms < 2 * MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} minutes ago`;
  if (ms < 2 * DAY) return `${Math.floor(ms / HOUR)} hour${Math.floor(ms / HOUR) === 1 ? '' : 's'} ago`;
  return `${Math.floor(ms / DAY)} days ago`;
}

let live = { at: 0 };

async function liveChecks(now, fresh) {
  if (!fresh && live.at && now.getTime() - live.at < LIVE_EVERY) return live;
  const out = { at: now.getTime() };
  try {
    out.zernio = await checkChat(config.wholesaleSupplier);
  } catch (err) {
    out.zernio = { key: true, error: err.message, status: err.status || null };
  }
  try {
    const lists = await Promise.all([listPosts('failed'), listPosts('partial')]);
    out.posts = lists.flat();
  } catch (err) {
    out.postsError = err.message;
  }
  live = out;
  return live;
}

function failedScheduled(now) {
  const since = new Date(now.getTime() - RECENT).toISOString();
  const db = getDb();
  return [
    ...db.prepare("SELECT 'post' AS kind, id, last_error FROM scheduled_messages WHERE status = 'failed' AND send_at >= ?").all(since),
    ...db.prepare("SELECT 'sale' AS kind, id, last_error FROM scheduled_sales WHERE status = 'failed' AND start_at >= ?").all(since),
  ];
}

/** Every part, in the order the dashboard shows them. */
export async function healthReport({ now = new Date(), fresh = false } = {}) {
  const notes = load(KEY);
  const l = await liveChecks(now, fresh);
  const supplier = `@${config.wholesaleSupplier}`;
  const item = (key, name, status, text, fix = null, sig = status) => ({ key, name, status, text, fix, sig });
  const items = [];

  const forms = notes.forms;
  items.push(failing(forms)
    ? item('forms', 'Website forms', 'bad', forms.error,
      'The website couldn\'t hand a form to the bot, so it went through the backup. Check FORMS_SECRET is the same on Netlify and Railway (the site\'s SETUP.md, Part C), then redeploy the site.',
      'backup')
    : item('forms', 'Website forms', 'ok', forms?.okAt ? `Last form ${ago(forms.okAt, now)}` : 'No form since this check started'));

  const z = l.zernio;
  if (!z || !z.key) {
    items.push(item('zernio', 'Instagram DMs', 'off', 'Not set up (no ZERNIO_API_KEY on Railway)'));
  } else if (z.error) {
    const refused = z.status === 401 || z.status === 403;
    items.push(item('zernio', 'Instagram DMs', refused ? 'bad' : 'warn',
      refused ? `Zernio turned the key down: ${z.error}` : `Couldn't reach Zernio: ${z.error}`,
      refused ? 'Make a new key at zernio.com/dashboard/api-keys (leave messages on) and replace ZERNIO_API_KEY on Railway.' : 'Usually passes by itself. If it lasts a day, check zernio.com.',
      refused ? 'key' : 'warn'));
  } else if (!z.chat) {
    items.push(item('zernio', 'Instagram DMs', 'warn', `No chat with ${supplier} on @tcgpackbot yet`, `Message ${supplier} once from @tcgpackbot.`));
  } else if (!z.open && openWholesaleOrders().some((o) => o.status === 'new')) {
    items.push(item('zernio', 'Instagram DMs', 'warn', `${supplier} hasn't messaged in 24 hours, so the bot can't ask them for shipping`,
      `Message ${supplier} from @tcgpackbot. Once they reply, the bot can ask again.`));
  } else {
    items.push(item('zernio', 'Instagram DMs', 'ok', z.open ? `Key works, supplier chat open until ${new Date(z.canMessageUntil).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Key works'));
  }

  if (!z || !z.key) {
    items.push(item('posts', 'Instagram and TikTok posts', 'off', 'Not set up (no ZERNIO_API_KEY on Railway)'));
  } else if (l.postsError) {
    items.push(item('posts', 'Instagram and TikTok posts', 'warn', `Couldn't check: ${l.postsError}`));
  } else {
    const failed = (l.posts || []).filter((p) => !p.at || now.getTime() - Date.parse(p.at) < RECENT);
    if (failed.length) {
      const p = failed[0];
      const bad = p.platforms.find((x) => x.error || x.status === 'failed') || p.platforms[0];
      items.push(item('posts', 'Instagram and TikTok posts', 'bad',
        `${failed.length === 1 ? 'A post' : `${failed.length} posts`} didn't go up: "${p.caption}"${bad ? ` on ${bad.name}${bad.error ? `: ${bad.error}` : ''}` : ''}`,
        'Open it in Zernio and retry it, or ask Claude to.', failed.map((x) => x.id).sort().join(',')));
    } else {
      items.push(item('posts', 'Instagram and TikTok posts', 'ok', 'No failed posts this week'));
    }
  }

  const sheet = notes.sheet;
  if (!config.sheetUrl || !config.sheetSecret) items.push(item('sheet', 'Google Sheet sync', 'off', 'Not set up (no SHEET_URL)'));
  else if (failing(sheet)) {
    items.push(item('sheet', 'Google Sheet sync', 'bad', sheet.error,
      'Run /sync in Discord. If it fails again, the Google Sheet\'s script or SHEET_SECRET has changed.', 'sheet'));
  } else items.push(item('sheet', 'Google Sheet sync', 'ok', sheet?.okAt ? `Last synced ${ago(sheet.okAt, now)}` : 'No sync since this check started'));

  const labels = notes.labels;
  items.push(failing(labels)
    ? item('labels', 'Label tracking', 'warn', labels.error, 'Drop that label file again, or a clearer PDF of it.')
    : item('labels', 'Label tracking', 'ok', labels?.okAt ? `Last label read ${ago(labels.okAt, now)}` : 'No label files since this check started'));

  const wise = wiseStatus();
  if (!wise.connected) items.push(item('wise', 'Wise', 'off', 'Not connected yet (add WISE_API_TOKEN on Railway)'));
  else if (wise.last && (!wise.last.ok || wise.last.errors?.length)) {
    // A whole sync failing is broken; one half of it failing is worth a look.
    items.push(item('wise', 'Wise', wise.last.ok ? 'warn' : 'bad', `Sync ${wise.last.ok ? 'partly ' : ''}failed: ${(wise.last.errors || []).join('; ') || 'no reason given'}`,
      'Check the Wise token on Railway still works (Wise, Settings, API tokens).', 'sync'));
  } else if (!wise.syncedAt || now.getTime() - Date.parse(wise.syncedAt) > WISE_STALE) {
    items.push(item('wise', 'Wise', 'bad', `Hasn't synced since ${ago(wise.syncedAt, now)}`, 'Press Sync now on the dashboard. If nothing happens, the bot may need a restart on Railway.', 'stale'));
  } else items.push(item('wise', 'Wise', 'ok', `Synced ${ago(wise.syncedAt, now)}`));

  const eb = notes.ebay;
  const account = ebayAccount();
  if (!ebayKeys()) items.push(item('ebay', 'eBay', 'off', 'Not set up yet (the eBay keys go on Railway)'));
  else if (!account) items.push(item('ebay', 'eBay', 'warn', 'Keys are on, not connected yet', 'Press Connect eBay in the dashboard\'s eBay section.'));
  else if (account.broken) items.push(item('ebay', 'eBay', 'bad', account.broken, 'Press Connect eBay in the dashboard\'s eBay section and agree on eBay.', 'broken'));
  else if (failing(eb)) {
    // One failed run is usually eBay being busy; failing for 2 hours isn't.
    const long = !eb.okAt || now.getTime() - Date.parse(eb.okAt) > 2 * HOUR;
    items.push(item('ebay', 'eBay', long ? 'bad' : 'warn', `Sync failed: ${eb.error}`,
      long ? 'Press Sync now in the eBay section. If it fails again, the eBay keys or the connection have changed.' : 'Usually passes by itself.', 'sync'));
  } else items.push(item('ebay', 'eBay', 'ok', eb?.okAt ? `Synced ${ago(eb.okAt, now)}${account.username ? ` as ${account.username}` : ''}` : 'Connected, first sync on its way'));

  const missed = failedScheduled(now);
  items.push(missed.length
    ? item('scheduled', 'Queued sales and posts', 'bad',
      `${missed.length} didn't go out this week: ${missed[0].last_error || 'no reason given'}`,
      'Check it in Discord, then queue it again (Claude can).', missed.map((m) => `${m.kind}${m.id}`).join(','))
    : item('scheduled', 'Queued sales and posts', 'ok', 'Everything queued went out'));

  return items;
}

async function postToStaff(client, { title, description, color, ping }) {
  const channel = await client.channels.fetch(config.staffLogChannelId);
  if (!channel?.isTextBased()) return;
  const role = ping && config.staffRoleId ? config.staffRoleId : null;
  await channel.send({
    content: role ? `<@&${role}>` : undefined,
    embeds: [new EmbedBuilder().setTitle(title.slice(0, 256)).setDescription(description.slice(0, 4000)).setColor(color).setTimestamp()],
    allowedMentions: { roles: role ? [role] : [] },
  });
}

/**
 * Pings the staff log once when a part breaks, and says so when it works
 * again. The alert is stored before it's posted, so a restart never repeats it.
 */
export async function runHealthAlarms(client, now = new Date()) {
  const items = await healthReport({ now });
  const alerts = load(ALERTS);
  for (const it of items) {
    const was = alerts[it.key];
    if (it.status === 'bad' && (!was || was.sig !== it.sig)) {
      alerts[it.key] = { sig: it.sig, at: now.toISOString() };
      setMeta(ALERTS, JSON.stringify(alerts));
      await postToStaff(client, { title: `🔴 ${it.name} stopped working`, description: `${it.text}\n\n**Fix:** ${it.fix}`, color: 0xc0392b, ping: true });
    } else if (it.status !== 'bad' && was) {
      delete alerts[it.key];
      setMeta(ALERTS, JSON.stringify(alerts));
      await postToStaff(client, { title: `🟢 ${it.name} is working again`, description: it.text, color: 0x27ae60, ping: false });
    }
  }
  return items;
}

export function startHealthJob(client, intervalMs = 15 * MINUTE) {
  const tick = () => {
    runHealthAlarms(client).catch((err) => console.error('Health check failed:', err));
  };
  setTimeout(tick, 2 * MINUTE);
  return setInterval(tick, intervalMs);
}

import { config } from '../config.js';
import { connectUrl, deletionChallenge, ebayKeys, finishConnect, forgetEbayUser } from '../services/ebayService.js';
import { runEbaySync } from '../jobs/ebaySync.js';
import { logToStaff } from '../services/staffLog.js';
import { renderMessagePage } from '../dashboard/page.js';

/**
 * eBay's two doors into the bot, both public (eBay calls them, not a
 * signed-in phone):
 *
 *   GET  /ebay/callback          where eBay sends Lachy back after he agrees on
 *                                eBay (the RuName's accepted and declined URLs)
 *   GET  /ebay/account-deletion  eBay's check that we're listening: the answer
 *                                proves we hold EBAY_VERIFY_TOKEN
 *   POST /ebay/account-deletion  an eBay account closed: forget its details
 *
 * Returns true when it answered the request.
 */

const MAX_BODY = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('too big'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function page(res, status, message, link = { href: '/dash#ebay', text: 'Back to the dashboard' }) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
  res.end(renderMessagePage(message, link));
}

export async function handleEbayDoors(client, req, res, url) {
  const path = url.pathname.replace(/\/+$/, '');

  if (path === '/ebay/account-deletion') {
    if (req.method === 'GET') {
      const code = url.searchParams.get('challenge_code');
      const ready = Boolean(code && config.ebayVerifyToken);
      res.writeHead(ready ? 200 : code ? 503 : 400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(ready ? { challengeResponse: deletionChallenge(code) } : { ok: false }));
      return true;
    }
    if (req.method === 'POST') {
      let raw = '';
      try {
        raw = await readBody(req);
      } catch {
        res.writeHead(413);
        res.end();
        return true;
      }
      // Answered first: eBay sends it again until it hears back.
      res.writeHead(204);
      res.end();
      try {
        const note = JSON.parse(raw || '{}');
        if (note.metadata?.topic === 'MARKETPLACE_ACCOUNT_DELETION') {
          const username = note.notification?.data?.username;
          const r = forgetEbayUser(username);
          if (r.forgotten) console.log('eBay: forgot a closed account');
        }
      } catch (err) {
        console.error('eBay account deletion notice unreadable:', err.message);
      }
      return true;
    }
    return false;
  }

  if (req.method === 'GET' && path === '/ebay/callback') {
    if (!ebayKeys()) {
      page(res, 503, 'eBay isn\'t set up on the bot yet: the eBay keys need to go on Railway first.');
      return true;
    }
    let result;
    try {
      result = await finishConnect({
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        error: url.searchParams.get('error'),
      });
    } catch (err) {
      result = { error: `eBay said: ${err.message}` };
    }
    if (result.retryCore) {
      // eBay won't hand this app messages and feedback yet: connect without them.
      res.writeHead(303, { Location: connectUrl({ scopeSet: 'core' }), 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    if (result.error) {
      page(res, 400, result.error);
      return true;
    }
    page(res, 200, `eBay is connected${result.username ? ` as ${result.username}` : ''}. The bot is reading your listings and orders now: give it a minute, then open the eBay section.`);
    logToStaff(client, {
      title: 'eBay connected',
      description: `The bot is now linked to eBay${result.username ? ` as **${result.username}**` : ''}. Orders, stock, prices, messages and feedback show in the dashboard's eBay section.`,
      color: 0x2f6f4f,
    }).catch(() => {});
    runEbaySync(client, { full: true }).catch((err) => console.error('eBay first sync failed:', err));
    return true;
  }
  return false;
}

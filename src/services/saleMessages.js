import { config } from '../config.js';
import { formatAud } from '../utils/permissions.js';

/**
 * The two messages a claim sale night actually needs, written to match the
 * ones Lachy has been typing by hand.
 *
 * Prices come straight off the product, so they can never disagree with
 * what the bot will actually charge. That has been the real risk with
 * writing them out each time.
 *
 * Two names per product do different jobs:
 *   display_name  the long one people read, "Chinese Dreamscape Flourish
 *                 Vol 4 (Pika Box)"
 *   name          the short one they type, "pika box"
 *
 * When only one product is on, the short name is left out of the example
 * entirely, because "claim 2x" is all anyone needs to send.
 */

function longName(product) {
  return product.display_name?.trim() || product.name;
}

/**
 * The name of the sale itself.
 *
 * A sale is usually one thing in a couple of formats - a box and a case of
 * the same box - so listing every variant in the heading reads badly. The
 * first product's name with any bracketed aside removed is what Lachy has
 * been writing by hand, and `title` overrides it when that is wrong.
 */
export function saleTitle(products, override = null) {
  if (override?.trim()) return override.trim();
  return longName(products[0]).replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function priceBlock(product, bullet) {
  const unit = product.unit?.trim() || 'box';
  const lines = [`${bullet}**${formatAud(product.price_cents)}**/${unit} ('${product.name}')`];
  if (product.details?.trim()) {
    lines.push('', product.details.trim());
  }
  return lines.join('\n');
}

function shippingBlock(bullet) {
  return [
    '**Flat Shipping Fee:**',
    `${bullet}Standard **${formatAud(config.standardShippingCents)}**`,
    `${bullet}Express **${formatAud(config.expressShippingCents)}**`,
  ].join('\n');
}

/**
 * Goes in the announcements channel before the sale opens, so people know
 * the prices and can be ready at 8pm.
 */
export function buildSalePriceAnnouncement(products, { note = null, title = null } = {}) {
  const heading = saleTitle(products, title);

  const blocks = products.map((p) => [`**${longName(p)}:**`, priceBlock(p, '')].join('\n'));

  return [
    `**below are the official prices for our ${heading} Claim Sale Tonite at 8pm-Midnight!**`,
    '',
    blocks.join('\n\n'),
    '',
    shippingBlock(''),
    '',
    note ? `${note}\n` : null,
    'no limit tonite!!! @everyone',
  ].filter((line) => line !== null).join('\n');
}

/**
 * Goes in the claims channel at 8pm, the moment the sale opens.
 */
export function buildSaleLiveMessage(products, { note = null, title = null } = {}) {
  const heading = saleTitle(products, title);
  const single = products.length === 1;

  const blocks = products.map((p) => [`${longName(p)}:`, priceBlock(p, '• ')].join('\n'));

  // With one product on, the name is noise. With several, it is the only
  // way the bot can tell which one somebody meant.
  const howTo = single
    ? [
      '**How to Claim:** Type **claim** + how many.',
      '',
      `E.g. if you want 2, type: **"claim 2x"**`,
    ]
    : [
      '**How to Claim:** Type **claim** + how many + which item (the name in brackets above).',
      '',
      `E.g. **"claim 2x ${products[0].name}"**   (Works for ${products.map((p) => p.name).join(', ')})`,
    ];

  return [
    `**${heading} Claim Sale Now Live!**`,
    '',
    blocks.join('\n\n'),
    '',
    shippingBlock('• '),
    '',
    'No limit tn :))',
    '',
    ...howTo,
    '',
    '*Use separate messages for separate claims.*',
    '',
    '**8pm-Midnight tn**',
    note ? `\n${note}` : null,
    '',
    `**PAYMENT MUST BE MADE WITHIN ${config.paymentDeadlineHours} HOURS OR YOU WILL BE BANNED FROM FUTURE CLAIM SALES.**`,
    '@everyone',
  ].filter((line) => line !== null).join('\n');
}

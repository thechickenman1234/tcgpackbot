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

function titleCase(text) {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * "Chinese Dreamscape Flourish Vol 4 (Pika Box)".
 *
 * The bracket is the short name buyers type, added automatically rather
 * than typed into the long name, so the two can never drift apart. It is
 * left off when the long name already contains it, which stops things
 * reading "Chinese 30th Celebration Coin Set (Coin Set)".
 */
function longName(product, { showClaimName = false } = {}) {
  const display = product.display_name?.trim();
  if (!display) return titleCase(product.name);

  // With several products on, the bracket is the instruction: it is the
  // exact text somebody has to type to claim this one. So it goes on
  // every heading, in the exact casing it is stored, even where that
  // repeats the long name. Being unambiguous beats reading neatly.
  if (showClaimName) {
    return display.toLowerCase() === product.name.toLowerCase()
      ? display
      : `${display} (${product.name})`;
  }

  if (display.toLowerCase().includes(product.name.toLowerCase())) return display;
  if (/\([^)]*\)\s*$/.test(display)) return display;
  return `${display} (${titleCase(product.name)})`;
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
  // Naming one of four products in the heading just misleads people about
  // what is on. With several, the heading says nothing and the list below
  // does the work. Pass a title when the whole lot has a name.
  if (products.length > 1) return null;
  return longName(products[0]).replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Just the price. The short name buyers type is already in the bracket on
 * the line above, so repeating it here in quotes was saying the same thing
 * twice.
 */
function priceBlock(product, bullet) {
  const unit = product.unit?.trim() || 'box';
  const lines = [`${bullet}**${formatAud(product.price_cents)}**/${unit}`];
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


  const many = products.length > 1;
  const blocks = products.map(
    (p) => [`**${longName(p, { showClaimName: many })}:**`, priceBlock(p, '')].join('\n'),
  );

  return [
    `**below are the official prices for our ${heading ? `${heading} ` : ``}Claim Sale Tonite at 8pm-Midnight!**`,
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

  const blocks = products.map(
    (p) => [`${longName(p, { showClaimName: !single })}:`, priceBlock(p, '• ')].join('\n'),
  );

  // With one product on, the name is noise. With several, it is the only
  // way the bot can tell which one somebody meant.
  const howTo = single
    ? [
      '**How to Claim:** Type **claim** + how many.',
      '',
      `E.g. if you want 2, type: **"claim 2x"**`,
    ]
    : [
      // The list of names is spelled out below rather than pointing at
      // "the brackets above", because the bracket is left off whenever the
      // long name already contains the short one.
      '**How to Claim:** Type **claim** + how many + which item.',
      '',
      `E.g. **"claim 2x ${products[0].name}"**`,
      '',
      `Works for: ${products.map((p) => `**${p.name}**`).join(', ')}`,
    ];

  return [
    `**${heading ? `${heading} ` : ``}Claim Sale Now Live!**`,
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

import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name, fallback = '') {
  return process.env[name] ?? fallback;
}

export const config = {
  token: required('DISCORD_TOKEN'),
  clientId: required('DISCORD_CLIENT_ID'),
  guildId: required('DISCORD_GUILD_ID'),
  claimsChannelId: required('CLAIMS_CHANNEL_ID'),
  staffLogChannelId: required('STAFF_LOG_CHANNEL_ID'),
  appealsChannelId: optional('APPEALS_CHANNEL_ID'),
  // Where tonight's prices go before the sale opens.
  announceChannelId: optional('ANNOUNCE_CHANNEL_ID', ''),
  staffRoleId: required('STAFF_ROLE_ID'),
  bannedRoleId: optional('BANNED_ROLE_ID'),
  // Handed out automatically the first time someone is marked paid. The id
  // is optional: without it the role is found by name, so an existing
  // "Buyer" role works with nothing to configure.
  buyerRoleId: optional('BUYER_ROLE_ID', ''),
  buyerRoleName: optional('BUYER_ROLE_NAME', 'Buyer'),
  payId: required('PAYID'),
  paypalEmail: optional('PAYPAL_EMAIL', ''),
  paypalFeePercent: Number(optional('PAYPAL_FEE_PERCENT', '2.9')),
  paypalFeeFlatCents: Math.round(Number(optional('PAYPAL_FEE_FLAT', '0.30')) * 100),
  paymentDeadlineHours: Number(optional('PAYMENT_DEADLINE_HOURS', '24')),
  paymentReminderHoursBefore: Number(optional('PAYMENT_REMINDER_HOURS_BEFORE', '1')),
  archiveDaysAfterShipped: Number(optional('ARCHIVE_DAYS_AFTER_SHIPPED', '7')),
  databasePath: optional('DATABASE_PATH', './data/bot.sqlite'),
  standardShippingCents: Math.round(Number(optional('STANDARD_SHIPPING_FEE', '5')) * 100),
  expressShippingCents: Math.round(Number(optional('EXPRESS_SHIPPING_FEE', '10')) * 100),
  fromName: optional('FROM_NAME', 'TCG Pack Bot'),
  fromBusinessName: optional('FROM_BUSINESS_NAME', ''),
  fromStreet: required('FROM_STREET'),
  fromStreet2: optional('FROM_STREET2', ''),
  fromCity: required('FROM_CITY'),
  fromState: required('FROM_STATE'),
  fromPostcode: required('FROM_POSTCODE'),
  // Accounting spreadsheet bridge. Optional on purpose: if these are unset
  // the bot runs exactly as before and simply doesn't sync.
  sheetUrl: optional('SHEET_URL', ''),
  sheetSecret: optional('SHEET_SECRET', ''),
  // How long claims keep working after a sale ends, and what they cost.
  lateWindowHours: Number(optional('LATE_WINDOW_HOURS', '24')),
  lateMarkupPercent: Number(optional('LATE_MARKUP_PERCENT', '10')),
  // Spare stock on the order sheet, as a share of what was claimed (at least 1).
  orderSparePercent: Number(optional('ORDER_SPARE_PERCENT', '5')),
  // Claude's private door into the bot (src/ops). Off unless a secret is set.
  // Railway hands the service its port in PORT.
  opsSecret: optional('OPS_SECRET', ''),
  opsPort: Number(optional('PORT', '8080')),
  // The bot's own web address, for links to the dashboard. Railway sets
  // RAILWAY_PUBLIC_DOMAIN on a service that has a public domain.
  publicUrl: optional('PUBLIC_URL', process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://tcgpackbot-production.up.railway.app').replace(/\/+$/, ''),
  // What one Label Pro label costs, for the postage line in /profit.
  labelCostStandardCents: Math.round(Number(optional('LABEL_COST_STANDARD', '4')) * 100),
  labelCostExpressCents: Math.round(Number(optional('LABEL_COST_EXPRESS', '6.5')) * 100),
  // A read-only Wise API token, so the dashboard can list every payment in
  // and out of Wise for tagging. Off when unset. WISE_SINCE is how far back.
  wiseToken: optional('WISE_API_TOKEN', ''),
  wiseSince: optional('WISE_SINCE', '2026-07-01'),
  // Payments to or from this name are Lachy moving his own money: not business.
  wiseOwnName: optional('WISE_OWN_NAME', 'Lachlan Nguyen'),
  // For a payment Wise only gives in yen, the AUD it's roughly worth.
  jpyPerAud: Number(optional('JPY_PER_AUD', '110')),
  // Wholesale by Instagram DM, through Zernio (the same account that posts).
  // Without the API key the bot still prices and drafts; it just can't send.
  zernioApiKey: optional('ZERNIO_API_KEY', ''),
  zernioWebhookSecret: optional('ZERNIO_WEBHOOK_SECRET', ''),
  zernioInstagramId: optional('ZERNIO_INSTAGRAM_ID', '6ad61b4273c10b62f030b2b6'),
  // The supplier's Instagram, so their replies are read as shipping quotes.
  wholesaleSupplier: optional('WHOLESALE_SUPPLIER_IG', 'china_ptcg_shop').replace(/^@/, '').toLowerCase(),
  // Where order cards go. Empty: a channel with "wholesale" in its name, else the staff log.
  wholesaleChannelId: optional('WHOLESALE_CHANNEL_ID', ''),
  // The supplier price sheets the wholesale price page reads.
  wholesaleCsvJp: optional('WHOLESALE_CSV_JP', 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRVHKDH5tIqS5gTxghqDS2wKriMGiBpjQnpR6QJl4pPpnBqlT-1wZe29Xwg4Aru7BgpLpf38uWZnZ1p/pub?gid=605423645&single=true&output=csv'),
  wholesaleCsvCn: optional('WHOLESALE_CSV_CN', 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRVHKDH5tIqS5gTxghqDS2wKriMGiBpjQnpR6QJl4pPpnBqlT-1wZe29Xwg4Aru7BgpLpf38uWZnZ1p/pub?gid=226465806&single=true&output=csv'),
  // The website's forms reach the bot through its Netlify function, which signs with this.
  formsSecret: optional('FORMS_SECRET', ''),
  // Pages allowed to send orders to the bot from a browser. The site normally
  // goes through Netlify's proxy (/api/wholesale-order), so this is the fallback.
  siteOrigins: optional('SITE_ORIGINS', 'https://tcgpackbot.com,https://www.tcgpackbot.com')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // Where a shop opens its quote: Netlify passes tcgpackbot.com/q/... through to the bot.
  quoteBaseUrl: optional('QUOTE_BASE_URL', 'https://tcgpackbot.com').replace(/\/+$/, ''),
  // Supplier asks the bot sends by itself for website orders, per day; past this they wait for a tap.
  wholesaleAutoAsksPerDay: Number(optional('WHOLESALE_AUTO_ASKS_PER_DAY', '10')),
  // For a supplier shipping quote in yuan, the AUD it's roughly worth.
  cnyPerAud: Number(optional('CNY_PER_AUD', '4.7')),
  // Accounts whose orders are tests, never sales (Lachy's own), left out of /profit.
  profitExcludeBuyerIds: optional('PROFIT_EXCLUDE_BUYERS', '315063309550354434')
    .split(',').map((s) => s.trim()).filter(Boolean),
};

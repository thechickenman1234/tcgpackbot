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
  staffRoleId: required('STAFF_ROLE_ID'),
  bannedRoleId: optional('BANNED_ROLE_ID'),
  payId: required('PAYID'),
  paypalEmail: optional('PAYPAL_EMAIL', ''),
  paypalFeePercent: Number(optional('PAYPAL_FEE_PERCENT', '2.9')),
  paypalFeeFlatCents: Math.round(Number(optional('PAYPAL_FEE_FLAT', '0.30')) * 100),
  paymentDeadlineHours: Number(optional('PAYMENT_DEADLINE_HOURS', '24')),
  paymentReminderHoursBefore: Number(optional('PAYMENT_REMINDER_HOURS_BEFORE', '1')),
  archiveDaysAfterShipped: Number(optional('ARCHIVE_DAYS_AFTER_SHIPPED', '7')),
  databasePath: optional('DATABASE_PATH', './data/bot.sqlite'),
};

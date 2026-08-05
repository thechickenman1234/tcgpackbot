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
  paymentDeadlineHours: Number(optional('PAYMENT_DEADLINE_HOURS', '2')),
  archiveDaysAfterShipped: Number(optional('ARCHIVE_DAYS_AFTER_SHIPPED', '7')),
  databasePath: optional('DATABASE_PATH', './data/bot.sqlite'),
};

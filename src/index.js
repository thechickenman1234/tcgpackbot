import {
  Client,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import { config } from './config.js';
import { initDatabase } from './db/database.js';
import { handleClaimMessage } from './services/claimService.js';
import { handleInteractionCreate } from './handlers/interactionCreate.js';
import { handleAppealsChannelMessage } from './handlers/appealsChannel.js';
import { startPaymentDeadlineJob } from './jobs/paymentDeadline.js';
import { startAutoArchiveJob } from './jobs/autoArchive.js';
import { registerSlashCommands } from './registerCommands.js';
import {
  handleGuildMemberAdd,
  handleGuildMemberRemove,
  handleInviteCreate,
  handleInviteDelete,
  primeInviteCache,
} from './services/inviteTracker.js';
import { startGiveawayBoardJob } from './services/giveawayBoard.js';
import { startScheduledMessagesJob } from './jobs/scheduledMessages.js';
import { startScheduledSalesJob } from './jobs/scheduledSales.js';
import { reportBuyerRoleStatus } from './services/buyerRoleService.js';

initDatabase();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    // Needed to see invite use counts, which is the only way Discord lets
    // you work out who invited whom.
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.Channel],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Claims channel: ${config.claimsChannelId}`);
  console.log(`Payment deadline: ${config.paymentDeadlineHours}h`);
  console.log(`Payment reminder: ${config.paymentReminderHoursBefore}h before deadline`);
  console.log(`Archive after shipped: ${config.archiveDaysAfterShipped}d`);

  try {
    await registerSlashCommands();
  } catch (err) {
    console.error('Failed to auto-register slash commands:', err);
  }

  startPaymentDeadlineJob(client);
  startAutoArchiveJob(client);

  await primeInviteCache(client);
  startGiveawayBoardJob(client);
  startScheduledMessagesJob(client);
  startScheduledSalesJob(client);
  await reportBuyerRoleStatus(client);
});

client.on('inviteCreate', handleInviteCreate);
client.on('inviteDelete', handleInviteDelete);
client.on('guildMemberAdd', handleGuildMemberAdd);
client.on('guildMemberRemove', handleGuildMemberRemove);

client.on('messageCreate', async (message) => {
  try {
    await handleClaimMessage(message);
    await handleAppealsChannelMessage(message);
  } catch (err) {
    console.error('messageCreate error:', err);
  }
});

client.on('interactionCreate', handleInteractionCreate);

client.login(config.token);

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

initDatabase();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Claims channel: ${config.claimsChannelId}`);
  console.log(`Payment deadline: ${config.paymentDeadlineHours}h`);
  console.log(`Archive after shipped: ${config.archiveDaysAfterShipped}d`);

  startPaymentDeadlineJob(client);
  startAutoArchiveJob(client);
});

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

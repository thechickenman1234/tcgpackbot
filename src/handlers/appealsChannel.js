import { config } from '../config.js';
import { isBuyerBanned, recordAppeal } from '../services/buyerService.js';
import { logAppeal } from '../services/staffLog.js';

/**
 * Optional: messages in #appeals from banned users are treated as appeals.
 */
export async function handleAppealsChannelMessage(message) {
  if (!config.appealsChannelId) return;
  if (message.author.bot) return;
  if (message.channelId !== config.appealsChannelId) return;

  if (!isBuyerBanned(message.author.id)) {
    await message.reply('You are not currently banned from claiming. No appeal needed.');
    return;
  }

  const reason = message.content.trim();
  if (reason.length < 10) {
    await message.reply('Please write a short explanation (at least a sentence) for your appeal.');
    return;
  }

  recordAppeal(message.author.id, reason);
  await logAppeal(message.client, message.author.id, reason);
  await message.react('📩');
  await message.reply('Appeal logged for staff review. Unbans are always a manual staff decision.');
}

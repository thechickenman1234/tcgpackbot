import { config } from '../config.js';

/**
 * Gives someone the buyer role the moment their order is marked paid.
 *
 * Deliberately best effort and silent on failure. A role is a nice-to-have;
 * an order being marked paid is not, and a missing permission or a buyer
 * who has left the server must never be the reason a payment fails to
 * register.
 *
 * Needs BUYER_ROLE_ID set, the bot to hold Manage Roles, and the bot's own
 * role to sit ABOVE the buyer role in the server's role list. Discord will
 * not let a bot hand out a role that outranks it.
 */
export async function grantBuyerRole(client, discordId) {
  if (!config.buyerRoleId || !discordId) return false;
  // Orders logged for someone who is not on Discord carry a synthetic id.
  if (discordId.startsWith('ext:')) return false;

  try {
    const guild = await client.guilds.fetch(config.guildId);
    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) return false;
    if (member.roles.cache.has(config.buyerRoleId)) return false;

    await member.roles.add(config.buyerRoleId, 'Marked as paid');
    console.log(`Buyer role given to ${member.user.tag}`);
    return true;
  } catch (err) {
    console.error(`Could not give the buyer role to ${discordId}: ${err.message}`);
    return false;
  }
}

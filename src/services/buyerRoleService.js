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
/**
 * Finds the buyer role. BUYER_ROLE_ID wins if it is set; otherwise the
 * role is looked up by name, so an existing "Buyer" role just works with
 * nothing to configure.
 */
export function resolveBuyerRole(guild) {
  if (config.buyerRoleId) {
    return guild.roles.cache.get(config.buyerRoleId) || null;
  }
  const wanted = config.buyerRoleName.trim().toLowerCase();
  return guild.roles.cache.find((r) => r.name.trim().toLowerCase() === wanted) || null;
}

export async function grantBuyerRole(client, discordId) {
  if (!discordId) return false;
  // Orders logged for someone who is not on Discord carry a synthetic id.
  if (discordId.startsWith('ext:')) return false;

  try {
    const guild = await client.guilds.fetch(config.guildId);
    const role = resolveBuyerRole(guild);
    if (!role) {
      console.warn(`No buyer role found — looked for "${config.buyerRoleName}". Set BUYER_ROLE_ID to be explicit.`);
      return false;
    }

    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) return false;
    if (member.roles.cache.has(role.id)) return false;

    // Discord refuses outright if the bot's own role is not above this one,
    // so say which problem it is rather than failing with a bare 50013.
    if (role.position >= guild.members.me.roles.highest.position) {
      console.error(
        `Cannot grant "${role.name}" — the bot's role sits below it. `
        + "Drag the bot's role above it in Server Settings → Roles.",
      );
      return false;
    }

    await member.roles.add(role.id, 'Marked as paid');
    console.log(`Buyer role given to ${member.user.tag}`);
    return true;
  } catch (err) {
    console.error(`Could not give the buyer role to ${discordId}: ${err.message}`);
    return false;
  }
}

/** Logged once on boot so a misconfiguration is obvious before a sale. */
export async function reportBuyerRoleStatus(client) {
  try {
    const guild = await client.guilds.fetch(config.guildId);
    await guild.roles.fetch();
    const role = resolveBuyerRole(guild);

    if (!role) {
      console.warn(`Buyer role: NOT FOUND (looked for "${config.buyerRoleName}"). Nobody will be given a role.`);
      return;
    }
    const me = guild.members.me;
    if (!me?.permissions.has('ManageRoles')) {
      console.warn(`Buyer role: found "${role.name}" but the bot is missing Manage Roles.`);
      return;
    }
    if (role.position >= me.roles.highest.position) {
      console.warn(`Buyer role: found "${role.name}" but the bot's role is below it — drag the bot above it.`);
      return;
    }
    console.log(`Buyer role ready: "${role.name}"`);
  } catch (err) {
    console.error('Could not check the buyer role:', err.message);
  }
}

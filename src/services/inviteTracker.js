import { getRunningGiveaway, markInviteeLeft, recordInvite } from './giveawayService.js';

/**
 * Works out who invited whom.
 *
 * Discord never tells you which invite somebody used. The only way to know
 * is to hold a copy of every invite's use count, and when a member joins,
 * fetch them all again and find the one that went up by one.
 *
 * That means the cache has to be right or the credit goes to the wrong
 * person, so it is refreshed on boot, on every invite created or deleted,
 * and again after every single join.
 *
 * Cases that deliberately credit nobody:
 *   - the server's vanity URL, which has no inviter
 *   - bots joining
 *   - a join where two invites moved at once and there is no way to tell
 *   - accounts younger than the giveaway's minimum age
 *
 * Crediting nobody is always better than crediting the wrong person.
 */

// guildId -> Map(inviteCode -> uses)
const cache = new Map();

function snapshot(invites) {
  const counts = new Map();
  for (const invite of invites.values()) {
    counts.set(invite.code, invite.uses ?? 0);
  }
  return counts;
}

async function fetchInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    return snapshot(invites);
  } catch (err) {
    // Almost always a missing Manage Server permission.
    console.error(`Could not read invites for ${guild.id}: ${err.message}`);
    return null;
  }
}

/** Called once the bot is ready, and any time the cache needs rebuilding. */
export async function primeInviteCache(client) {
  for (const guild of client.guilds.cache.values()) {
    const counts = await fetchInvites(guild);
    if (counts) {
      cache.set(guild.id, counts);
      console.log(`Invite cache primed for ${guild.name}: ${counts.size} invites`);
    } else {
      console.warn(`Invite tracking is OFF for ${guild.name} — the bot needs Manage Server.`);
    }
  }
}

export function handleInviteCreate(invite) {
  const counts = cache.get(invite.guild?.id);
  if (counts) counts.set(invite.code, invite.uses ?? 0);
}

export function handleInviteDelete(invite) {
  const counts = cache.get(invite.guild?.id);
  if (counts) counts.delete(invite.code);
}

/**
 * Compares the invite counts before and after a join to find the code that
 * was used. Returns null whenever the answer is not certain.
 */
function findUsedCode(before, after) {
  if (!before) return null;

  const grown = [];
  for (const [code, uses] of after.entries()) {
    const previous = before.get(code);
    if (previous === undefined) {
      // An invite we have never seen. It could be a one-use link created
      // and consumed between refreshes, but it could equally be one made
      // moments ago by someone else, so it is not safe to credit.
      continue;
    }
    if (uses > previous) grown.push(code);
  }

  // Exactly one invite moved: that is the one. Two at once means two people
  // joined in the same instant and there is no way to say which is which.
  return grown.length === 1 ? grown[0] : null;
}

export async function handleGuildMemberAdd(member) {
  try {
    const guild = member.guild;
    const before = cache.get(guild.id);
    const after = await fetchInvites(guild);
    if (after) cache.set(guild.id, after);

    if (member.user.bot) return;

    const giveaway = getRunningGiveaway();
    if (!giveaway) return;

    const endsAt = new Date(giveaway.ends_at).getTime();
    if (Number.isFinite(endsAt) && Date.now() > endsAt) return;

    const ageDays = (Date.now() - member.user.createdTimestamp) / 86400000;
    if (ageDays < giveaway.min_account_age_days) {
      console.log(
        `Giveaway: ignored ${member.user.tag} — account is ${ageDays.toFixed(1)} days old, `
        + `minimum is ${giveaway.min_account_age_days}.`,
      );
      return;
    }

    const code = findUsedCode(before, after);
    if (!code) {
      console.log(`Giveaway: could not tell which invite ${member.user.tag} used — nobody credited.`);
      return;
    }

    let inviterId = null;
    try {
      const invites = await guild.invites.fetch();
      inviterId = invites.get(code)?.inviter?.id ?? null;
    } catch {
      inviterId = null;
    }
    if (!inviterId) {
      console.log(`Giveaway: invite ${code} has no inviter (vanity or expired) — nobody credited.`);
      return;
    }

    const result = recordInvite({
      giveawayId: giveaway.id,
      inviterId,
      inviteeId: member.id,
      inviteCode: code,
    });

    if (result.ok) {
      console.log(
        `Giveaway: ${member.user.tag} ${result.restored ? 'rejoined' : 'joined'} `
        + `via ${code}, credited to ${inviterId}.`,
      );
    } else {
      console.log(`Giveaway: ${member.user.tag} did not count — ${result.reason}.`);
    }
  } catch (err) {
    // A giveaway must never be the reason somebody cannot join the server.
    console.error('Giveaway invite tracking failed on join:', err);
  }
}

export async function handleGuildMemberRemove(member) {
  try {
    const giveaway = getRunningGiveaway();
    if (!giveaway) return;
    if (markInviteeLeft(giveaway.id, member.id)) {
      console.log(`Giveaway: ${member.user?.tag || member.id} left — their entry no longer counts.`);
    }
  } catch (err) {
    console.error('Giveaway invite tracking failed on leave:', err);
  }
}

import { AttachmentBuilder, ChannelType, PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { isStaff } from '../utils/permissions.js';
import { buildAuditMarkdown, buyerStats, pseudonymizer, summarizeChannel } from '../services/auditService.js';

/**
 * /audit: a read-only report on the server, sent only to the staff member who
 * asked. It reads channels, roles, members and recent messages, and never
 * posts, edits or deletes anything. Threads, which are the claim tickets, are
 * never opened. See auditService for what is hidden and why.
 */

/** Enough to see what a channel is like without pulling its whole history. */
const PER_CHANNEL_CAP = 400;
const DAY_MS = 86400000;

/** Newest first, stopping at the window or the cap, whichever comes first. */
async function fetchRecent(channel, sinceMs, cap) {
  const out = [];
  let before;
  while (out.length < cap) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    for (const message of batch.values()) {
      if (message.createdTimestamp < sinceMs || out.length >= cap) return out;
      out.push(message);
    }
    if (batch.size < 100) break;
    before = batch.last().id;
  }
  return out;
}

function powersOf(role) {
  const p = role.permissions;
  if (p.has(PermissionFlagsBits.Administrator)) return 'admin';
  return [
    [PermissionFlagsBits.ManageGuild, 'manage server'],
    [PermissionFlagsBits.ManageChannels, 'manage channels'],
    [PermissionFlagsBits.ManageMessages, 'manage messages'],
    [PermissionFlagsBits.BanMembers, 'ban'],
  ].filter(([flag]) => p.has(flag)).map(([, label]) => label).join(', ');
}

async function readOnboarding(guild) {
  try {
    const ob = await guild.fetchOnboarding();
    return {
      enabled: Boolean(ob.enabled),
      defaultChannels: ob.defaultChannels?.size ?? 0,
      prompts: [...(ob.prompts?.values() ?? [])].map((p) => ({
        title: p.title,
        options: [...(p.options?.values() ?? [])].map((o) => o.title),
      })),
    };
  } catch {
    return null; // not a community server, or onboarding never set up
  }
}

async function readWelcomeScreen(guild) {
  try {
    const ws = await guild.fetchWelcomeScreen();
    return {
      description: ws.description || '',
      channels: [...(ws.welcomeChannels?.values() ?? [])].map((w) => ({
        name: w.channel?.name ?? 'unknown',
        description: w.description || '',
      })),
    };
  } catch {
    return null;
  }
}

export async function handleAuditCommand(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const days = interaction.options.getInteger('days') ?? 30;
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild;
  const now = new Date();
  const sinceMs = now.getTime() - days * DAY_MS;

  const [channels, roles, members] = await Promise.all([
    guild.channels.fetch(),
    guild.roles.fetch(),
    guild.members.fetch(),
  ]);
  const [welcome, onboarding] = await Promise.all([readWelcomeScreen(guild), readOnboarding(guild)]);

  const everyone = guild.roles.everyone;
  const me = guild.members.me;
  const staffIds = new Set(members.filter((m) => isStaff(m)).map((m) => m.id));
  const pseudo = pseudonymizer();
  const posters = new Set();
  const hoursAll = Array(24).fill(0);
  const report = [];
  const otherChannels = [];

  const textTypes = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
  const ordered = [...channels.values()]
    .filter(Boolean)
    .sort((a, b) => (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition);

  for (const ch of ordered) {
    if (ch.type === ChannelType.GuildCategory) continue;
    if (!textTypes.has(ch.type)) {
      otherChannels.push(ch.name);
      continue;
    }
    const base = {
      name: ch.name,
      category: ch.parent?.name ?? 'No category',
      type: ch.type === ChannelType.GuildAnnouncement ? 'announcement' : 'text',
      topic: ch.topic || '',
      slowmode: ch.rateLimitPerUser || 0,
      public: Boolean(ch.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel)),
      canPost: Boolean(ch.permissionsFor(everyone)?.has(PermissionFlagsBits.SendMessages)),
    };
    const mine = ch.permissionsFor(me);
    if (!mine?.has(PermissionFlagsBits.ViewChannel) || !mine?.has(PermissionFlagsBits.ReadMessageHistory)) {
      report.push({ ...base, skipped: true });
      continue;
    }

    let raw = [];
    try {
      raw = await fetchRecent(ch, sinceMs, PER_CHANNEL_CAP);
    } catch (err) {
      console.error(`Audit could not read #${ch.name}:`, err.message);
      report.push({ ...base, skipped: true });
      continue;
    }
    const msgs = raw.map((m) => ({
      authorId: m.author.id,
      isBot: m.author.bot,
      isStaff: staffIds.has(m.author.id),
      createdAt: m.createdAt,
      content: m.content,
    }));
    for (const m of msgs) if (!m.isBot) posters.add(m.authorId);
    // Text only from channels every member can already see.
    const summary = summarizeChannel(msgs, { includeText: base.public, pseudo });
    summary.hours.forEach((n, h) => { hoursAll[h] += n; });
    report.push({ ...base, ...summary, capped: raw.length >= PER_CHANNEL_CAP });
  }

  const humans = members.filter((m) => !m.user.bot);
  const joinedWithin = (d) => humans.filter((m) => m.joinedTimestamp >= now.getTime() - d * DAY_MS).size;
  const buyerRole = config.buyerRoleId
    ? roles.get(config.buyerRoleId)
    : roles.find((r) => r.name.toLowerCase() === config.buyerRoleName.toLowerCase());

  const md = buildAuditMarkdown({
    now,
    days,
    cap: PER_CHANNEL_CAP,
    guildName: guild.name,
    humans: humans.size,
    bots: members.size - humans.size,
    joined: { 7: joinedWithin(7), 30: joinedWithin(30), 90: joinedWithin(90) },
    posters: posters.size,
    buyerRoleName: buyerRole?.name ?? null,
    buyerRoleCount: buyerRole?.members.size ?? 0,
    stats: buyerStats(new Date(sinceMs).toISOString()),
    hoursAll,
    setup: {
      verification: guild.verificationLevel,
      boosts: guild.premiumSubscriptionCount ?? 0,
      tier: guild.premiumTier ?? 0,
      rules: guild.rulesChannel?.name ? `#${guild.rulesChannel.name}` : null,
      system: guild.systemChannel?.name ? `#${guild.systemChannel.name}` : null,
      features: guild.features ?? [],
    },
    welcome,
    onboarding,
    roles: [...roles.values()]
      .filter((r) => r.id !== everyone.id && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ name: r.name, members: r.members.size, powers: powersOf(r), hoist: r.hoist, mentionable: r.mentionable })),
    channels: report,
    otherChannels,
  });

  const stamp = now.toISOString().slice(0, 10);
  await interaction.editReply({
    content: `Here's the server audit for the last ${days} days. Nothing was posted or changed. Drop the file into Claude to go through it.`,
    files: [new AttachmentBuilder(Buffer.from(md, 'utf8'), { name: `server-audit-${stamp}.md` })],
  });
}

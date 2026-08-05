import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { formatAud, isStaff } from '../utils/permissions.js';
import { buildClaimSelectRow } from '../handlers/claimUi.js';
import {
  createProduct,
  findActiveProductByName,
  listActiveProducts,
  listAllProducts,
  setProductActive,
  setProductPrice,
  updateProductStock,
} from '../services/productService.js';
import {
  getOrderByReference,
  getOrderByThreadId,
  markPaid,
  markShipped,
} from '../services/orderService.js';
import {
  getBanHistory,
  isBuyerBanned,
  recordAppeal,
  recordAppealOutcome,
  setBanned,
} from '../services/buyerService.js';
import { logAppeal, logBan, logUnban } from '../services/staffLog.js';

function dollarsToCents(price) {
  return Math.round(Number(price) * 100);
}

async function applyBannedRole(guild, userId, add) {
  if (!config.bannedRoleId) return;
  try {
    const member = await guild.members.fetch(userId);
    if (add) await member.roles.add(config.bannedRoleId);
    else await member.roles.remove(config.bannedRoleId);
  } catch (err) {
    console.error('Banned role update failed:', err.message);
  }
}

function resolveOrderFromInteraction(interaction) {
  const ref = interaction.options.getString('reference');
  if (ref) return getOrderByReference(ref.trim().toUpperCase());
  if (interaction.channel?.isThread()) return getOrderByThreadId(interaction.channelId);
  return null;
}

async function handleProduct(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const name = interaction.options.getString('name', true).trim();
    const price = interaction.options.getNumber('price', true);
    const quantity = interaction.options.getInteger('quantity', true);
    const saleWindow = interaction.options.getString('sale_window');

    if (price <= 0) {
      await interaction.reply({ content: 'Price must be > 0.', ephemeral: true });
      return;
    }

    try {
      const product = createProduct({
        name,
        priceCents: dollarsToCents(price),
        quantity,
        saleWindow,
      });
      await interaction.reply({
        content: `Added **${product.name}** — ${formatAud(product.price_cents)} × ${product.quantity_available} available.`,
        ephemeral: true,
      });
    } catch (err) {
      await interaction.reply({ content: `Could not add product (name may already exist): ${err.message}`, ephemeral: true });
    }
    return;
  }

  if (sub === 'stock') {
    const name = interaction.options.getString('name', true);
    const quantity = interaction.options.getInteger('quantity', true);
    const product = findActiveProductByName(name) ?? listAllProducts().find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!product) {
      await interaction.reply({ content: 'Product not found.', ephemeral: true });
      return;
    }
    updateProductStock(product.id, quantity);
    await interaction.reply({ content: `Stock for **${product.name}** set to **${quantity}**.`, ephemeral: true });
    return;
  }

  if (sub === 'price') {
    const name = interaction.options.getString('name', true);
    const price = interaction.options.getNumber('price', true);
    const product = findActiveProductByName(name) ?? listAllProducts().find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!product) {
      await interaction.reply({ content: 'Product not found.', ephemeral: true });
      return;
    }
    setProductPrice(product.id, dollarsToCents(price));
    await interaction.reply({ content: `Price for **${product.name}** set to **${formatAud(dollarsToCents(price))}**.`, ephemeral: true });
    return;
  }

  if (sub === 'deactivate') {
    const name = interaction.options.getString('name', true);
    const product = findActiveProductByName(name);
    if (!product) {
      await interaction.reply({ content: 'Active product not found.', ephemeral: true });
      return;
    }
    setProductActive(product.id, false);
    await interaction.reply({ content: `Deactivated **${product.name}**.`, ephemeral: true });
    return;
  }

  if (sub === 'list') {
    const products = listAllProducts();
    if (!products.length) {
      await interaction.reply({ content: 'No products yet.', ephemeral: true });
      return;
    }
    const lines = products.map((p) => {
      const flag = p.active ? '🟢' : '⚫';
      return `${flag} **${p.name}** — ${formatAud(p.price_cents)} · qty ${p.quantity_available}${p.sale_window ? ` · ${p.sale_window}` : ''}`;
    });
    await interaction.reply({ content: lines.join('\n').slice(0, 1900), ephemeral: true });
  }
}

async function handleStockpost(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  if (interaction.channelId !== config.claimsChannelId) {
    await interaction.reply({
      content: `Post stock in the claims channel (<#${config.claimsChannelId}>) so the claim dropdown works.`,
      ephemeral: true,
    });
    return;
  }

  const products = listActiveProducts();
  if (!products.length) {
    await interaction.reply({ content: 'No active products. Add some with `/product add`.', ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('TCG Pack Bot — Claim Sale')
    .setColor(0xe67e22)
    .setDescription(
      [
        '**How to claim**',
        '1. Use the dropdown below to pick a product',
        '2. Enter quantity (and shipping details if it\'s your first claim)',
        '3. You\'ll get a **private ticket** with PayID payment details',
        '',
        'Payment deadline applies once your claim is locked — pay and post a screenshot in your ticket.',
      ].join('\n'),
    )
    .addFields(
      products.map((p) => ({
        name: p.name,
        value: [
          `Price: **${formatAud(p.price_cents)}**`,
          `Available: **${p.quantity_available}**`,
          p.sale_window ? `Window: ${p.sale_window}` : null,
        ].filter(Boolean).join('\n'),
        inline: true,
      })),
    )
    .setFooter({ text: 'Payment via PayID · confirmed manually by staff' });

  const selectRow = buildClaimSelectRow(products);
  await interaction.reply({
    embeds: [embed],
    components: selectRow ? [selectRow] : [],
  });
}

async function handlePaid(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const order = resolveOrderFromInteraction(interaction);
  if (!order) {
    await interaction.reply({ content: 'Order not found. Run this inside the ticket thread or pass `reference`.', ephemeral: true });
    return;
  }

  const result = markPaid(order.id);
  if (!result.ok) {
    await interaction.reply({ content: `Cannot mark paid (status: \`${order.status}\`).`, ephemeral: true });
    return;
  }

  await interaction.reply({
    content: `✅ Marked **${order.reference_code}** as **paid** (${formatAud(order.total_cents)}).`,
  });
}

async function handleShipped(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const order = resolveOrderFromInteraction(interaction);
  if (!order) {
    await interaction.reply({ content: 'Order not found. Run this inside the ticket thread or pass `reference`.', ephemeral: true });
    return;
  }

  const result = markShipped(order.id);
  if (!result.ok) {
    await interaction.reply({
      content: `Cannot mark shipped (status: \`${order.status}\`). Order must be paid first.`,
      ephemeral: true,
    });
    return;
  }

  const archiveUnix = Math.floor(new Date(result.order.archive_at).getTime() / 1000);
  await interaction.reply({
    content: `📦 Marked **${order.reference_code}** as **shipped**. Thread will auto-archive <t:${archiveUnix}:R>.`,
  });
}

async function handleBan(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const user = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason', true);

  setBanned(user.id, true, reason, interaction.user.id);
  await applyBannedRole(interaction.guild, user.id, true);
  await logBan(interaction.client, user.id, reason, interaction.user.id);

  await interaction.reply({ content: `Banned <@${user.id}> from claims. Reason: ${reason}`, ephemeral: true });
}

async function handleUnban(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const user = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason') || 'Manual staff unban';

  if (!isBuyerBanned(user.id)) {
    await interaction.reply({ content: 'That user is not currently banned.', ephemeral: true });
    return;
  }

  setBanned(user.id, false, reason, interaction.user.id);
  recordAppealOutcome(user.id, true, interaction.user.id, reason);
  await applyBannedRole(interaction.guild, user.id, false);
  await logUnban(interaction.client, user.id, reason, interaction.user.id);

  await interaction.reply({ content: `Unbanned <@${user.id}>. Reason: ${reason}`, ephemeral: true });

  try {
    await user.send(`Your claim ban on **TCG Pack Bot** has been lifted. Reason: ${reason}`);
  } catch {
    // DMs closed
  }
}

async function handleAppeal(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'submit') {
    if (!isBuyerBanned(interaction.user.id)) {
      await interaction.reply({ content: 'You are not currently banned from claiming.', ephemeral: true });
      return;
    }

    const reason = interaction.options.getString('reason', true);
    recordAppeal(interaction.user.id, reason);
    await logAppeal(interaction.client, interaction.user.id, reason);

    await interaction.reply({
      content: 'Appeal submitted. Staff will review manually — unbans are never automatic.',
      ephemeral: true,
    });
    return;
  }

  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  if (sub === 'reject') {
    const user = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason') || 'Appeal rejected';
    recordAppealOutcome(user.id, false, interaction.user.id, reason);
    await interaction.reply({ content: `Appeal for <@${user.id}> rejected. Ban remains.`, ephemeral: true });
    try {
      await user.send(`Your claim-ban appeal was rejected. ${reason}`);
    } catch {
      // ignore
    }
    return;
  }

  if (sub === 'history') {
    const user = interaction.options.getUser('user', true);
    const history = getBanHistory(user.id);
    if (!history.length) {
      await interaction.reply({ content: 'No ban history.', ephemeral: true });
      return;
    }
    const lines = history.slice(0, 15).map((h) => {
      const when = `<t:${Math.floor(new Date(h.created_at).getTime() / 1000)}:d>`;
      return `${when} · **${h.action}** — ${h.reason || '—'}${h.staff_id ? ` (by <@${h.staff_id}>)` : ''}`;
    });
    await interaction.reply({ content: lines.join('\n').slice(0, 1900), ephemeral: true });
  }
}

async function handleOrder(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const ref = interaction.options.getString('reference', true).trim().toUpperCase();
  const order = getOrderByReference(ref);
  if (!order) {
    await interaction.reply({ content: 'Order not found.', ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`Order ${order.reference_code}`)
    .setColor(0x3498db)
    .addFields(
      { name: 'Status', value: order.status, inline: true },
      { name: 'Buyer', value: `<@${order.buyer_id}>`, inline: true },
      { name: 'Items', value: `${order.quantity}x ${order.product_name}`, inline: false },
      { name: 'Total', value: formatAud(order.total_cents), inline: true },
      { name: 'Thread', value: order.thread_id ? `<#${order.thread_id}>` : '—', inline: true },
      { name: 'Claimed', value: `<t:${Math.floor(new Date(order.claimed_at).getTime() / 1000)}:f>`, inline: true },
      { name: 'Deadline', value: `<t:${Math.floor(new Date(order.payment_deadline_at).getTime() / 1000)}:f>`, inline: true },
    );

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleSlashCommand(interaction) {
  switch (interaction.commandName) {
    case 'product':
      return handleProduct(interaction);
    case 'stockpost':
      return handleStockpost(interaction);
    case 'paid':
      return handlePaid(interaction);
    case 'shipped':
      return handleShipped(interaction);
    case 'ban':
      return handleBan(interaction);
    case 'unban':
      return handleUnban(interaction);
    case 'appeal':
      return handleAppeal(interaction);
    case 'order':
      return handleOrder(interaction);
    default:
      await interaction.reply({ content: 'Unknown command.', ephemeral: true });
  }
}

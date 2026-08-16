import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { formatAud, isStaff } from '../utils/permissions.js';
import { buildLabelExportCsv } from '../services/labelExportService.js';
import {
  clearProductTiers,
  createProduct,
  findActiveProductByName,
  findProductByName,
  formatTiersForDisplay,
  getProductMaxPerBuyer,
  getProductTiers,
  listActiveProducts,
  listAllProducts,
  parseTiersInput,
  setProductActive,
  setProductMaxPerBuyer,
  setProductPrice,
  setProductShipping,
  setProductTiers,
  updateProductStock,
} from '../services/productService.js';
import { endClaimSale, announceSaleStart } from '../services/saleAnnouncements.js';
import {
  cancelOrder,
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
import {
  buildStockpostPayload,
  rememberStockpost,
  refreshStockpost,
} from '../services/stockpostService.js';
import { handleShippingCommand } from '../handlers/shippingUi.js';

function dollarsToCents(price) {
  return Math.round(Number(price) * 100);
}

function resolveProductByName(name) {
  return findActiveProductByName(name) ?? findProductByName(name);
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
    const shipping = interaction.options.getNumber('shipping') ?? 0;
    const limit = interaction.options.getInteger('limit');
    const saleWindow = interaction.options.getString('sale_window');

    if (price <= 0) {
      await interaction.reply({ content: 'Price must be > 0.', ephemeral: true });
      return;
    }
    if (shipping < 0) {
      await interaction.reply({ content: 'Shipping cannot be negative.', ephemeral: true });
      return;
    }

    try {
      const product = createProduct({
        name,
        priceCents: dollarsToCents(price),
        shippingCents: dollarsToCents(shipping),
        quantity,
        maxPerBuyer: limit ?? null,
        saleWindow,
      });
      const shipNote = product.shipping_cents
        ? ` + ${formatAud(product.shipping_cents)} shipping`
        : '';
      const limitNote = getProductMaxPerBuyer(product)
        ? ` · max ${product.max_per_buyer}/person`
        : '';
      await interaction.reply({
        content: `Added **${product.name}** — ${formatAud(product.price_cents)}${shipNote} × ${product.quantity_available} available${limitNote}.`,
        ephemeral: true,
      });
      await refreshStockpost(interaction.client);
    } catch (err) {
      await interaction.reply({ content: `Could not add product (name may already exist): ${err.message}`, ephemeral: true });
    }
    return;
  }

  if (sub === 'stock') {
    const name = interaction.options.getString('name', true);
    const quantity = interaction.options.getInteger('quantity', true);
    const product = resolveProductByName(name);
    if (!product) {
      await interaction.reply({ content: 'Product not found.', ephemeral: true });
      return;
    }
    const updated = updateProductStock(product.id, quantity);
    const reactivated = quantity > 0 ? ' (reactivated)' : '';
    await interaction.reply({
      content: `Stock for **${updated.name}** set to **${quantity}**${reactivated}.`,
      ephemeral: true,
    });
    await refreshStockpost(interaction.client);
    return;
  }

  if (sub === 'price') {
    const name = interaction.options.getString('name', true);
    const price = interaction.options.getNumber('price', true);
    const product = resolveProductByName(name);
    if (!product) {
      await interaction.reply({ content: 'Product not found.', ephemeral: true });
      return;
    }
    setProductPrice(product.id, dollarsToCents(price));
    await interaction.reply({ content: `Price for **${product.name}** set to **${formatAud(dollarsToCents(price))}**.`, ephemeral: true });
    await refreshStockpost(interaction.client);
    return;
  }

  if (sub === 'shipping') {
    const name = interaction.options.getString('name', true);
    const shipping = interaction.options.getNumber('shipping', true);
    const product = resolveProductByName(name);
    if (!product) {
      await interaction.reply({ content: 'Product not found.', ephemeral: true });
      return;
    }
    setProductShipping(product.id, dollarsToCents(shipping));
    await interaction.reply({
      content: `Shipping for **${product.name}** set to **${formatAud(dollarsToCents(shipping))}** (flat per order).`,
      ephemeral: true,
    });
    await refreshStockpost(interaction.client);
    return;
  }

  if (sub === 'tiers') {
    const name = interaction.options.getString('name', true);
    const tiersInput = interaction.options.getString('tiers', true);
    const product = resolveProductByName(name);
    if (!product) {
      await interaction.reply({ content: 'Product not found.', ephemeral: true });
      return;
    }
    const parsed = parseTiersInput(tiersInput);
    if (!parsed.ok) {
      await interaction.reply({
        content: `Could not set tiers: ${parsed.error}\nFormat: \`1-4:200:5,5-9:200:0,10+:197:0\` (range:price:shipping, in dollars).`,
        ephemeral: true,
      });
      return;
    }
    setProductTiers(product.id, JSON.stringify(parsed.tiers));
    const updated = resolveProductByName(name);
    await interaction.reply({
      content: `Tiered pricing set for **${updated.name}**:\n${formatTiersForDisplay(updated, formatAud)}`,
      ephemeral: true,
    });
    await refreshStockpost(interaction.client);
    return;
  }

  if (sub === 'cleartiers') {
    const name = interaction.options.getString('name', true);
    const product = resolveProductByName(name);
    if (!product) {
      await interaction.reply({ content: 'Product not found.', ephemeral: true });
      return;
    }
    clearProductTiers(product.id);
    const shipNote = product.shipping_cents ? ` + ${formatAud(product.shipping_cents)} shipping` : '';
    await interaction.reply({
      content: `Cleared tiered pricing for **${product.name}** — back to flat **${formatAud(product.price_cents)}**${shipNote}.`,
      ephemeral: true,
    });
    await refreshStockpost(interaction.client);
    return;
  }

  if (sub === 'limit') {
    const name = interaction.options.getString('name', true);
    const max = interaction.options.getInteger('max', true);
    const product = resolveProductByName(name);
    if (!product) {
      await interaction.reply({ content: 'Product not found.', ephemeral: true });
      return;
    }
    const value = max === 0 ? null : max;
    setProductMaxPerBuyer(product.id, value);
    await interaction.reply({
      content: value
        ? `Per-person limit for **${product.name}** set to **${value}**.`
        : `Per-person limit for **${product.name}** cleared (unlimited).`,
      ephemeral: true,
    });
    await refreshStockpost(interaction.client);
    return;
  }

  if (sub === 'activate') {
    const name = interaction.options.getString('name', true);
    const product = resolveProductByName(name);
    if (!product) {
      await interaction.reply({ content: 'Product not found.', ephemeral: true });
      return;
    }
    if (product.quantity_available <= 0) {
      await interaction.reply({
        content: `**${product.name}** has 0 stock. Use \`/product stock\` first, then activate.`,
        ephemeral: true,
      });
      return;
    }
    setProductActive(product.id, true);
    await interaction.reply({ content: `Activated **${product.name}** (${product.quantity_available} available).`, ephemeral: true });
    await refreshStockpost(interaction.client);
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
    await refreshStockpost(interaction.client);
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
      const limit = getProductMaxPerBuyer(p);
      const limitNote = limit ? ` · max ${limit}/person` : '';
      const tiers = getProductTiers(p);
      const priceNote = tiers
        ? ` — tiered pricing (${tiers.length} tiers, from ${formatAud(tiers[tiers.length - 1].priceCents)}/ea)`
        : ` — ${formatAud(p.price_cents)}${p.shipping_cents ? ` + ${formatAud(p.shipping_cents)} ship` : ''}`;
      return `${flag} **${p.name}**${priceNote} · qty ${p.quantity_available}${limitNote}${p.sale_window ? ` · ${p.sale_window}` : ''}`;
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

  const payload = buildStockpostPayload(products);
  const message = await interaction.reply({
    ...payload,
    fetchReply: true,
  });
  rememberStockpost(interaction.channelId, message.id);

  try {
    await announceSaleStart(interaction.channel, products.map((p) => p.name));
  } catch (err) {
    console.error('Sale start announce failed:', err);
  }
}

async function handleEndSale(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  if (interaction.channelId !== config.claimsChannelId) {
    await interaction.reply({
      content: `Run \`/endsale\` in the claims channel (<#${config.claimsChannelId}>).`,
      ephemeral: true,
    });
    return;
  }

  const active = listActiveProducts();
  if (!active.length) {
    await interaction.reply({ content: 'No active claim sale to end.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const names = await endClaimSale(interaction.channel, { announce: true });
  await interaction.editReply(`Ended claim sale for: ${names.map((n) => `**${n}**`).join(', ')}`);
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

async function handleCancel(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const order = resolveOrderFromInteraction(interaction);
  if (!order) {
    await interaction.reply({
      content: 'Order not found. Run `/cancel` inside the ticket thread or pass `reference`.',
      ephemeral: true,
    });
    return;
  }

  if (order.status !== 'pending') {
    await interaction.reply({
      content: `Can only cancel **pending** orders (status: \`${order.status}\`).`,
      ephemeral: true,
    });
    return;
  }

  const reason = interaction.options.getString('reason') || `Cancelled by staff <@${interaction.user.id}>`;
  const result = cancelOrder(order.id, reason);
  if (!result.ok) {
    await interaction.reply({ content: `Could not cancel (status: \`${order.status}\`).`, ephemeral: true });
    return;
  }

  if (order.thread_id) {
    try {
      const thread = await interaction.client.channels.fetch(order.thread_id);
      if (thread?.isThread()) {
        await thread.send(
          `❌ Claim **${order.reference_code}** cancelled by staff. Stock returned (${order.quantity}x ${order.product_name}). Reason: ${reason}`,
        );
        await thread.setLocked(true, 'Claim cancelled by staff');
        await thread.setArchived(true, 'Claim cancelled by staff');
      }
    } catch (err) {
      console.error('Failed to close cancelled thread:', err.message);
    }
  }

  await refreshStockpost(interaction.client);
  await interaction.reply({
    content: `Cancelled **${order.reference_code}** — returned **${order.quantity}x ${order.product_name}** to stock.`,
    ephemeral: true,
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

async function handleExport(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const result = buildLabelExportCsv();
  if (!result) {
    await interaction.reply({ content: 'No paid orders waiting to be exported.', ephemeral: true });
    return;
  }

  const attachment = new AttachmentBuilder(Buffer.from(result.csv, 'utf-8'), {
    name: `labels-${new Date().toISOString().slice(0, 10)}.csv`,
  });

  await interaction.reply({
    content: `📦 Exported **${result.count}** order${result.count === 1 ? '' : 's'} — upload this to the label printer app. These won't be included if you run \`/export\` again.`,
    files: [attachment],
    ephemeral: true,
  });
}

export async function handleSlashCommand(interaction) {
  switch (interaction.commandName) {
    case 'product':
      return handleProduct(interaction);
    case 'stockpost':
      return handleStockpost(interaction);
    case 'endsale':
      return handleEndSale(interaction);
    case 'paid':
      return handlePaid(interaction);
    case 'shipped':
      return handleShipped(interaction);
    case 'cancel':
      return handleCancel(interaction);
    case 'shipping':
      return handleShippingCommand(interaction);
    case 'ban':
      return handleBan(interaction);
    case 'unban':
      return handleUnban(interaction);
    case 'appeal':
      return handleAppeal(interaction);
    case 'order':
      return handleOrder(interaction);
    case 'export':
      return handleExport(interaction);
    default:
      await interaction.reply({ content: 'Unknown command.', ephemeral: true });
  }
}

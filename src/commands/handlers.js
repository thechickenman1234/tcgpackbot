import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { formatAud, isStaff } from '../utils/permissions.js';
import { buildLabelExportCsv } from '../services/labelExportService.js';
import { isSheetConfigured, pushToSheet, pushToSheetInBackground } from '../services/sheetService.js';
import {
  attachBoardMessage,
  cancelGiveaway,
  drawWinners,
  endGiveaway,
  getEntryCount,
  getLatestGiveaway,
  getRunningGiveaway,
  getStandings,
  getTotals,
  startGiveaway,
} from '../services/giveawayService.js';
import { buildBoardEmbed } from '../services/giveawayBoard.js';
import { getTotalsBySource, logManualOrder } from '../services/manualOrderService.js';
import { backfillBuyerRole, grantBuyerRole } from '../services/buyerRoleService.js';
import { createScheduledEvent, eventUrl } from '../services/discordEventService.js';
import {
  addProductToSale,
  cancelScheduledSale,
  createScheduledSale,
  findPendingSaleAt,
  listUpcomingSales,
  productsFor,
} from '../services/scheduledSaleService.js';
import {
  ZONE,
  cancelScheduled,
  cleanupAttachments,
  formatMelbourne,
  listPending,
  melbourneToUtc,
  readAttachments,
  saveAttachment,
  scheduleMessage,
} from '../services/scheduleService.js';
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
  setProductDescription,
  setProductShipping,
  setProductTiers,
  updateProductStock,
} from '../services/productService.js';
import { endClaimSale, announceSaleStart } from '../services/saleAnnouncements.js';
import {
  cancelOrder,
  getOrderByReference,
  getOrderByThreadId,
  getAllPaidOrders,
  getAllPayingBuyerIds,
  getClaimedTotals,
  getClaimsForProduct,
  getPaidOrdersForBuyer,
  getRecentlyShippedOrders,
  getSyncableOrders,
  markPaid,
  unshipOrder,
  markShipped,
  setTrackingCode,
} from '../services/orderService.js';
import {
  findBuyersByName,
  getBanHistory,
  getBuyer,
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

  if (sub === 'describe') {
    const name = interaction.options.getString('name', true).trim();
    const product = findProductByName(name);
    if (!product) {
      await interaction.reply({ content: `No product called \`${name}\`.`, ephemeral: true });
      return;
    }

    const display = interaction.options.getString('display');
    // Separate boxes rather than one field with escape characters in it.
    // Nobody should have to type \n into a Discord command.
    const lines = ['line1', 'line2', 'line3']
      .map((n) => interaction.options.getString(n))
      .filter(Boolean);
    const details = lines.length ? lines.join('\n') : undefined;

    const unit = interaction.options.getString('unit');

    const updated = setProductDescription(product.id, {
      displayName: display === null ? undefined : display,
      details: details === undefined ? undefined : details,
      unit: unit === null ? undefined : unit,
    });

    await interaction.reply({
      content: `✅ Updated **${updated.name}**\n\n`
        + `**Long name:** ${updated.display_name || '_not set, announcements will use the short name_'}\n`
        + `**Priced per:** ${updated.unit || 'box'}\n`
        + `**Details:**\n${updated.details ? `> ${updated.details.replace(/\n/g, '\n> ')}` : '_none_'}`,
      ephemeral: true,
    });
    return;
  }

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

  pushToSheetInBackground([result.order], 'paid');
  const gotRole = await grantBuyerRole(interaction.client, order.buyer_id);

  await interaction.reply({
    content: `✅ Marked **${order.reference_code}** as **paid** (${formatAud(order.total_cents)}).`
      + (gotRole ? '\n🏅 Buyer role given.' : ''),
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

  const tracking = interaction.options.getString('tracking')?.trim() || null;
  const result = markShipped(order.id, tracking);
  if (!result.ok) {
    await interaction.reply({
      content: `Cannot mark shipped (status: \`${order.status}\`). Order must be paid first.`,
      ephemeral: true,
    });
    return;
  }

  if (tracking) await postTrackingToThread(interaction.client, result.order);
  pushToSheetInBackground([result.order], 'shipped');

  const archiveUnix = Math.floor(new Date(result.order.archive_at).getTime() / 1000);
  await interaction.reply({
    content: `📦 Marked **${order.reference_code}** as **shipped**`
      + (tracking ? ` with tracking \`${tracking}\` — buyer notified.` : '.')
      + ` Thread will auto-archive <t:${archiveUnix}:R>.`,
  });
}

/** Tell the buyer their tracking number in their own ticket. */
async function postTrackingToThread(client, order) {
  if (!order.thread_id || !order.tracking_code) return false;
  try {
    const thread = await client.channels.fetch(order.thread_id);
    await thread.send(
      `<@${order.buyer_id}> 📦 **${order.quantity}x ${order.product_name}** is on its way.\n`
      + `Tracking: \`${order.tracking_code}\`\n`
      + `Track it at https://auspost.com.au/mypost/track/search?id=${order.tracking_code}`,
    );
    return true;
  } catch (err) {
    console.error(`Failed to post tracking to thread ${order.thread_id}:`, err);
    return false;
  }
}

/**
 * Which of a buyer's unshipped orders a single tracking code should cover.
 *
 * A name match can turn up orders that were never going in the same box.
 * The common case is an order that was posted weeks ago but never marked
 * shipped here, so it still reads as awaiting a parcel — fanning a code
 * across those messages people about deliveries they already have.
 *
 * So we only fan out when the buyer actually combined the orders, which
 * records the parcel it joined in combined_with. One anchor order with
 * everything else pointing at it is a parcel. Anything else is a guess,
 * and returns null so the caller can ask for an explicit reference.
 */
const STALE_SPAN_DAYS = 14;

function ordersInOneParcel(orders) {
  if (orders.length <= 1) return orders;

  // The Labels tab prints one label per buyer, so everything a buyer has
  // waiting goes in the one parcel and shares its tracking code. That is
  // true now that orders are never combined - the grouping happens at
  // packing time rather than being something the buyer opted into.
  const dates = orders.map((o) => o.claimed_at).filter(Boolean).sort();
  if (dates.length < 2) return orders;

  const spanDays = (new Date(dates[dates.length - 1]) - new Date(dates[0])) / 86400000;

  // Weeks apart is not one parcel, it is an older order that went out and
  // was never marked shipped. Messaging that buyer about a parcel they
  // received last month is the exact mistake this guard exists to stop.
  return spanDays > STALE_SPAN_DAYS ? null : orders;
}

/**
 * Bulk tracking. Paste "REF CODE" pairs, one per line or comma separated.
 * Several orders can share a tracking code when they ship in one parcel.
 */
async function handleTracking(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  // Each line is "<who>: <tracking>". <who> is a customer name straight off
  // the label printer, or an order reference if you'd rather be precise.
  const entries = interaction.options.getString('paste', true)
    .split(/[\n;]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*?)[\s:,=]+([A-Za-z0-9-]{8,})\s*$/);
      return m ? { who: m[1].trim(), code: m[2].trim() } : null;
    })
    .filter(Boolean);

  const done = [];
  const failed = [];
  const synced = [];

  for (const { who, code } of entries) {
    let orders;

    if (/^TCG-[0-9A-Z]{6}$/i.test(who)) {
      const order = getOrderByReference(who.toUpperCase());
      orders = order ? [order] : [];
    } else {
      const buyers = findBuyersByName(who);
      if (buyers.length > 1) {
        failed.push(`${who} — ${buyers.length} buyers share that name, use the order reference`);
        continue;
      }
      orders = buyers.length ? getPaidOrdersForBuyer(buyers[0].discord_id) : [];

      const parcel = ordersInOneParcel(orders);
      if (!parcel) {
        const list = orders
          .map((o) => `\`${o.reference_code}\`${o.paid_at ? ` (${o.paid_at.slice(0, 10)})` : ''}`)
          .join(', ');
        failed.push(
          `${who} — ${orders.length} unshipped orders more than ${STALE_SPAN_DAYS} days apart: ${list}. `
          + 'An older one has probably shipped already. Paste the reference you mean, '
          + 'or clear the old wave with `/shipall before:`.',
        );
        continue;
      }
      orders = parcel;
    }

    if (!orders.length) {
      failed.push(`${who} — nothing awaiting shipping`);
      continue;
    }

    // One parcel can hold several orders, so they all get the same code.
    for (const order of orders) {
      const updated = order.status === 'paid'
        ? markShipped(order.id, code).order
        : setTrackingCode(order.id, code);
      await postTrackingToThread(interaction.client, updated);
      synced.push(updated);
    }
    const what = orders.map((o) => o.reference_code).join(', ');
    done.push(`${who} — ${code}${orders.length > 1 ? ` (${orders.length} orders: ${what})` : ''}`);
  }

  // One push for the whole paste rather than one per parcel: the Labels tab
  // is rebuilt on every call, so batching keeps it to a single rewrite.
  pushToSheetInBackground(synced, 'tracking');

  const parcels = done.length;
  const lines = [
    `📦 Tracking sent for **${parcels}** parcel${parcels === 1 ? '' : 's'}.`,
    ...done.map((d) => `• ${d}`),
  ];
  if (failed.length) lines.push('', `⚠️ **${failed.length} skipped:**`, ...failed.map((f) => `• ${f}`));

  await interaction.editReply({ content: lines.join('\n').slice(0, 1900) });
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

/**
 * Pushes every paid, shipped and archived order into the sheet at once.
 *
 * Unlike /export this has no memory and burns nothing - run it as often as
 * you like. Use it to backfill orders that were marked paid before the sync
 * existed, or any time Google was down and a live push was dropped.
 */
async function handleSync(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  if (!isSheetConfigured()) {
    await interaction.reply({
      content: 'Sheet sync is not set up — `SHEET_URL` and `SHEET_SECRET` are missing on Railway.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const orders = getSyncableOrders();
  if (!orders.length) {
    await interaction.editReply({ content: 'Nothing to sync — no paid orders yet.' });
    return;
  }

  try {
    const result = await pushToSheet(orders);
    await interaction.editReply({
      content: `📊 Synced **${result.salesRows}** order${result.salesRows === 1 ? '' : 's'} to the Sales tab.\n`
        + `🏷️ Labels tab rebuilt with **${result.labelRows}** parcel${result.labelRows === 1 ? '' : 's'} waiting to ship.\n`
        + `📦 Products tab rebuilt with **${result.productRows ?? 0}** product${result.productRows === 1 ? '' : 's'} — check the Left column.`,
    });
  } catch (err) {
    console.error('Sheet sync failed:', err);
    await interaction.editReply({ content: `Sync failed: ${err.message}` });
  }
}

/**
 * Marks every paid order shipped except the ones you name.
 *
 * Exists because orders get posted without anyone running /shipped, so the
 * Labels tab fills up with parcels that left weeks ago. Previewing is the
 * default: there is no un-ship, so nothing happens until confirm is true.
 */
async function handleShipAll(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Three slots rather than one comma-separated box, because each slot is a
  // dropdown of products that actually have orders waiting. Picking from a
  // list beats remembering how a product was spelled when it was created.
  const terms = ['keep', 'keep2', 'keep3']
    .map((name) => interaction.options.getString(name))
    .filter(Boolean)
    .flatMap((value) => value.split(',').map((t) => t.trim().toLowerCase()))
    .filter(Boolean);
  const confirm = interaction.options.getBoolean('confirm') ?? false;
  const before = interaction.options.getString('before');
  const paid = getAllPaidOrders();

  if (!paid.length) {
    await interaction.editReply({ content: 'Nothing to do — no paid orders waiting to ship.' });
    return;
  }

  if (!terms.length && !before) {
    await interaction.editReply({
      content: 'Give me either a product to **keep** or a date to work **before**, '
        + 'otherwise this would mark every single waiting order as shipped.',
    });
    return;
  }

  // Anything claimed on or after the cutoff is a later wave and is left
  // alone entirely, whatever product it is.
  const cutoff = before ? melbourneToUtc(before, '00:00') : null;
  const inScope = cutoff
    ? paid.filter((o) => o.claimed_at && new Date(o.claimed_at) < cutoff)
    : paid;
  const later = paid.length - inScope.length;

  const keep = inScope.filter((o) => {
    const name = o.product_name.toLowerCase();
    return terms.some((t) => name.includes(t));
  });
  const ship = inScope.filter((o) => !keep.includes(o));
  const except = terms.join('`, `');

  // Boxes first, orders in brackets. Counting orders alone read as a box
  // count and made ten orders of four boxes look like ten boxes.
  const summarise = (orders) => {
    const byProduct = new Map();
    for (const o of orders) {
      const row = byProduct.get(o.product_name) || { boxes: 0, orders: 0 };
      row.boxes += o.quantity;
      row.orders += 1;
      byProduct.set(o.product_name, row);
    }
    return [...byProduct.entries()]
      .sort((a, b) => b[1].boxes - a[1].boxes)
      .map(([name, r]) => `• **${r.boxes}x ${name}** _(${r.orders} order${r.orders === 1 ? '' : 's'})_`);
  };

  if (!confirm) {
    const lines = [
      `**Preview only — nothing has changed.**`,
      before ? `Looking at orders claimed **before ${before}**.` : null,
      '',
      `Would mark **${ship.reduce((n, o) => n + o.quantity, 0)} boxes** across `
        + `**${ship.length}** order${ship.length === 1 ? '' : 's'} as shipped:`,
      ...summarise(ship),
      '',
      keep.length
        ? `Would leave **${keep.length}** alone (matched \`${except}\`):\n${summarise(keep).join('\n')}`
        : null,
      later ? `Would leave **${later}** alone — claimed on or after ${before}.` : null,
      !terms.length && !later && !before
        ? '⚠️ Nothing is being held back — **everything** would be marked shipped.'
        : null,
      '',
      `Every product currently waiting:\n${summarise(paid).join('\n')}`,
      '',
      'Happy with that? Run it again with **confirm: True**. There is no undo, but `/unship` puts one back.',
    ].filter((l) => l !== null);
    await interaction.editReply({ content: lines.join('\n').slice(0, 1900) });
    return;
  }

  let done = 0;
  const shipped = [];
  for (const order of ship) {
    const result = markShipped(order.id, null);
    if (result.ok) {
      shipped.push(result.order);
      done += 1;
    }
  }

  pushToSheetInBackground(shipped, 'shipall');

  const lines = [
    `📦 Marked **${shipped.reduce((n, o) => n + o.quantity, 0)} boxes** across `
      + `**${done}** order${done === 1 ? '' : 's'} as shipped.`,
    ...summarise(shipped),
    '',
    `Left **${keep.length + later}** waiting. The Labels tab now shows only those.`,
    'Nothing was posted to any buyer thread.',
  ];
  await interaction.editReply({ content: lines.join('\n').slice(0, 1900) });
}

/**
 * Fills the /shipall dropdowns with products that actually have orders
 * waiting, busiest first, so nobody has to remember exactly how a product
 * was spelled when it was created.
 */
export async function handleAutocomplete(interaction) {
  const typed = (interaction.options.getFocused() || '').toLowerCase();

  if (interaction.commandName === 'logsale') {
    const choices = listAllProducts()
      .filter((p) => p.name.toLowerCase().includes(typed))
      .slice(0, 25)
      .map((p) => ({
        name: `${p.name}${p.active ? '' : ' (inactive)'}`.slice(0, 100),
        value: p.name.slice(0, 100),
      }));
    await interaction.respond(choices);
    return;
  }

  if (interaction.commandName === 'shipall') {
    // Same date list as the sale commands, but looking backwards.
    const choices = [];
    for (let i = 0; i < 90 && choices.length < 25; i += 1) {
      const day = new Date(Date.now() - i * 86400000);
      const label = new Intl.DateTimeFormat('en-AU', { timeZone: ZONE, weekday: 'short', day: 'numeric', month: 'short' }).format(day);
      const value = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(day);
      const pretty = i === 0 ? `${label} (today)` : label;
      if (interaction.options.getFocused(true).name === 'before' && (pretty.toLowerCase().includes(typed) || value.includes(typed))) {
        choices.push({ name: pretty, value });
      }
    }
    if (choices.length) { await interaction.respond(choices); return; }
  }

  if (interaction.commandName === 'cancelsale') {
    const choices = listUpcomingSales()
      .map((s) => ({
        name: `${formatMelbourne(s.start_at)} — ${productsFor(s).map((p) => p.name).join(', ')}`.slice(0, 100),
        value: String(s.id),
      }))
      .filter((c) => c.name.toLowerCase().includes(typed))
      .slice(0, 25);
    await interaction.respond(choices);
    return;
  }

  if (['schedulesale', 'newsale', 'schedule', 'event'].includes(interaction.commandName)) {
    const focused = interaction.options.getFocused(true);

    // /newsale calls it "name" because it also creates the product. You can
    // still type a brand new one; the list is only a shortcut to existing.
    if (focused.name.startsWith('product') || focused.name === 'name') {
      const choices = listAllProducts()
        .filter((p) => p.name.toLowerCase().includes(typed))
        .slice(0, 25)
        .map((p) => ({
          name: `${p.name} — ${p.quantity_available} in stock`.slice(0, 100),
          value: p.name.slice(0, 100),
        }));
      await interaction.respond(choices);
      return;
    }

    if (focused.name === 'start' || focused.name === 'end') {
      const choices = [];
      for (let h = 0; h < 24 && choices.length < 25; h += 1) {
        for (const m of [0, 30]) {
          const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          const hour12 = h % 12 === 0 ? 12 : h % 12;
          const label = `${hour12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
          if (label.replace(/[:\s]/g, '').includes(typed.replace(/[:\s]/g, '')) || value.includes(typed)) {
            if (choices.length < 25) choices.push({ name: label, value });
          }
        }
      }
      await interaction.respond(choices);
      return;
    }

    if (focused.name === 'date') {
      // Discord has no date picker, so the next two months become a
      // dropdown. Typing filters it, which is close enough to a calendar.
      const choices = [];
      for (let i = 0; i < 60 && choices.length < 25; i += 1) {
        const day = new Date(Date.now() + i * 86400000);
        const label = new Intl.DateTimeFormat('en-AU', {
          timeZone: ZONE, weekday: 'short', day: 'numeric', month: 'short',
        }).format(day);
        const value = new Intl.DateTimeFormat('en-CA', {
          timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(day);
        const pretty = i === 0 ? `${label} (today)` : i === 1 ? `${label} (tomorrow)` : label;
        if (pretty.toLowerCase().includes(typed) || value.includes(typed)) {
          choices.push({ name: pretty, value });
        }
      }
      await interaction.respond(choices);
      return;
    }

    if (focused.name === 'time') {
      const choices = [];
      for (let h = 0; h < 24 && choices.length < 25; h += 1) {
        for (const m of [0, 30]) {
          const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          const hour12 = h % 12 === 0 ? 12 : h % 12;
          const label = `${hour12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
          if (label.replace(/[:\s]/g, '').includes(typed.replace(/[:\s]/g, '')) || value.includes(typed)) {
            if (choices.length < 25) choices.push({ name: label, value });
          }
        }
      }
      await interaction.respond(choices);
      return;
    }

    await interaction.respond([]);
    return;
  }

  if (interaction.commandName === 'unschedule') {
    const choices = listPending()
      .map((r) => ({
        name: `${formatMelbourne(r.send_at)} — ${r.content.replace(/\s+/g, ' ').slice(0, 55)}`.slice(0, 100),
        value: String(r.id),
      }))
      .filter((c) => c.name.toLowerCase().includes(typed))
      .slice(0, 25);
    await interaction.respond(choices);
    return;
  }

  if (interaction.commandName === 'claimed') {
    const choices = getClaimedTotals()
      .filter((t) => t.product_name.toLowerCase().includes(typed))
      .slice(0, 25)
      .map((t) => ({
        name: `${t.product_name} — ${t.total} claimed`.slice(0, 100),
        value: t.product_name.slice(0, 100),
      }));
    await interaction.respond(choices);
    return;
  }

  if (interaction.commandName === 'shipped') {
    // Everything still waiting, searchable by buyer name. Reading a
    // reference off a label to type it back in is how orders get missed.
    const choices = getAllPaidOrders()
      .map((o) => ({
        label: `${getBuyer(o.buyer_id)?.name || 'Unknown'} — ${o.quantity}x ${o.product_name} (${o.reference_code})`,
        value: o.reference_code,
      }))
      .filter((c) => c.label.toLowerCase().includes(typed))
      .slice(0, 25)
      .map((c) => ({ name: c.label.slice(0, 100), value: c.value }));
    await interaction.respond(choices);
    return;
  }

  if (interaction.commandName === 'unship') {
    // Buyer name first: a reference and a product are not enough to tell
    // two orders of the same thing apart when you are picking one to undo.
    const choices = getRecentlyShippedOrders()
      .map((o) => ({
        label: `${getBuyer(o.buyer_id)?.name || 'Unknown'} — ${o.quantity}x ${o.product_name} (${o.reference_code})`,
        value: o.reference_code,
      }))
      .filter((c) => c.label.toLowerCase().includes(typed))
      .slice(0, 25)
      .map((c) => ({ name: c.label.slice(0, 100), value: c.value }));
    await interaction.respond(choices);
    return;
  }

  if (interaction.commandName !== 'shipall') {
    await interaction.respond([]);
    return;
  }

  const waiting = new Map();
  for (const order of getAllPaidOrders()) {
    waiting.set(order.product_name, (waiting.get(order.product_name) || 0) + 1);
  }

  const choices = [...waiting.entries()]
    .filter(([name]) => name.toLowerCase().includes(typed))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([name, count]) => ({
      name: `${name} — ${count} waiting`.slice(0, 100),
      value: name.slice(0, 100),
    }));

  await interaction.respond(choices);
}

/**
 * Puts a shipped order back to waiting. Nothing is said to the buyer - the
 * bot never announced the order as shipped in the first place unless a
 * tracking number went with it.
 */
async function handleUnship(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const reference = (interaction.options.getString('reference') || '').trim().toUpperCase();
  const order = getOrderByReference(reference);
  if (!order) {
    await interaction.reply({ content: `No order found with reference \`${reference}\`.`, ephemeral: true });
    return;
  }

  const result = unshipOrder(order.id);
  if (!result.ok) {
    await interaction.reply({
      content: `Can only un-ship a **shipped** order (status: \`${order.status}\`).`,
      ephemeral: true,
    });
    return;
  }

  pushToSheetInBackground([result.order], 'unship');

  await interaction.reply({
    content: `↩️ **${order.reference_code}** is back to **waiting to ship** (${order.quantity}x ${order.product_name}).\n`
      + 'It is on the Labels tab again and the 7-day auto-archive has been cancelled. Nothing was said to the buyer.',
    ephemeral: true,
  });
}

async function handleGiveaway(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'start') {
    const prize = interaction.options.getString('prize', true).trim();
    const days = interaction.options.getInteger('days', true);
    const winnerCount = interaction.options.getInteger('winners') ?? 1;
    const minAccountAgeDays = interaction.options.getInteger('min_account_age') ?? 7;
    const endsAt = new Date(Date.now() + days * 86400000).toISOString();

    const result = startGiveaway({ prize, endsAt, winnerCount, minAccountAgeDays });
    if (!result.ok) {
      await interaction.reply({
        content: 'A giveaway is already running. End or cancel it first with `/giveaway end`.',
        ephemeral: true,
      });
      return;
    }

    const giveaway = result.giveaway;
    const embed = buildBoardEmbed(giveaway, [], { entries: 0, people: 0 });
    const message = await interaction.channel.send({ embeds: [embed] });
    attachBoardMessage(giveaway.id, interaction.channel.id, message.id);

    await interaction.reply({
      content: `🎁 Giveaway started — **${prize}**, ${days} day${days === 1 ? '' : 's'}, `
        + `**${winnerCount}** winner${winnerCount === 1 ? '' : 's'}.\n`
        + `Invited accounts must be at least **${minAccountAgeDays}** days old to count.\n`
        + 'The leaderboard above updates itself every 10 minutes.',
      ephemeral: true,
    });
    return;
  }

  const giveaway = getRunningGiveaway() || getLatestGiveaway();
  if (!giveaway) {
    await interaction.reply({ content: 'No giveaway has been run yet.', ephemeral: true });
    return;
  }

  if (sub === 'status') {
    const standings = getStandings(giveaway.id);
    const totals = getTotals(giveaway.id);
    const lines = standings.slice(0, 25)
      .map((r, i) => `${i + 1}. <@${r.inviter_id}> — ${r.entries}`);
    await interaction.reply({
      content: `**${giveaway.prize}** · status \`${giveaway.status}\`\n`
        + `${totals.entries} entries from ${totals.people} people.\n\n`
        + (lines.join('\n') || 'No entries yet.'),
      ephemeral: true,
    });
    return;
  }

  if (sub === 'end') {
    const result = endGiveaway(giveaway.id);
    await interaction.reply({
      content: result.ok
        ? 'Entries are closed. Run `/giveaway draw` when you are ready to pick.'
        : 'That giveaway is not running.',
      ephemeral: true,
    });
    return;
  }

  if (sub === 'cancel') {
    const result = cancelGiveaway(giveaway.id);
    await interaction.reply({
      content: result.ok ? 'Giveaway cancelled. No winner will be drawn.' : 'It has already been drawn.',
      ephemeral: true,
    });
    return;
  }

  if (sub === 'draw') {
    await interaction.deferReply();
    const result = drawWinners(giveaway.id);
    if (!result.ok) {
      const why = {
        no_entries: 'Nobody invited anyone, so there is nothing to draw.',
        already_drawn: 'This giveaway has already been drawn.',
        not_found: 'Could not find that giveaway.',
      }[result.reason] || 'Could not draw.';
      await interaction.editReply({ content: why });
      return;
    }

    const totals = getTotals(giveaway.id);
    const mentions = result.winners.map((id) => `<@${id}>`).join(' and ');
    await interaction.editReply({
      content: `🎉 **${giveaway.prize}**\n\nWinner: ${mentions}\n\n`
        + `Drawn from **${totals.entries}** entries across **${totals.people}** people. `
        + 'More invites meant more tickets in the hat.',
      allowedMentions: { users: result.winners },
    });
    return;
  }
}

/** Open to everyone: your own count, plus where you sit. */
async function handleEntries(interaction) {
  const giveaway = getRunningGiveaway();
  if (!giveaway) {
    await interaction.reply({ content: 'There is no giveaway running right now.', ephemeral: true });
    return;
  }

  const standings = getStandings(giveaway.id);
  const totals = getTotals(giveaway.id);
  const mine = getEntryCount(giveaway.id, interaction.user.id);
  const place = standings.findIndex((r) => r.inviter_id === interaction.user.id) + 1;

  const yours = mine
    ? `You have **${mine}** ${mine === 1 ? 'entry' : 'entries'}${place ? ` — currently **#${place}**` : ''}.`
    : 'You have **no entries yet**. Invite someone and you are in.';

  await interaction.reply({
    embeds: [buildBoardEmbed(giveaway, standings, totals)],
    content: yours,
    ephemeral: true,
  });
}

/**
 * What to order from the supplier.
 *
 * Counts pending claims as well as paid ones. Somebody who claimed an hour
 * ago and has not paid yet is still expecting a box, and a spare box costs
 * far less than telling a buyer the sale is off. Reading it from the bot
 * rather than scrolling the channel also means corrected and re-posted
 * claims are already resolved - the order is the truth, not the message.
 */
/**
 * The whole sale night in one command: make or update the product, give it
 * its long name and pack structure, and queue the night it goes on.
 *
 * Running it again for the same night adds that product to the same sale
 * rather than starting a competing one, which is how a two product night
 * gets set up without a second command.
 */
async function handleNewSale(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const name = interaction.options.getString('name', true).trim();
  const price = interaction.options.getNumber('price', true);
  const quantity = interaction.options.getInteger('quantity', true);
  const date = interaction.options.getString('date', true);
  const shipping = interaction.options.getNumber('shipping');
  const limit = interaction.options.getInteger('limit');

  const start = interaction.options.getString('start') || '20:00';
  const end = interaction.options.getString('end') || '00:00';
  const announce = interaction.options.getString('announce') || '19:00';

  const startAt = melbourneToUtc(date, start);
  let endAt = melbourneToUtc(date, end);
  if (!startAt || !endAt) {
    await interaction.reply({ content: 'Could not read those times. Pick them from the dropdowns.', ephemeral: true });
    return;
  }
  if (endAt.getTime() <= startAt.getTime()) {
    const [y, m, d] = date.split('-').map(Number);
    const nextDay = new Date(Date.UTC(y, m - 1, d + 1));
    endAt = melbourneToUtc(nextDay.toISOString().slice(0, 10), end);
  }
  if (endAt.getTime() <= Date.now()) {
    await interaction.reply({ content: 'That sale would already be over. Pick a later night.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Make it or update it. Either way the product ends up matching what was
  // just typed, so a repeated run is a correction rather than an error.
  let product = findProductByName(name);
  const isNew = !product;
  if (product) {
    setProductPrice(product.id, Math.round(price * 100));
    updateProductStock(product.id, quantity);
    if (shipping !== null) setProductShipping(product.id, Math.round(shipping * 100));
    if (limit !== null) setProductMaxPerBuyer(product.id, limit);
  } else {
    product = createProduct({
      name,
      priceCents: Math.round(price * 100),
      quantity,
      shippingCents: Math.round((shipping ?? config.standardShippingCents / 100) * 100),
      maxPerBuyer: limit,
    });
    // Products are created live; the scheduled sale is what decides when
    // claims actually open.
    setProductActive(product.id, false);
  }

  const lines = ['line1', 'line2'].map((n) => interaction.options.getString(n)).filter(Boolean);
  product = setProductDescription(product.id, {
    displayName: interaction.options.getString('display') ?? undefined,
    details: lines.length ? lines.join('\n') : undefined,
    unit: interaction.options.getString('unit') ?? undefined,
  });

  let announceAt = melbourneToUtc(date, announce);
  if (!announceAt || announceAt.getTime() >= startAt.getTime()) announceAt = null;

  // Copied to the volume now, because the Discord link these arrive on
  // expires long before a sale scheduled for next week.
  const files = [];
  try {
    for (const n of ['image', 'image2', 'image3']) {
      const saved = await saveAttachment(interaction.options.getAttachment(n));
      if (saved) files.push(saved);
    }
  } catch (err) {
    await interaction.editReply({ content: `Could not save that image: ${err.message}` });
    return;
  }

  const existing = findPendingSaleAt(startAt.toISOString());
  const sale = existing
    ? addProductToSale(existing.id, product.id, files)
    : createScheduledSale({
      attachments: files,
      productIds: [product.id],
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      channelId: config.claimsChannelId,
      createdBy: interaction.user.id,
      announceAt: config.announceChannelId && announceAt ? announceAt.toISOString() : null,
      announceChannelId: announceAt ? config.announceChannelId : null,
      note: interaction.options.getString('note'),
      title: interaction.options.getString('title'),
    });

  const all = productsFor(sale);
  const startUnix = Math.floor(new Date(sale.start_at).getTime() / 1000);

  await interaction.editReply({
    content: `✅ **${isNew ? 'Created' : 'Updated'} ${product.name}** and `
      + `${existing ? 'added it to the sale already queued' : 'scheduled the sale'}.\n\n`
      + `**On that night:**\n${all.map((p) => `• ${p.display_name || p.name} — ${formatAud(p.price_cents)}/${p.unit || 'box'}, ${p.quantity_available} in stock`).join('\n')}\n\n`
      + (readAttachments(sale).length
        ? `🖼️ ${readAttachments(sale).length} image${readAttachments(sale).length === 1 ? '' : 's'} on both posts\n`
        : '')
      + (sale.announce_at ? `📣 Prices **${formatMelbourne(sale.announce_at)}** in <#${sale.announce_channel_id}>\n` : '')
      + `🔔 Opens **${formatMelbourne(sale.start_at)}** (<t:${startUnix}:R>)\n`
      + `🔒 Closes **${formatMelbourne(sale.end_at)}**, then 24h late claims at +${config.lateMarkupPercent}%\n\n`
      + (all.length > 1
        ? 'Two or more products, so the posts will tell people to name which one they want.'
        : 'One product, so the posts will just say **"claim 2x"**.')
      + '\n\nRun this again with the same date to add another product to the same night.',
  });
}

async function handleScheduleSale(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const names = ['product', 'product2', 'product3']
    .map((n) => interaction.options.getString(n))
    .filter(Boolean);

  const products = names.map((n) => findProductByName(n)).filter(Boolean);
  if (products.length !== names.length) {
    await interaction.reply({ content: 'One of those products does not exist. Pick from the list.', ephemeral: true });
    return;
  }

  const date = interaction.options.getString('date', true);
  const start = interaction.options.getString('start') || '20:00';
  const end = interaction.options.getString('end') || '00:00';
  const announce = interaction.options.getString('announce') || '19:00';
  const note = interaction.options.getString('note');
  const title = interaction.options.getString('title');

  const startAt = melbourneToUtc(date, start);
  let endAt = melbourneToUtc(date, end);
  if (!startAt || !endAt) {
    await interaction.reply({ content: 'Could not read those times. Pick them from the dropdowns.', ephemeral: true });
    return;
  }

  // Midnight is the next day, not four hours before the sale starts.
  if (endAt.getTime() <= startAt.getTime()) {
    const [y, m, d] = date.split('-').map(Number);
    const nextDay = new Date(Date.UTC(y, m - 1, d + 1));
    const iso = nextDay.toISOString().slice(0, 10);
    endAt = melbourneToUtc(iso, end);
  }

  if (endAt.getTime() <= Date.now()) {
    await interaction.reply({ content: 'That sale would already be over. Pick a later night.', ephemeral: true });
    return;
  }

  // Prices go out before the doors open, so it only makes sense earlier
  // on the same night.
  let announceAt = melbourneToUtc(date, announce);
  if (!announceAt || announceAt.getTime() >= startAt.getTime()) announceAt = null;
  const announceChannelId = config.announceChannelId || null;

  const sale = createScheduledSale({
    productIds: products.map((p) => p.id),
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    channelId: config.claimsChannelId,
    createdBy: interaction.user.id,
    announceAt: announceChannelId && announceAt ? announceAt.toISOString() : null,
    announceChannelId: announceAt ? announceChannelId : null,
    note,
    title,
  });

  const startUnix = Math.floor(startAt.getTime() / 1000);
  const soldOut = products.filter((p) => p.quantity_available <= 0);
  const noLongName = products.filter((p) => !p.display_name);

  await interaction.reply({
    content: `🗓️ **Sale scheduled**\n\n`
      + `${products.map((p) => `• ${p.name} — ${formatAud(p.price_cents)}, ${p.quantity_available} in stock`).join('\n')}\n\n`
      + (sale.announce_at
        ? `📣 Prices posted **${formatMelbourne(sale.announce_at)}** in <#${announceChannelId}>\n`
        : '📣 No price announcement. Set `ANNOUNCE_CHANNEL_ID` on Railway to turn it on.\n')
      + `🔔 Opens **${formatMelbourne(sale.start_at)}** (<t:${startUnix}:R>)\n`
      + `🔒 Closes **${formatMelbourne(sale.end_at)}**, then 24h late claims at +${config.lateMarkupPercent}%.\n\n`
      + 'The bot writes both posts itself. You do not need to be here.'
      + (soldOut.length
        ? `\n\n⚠️ **${soldOut.map((p) => p.name).join(', ')}** has no stock. Set it with \`/product stock\`.`
        : '')
      + (noLongName.length
        ? `\n\n💡 **${noLongName.map((p) => p.name).join(', ')}** has no long name, so the post will just say "${noLongName[0].name}". `
          + 'Set one with `/product describe`.'
        : ''),
    ephemeral: true,
  });
}

async function handleScheduledSales(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const sales = listUpcomingSales();
  if (!sales.length) {
    await interaction.reply({ content: 'No sales queued. Set one with `/schedulesale`.', ephemeral: true });
    return;
  }

  const lines = sales.map((s) => {
    const startUnix = Math.floor(new Date(s.start_at).getTime() / 1000);
    const names = productsFor(s).map((p) => p.name).join(', ') || 'products missing';
    const state = s.status === 'open' ? '🟢 **live now**' : `opens <t:${startUnix}:R>`;
    return `**${formatMelbourne(s.start_at)}** → ${formatMelbourne(s.end_at)} · ${state}\n> ${names}`;
  });

  await interaction.reply({
    content: `🗓️ **${sales.length} queued**\n\n${lines.join('\n\n')}`.slice(0, 1900),
    ephemeral: true,
  });
}

async function handleCancelSale(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const result = cancelScheduledSale(Number(interaction.options.getString('sale', true)));
  await interaction.reply({
    content: result.ok
      ? `Cancelled the sale set for **${formatMelbourne(result.sale.start_at)}**.`
      + (result.sale.status === 'open' ? '\n⚠️ It was already live — run `/endsale` to close it properly.' : '')
      : 'That sale has already finished or been cancelled.',
    ephemeral: true,
  });
}

async function handleBackfillBuyers(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const ids = getAllPayingBuyerIds().filter((id) => !id.startsWith('ext:'));
  if (!ids.length) {
    await interaction.editReply({ content: 'Nobody has been marked paid yet.' });
    return;
  }

  await interaction.editReply({
    content: `Working through **${ids.length}** past buyers… this takes about `
      + `${Math.ceil(ids.length / 4)} seconds.`,
  });

  const result = await backfillBuyerRole(interaction.client, ids, async (progress) => {
    await interaction.editReply({
      content: `Working through **${ids.length}** past buyers…\n`
        + `🏅 ${progress.granted} given so far.`,
    }).catch(() => {});
  });

  if (!result.ok) {
    const why = {
      no_role: `No role called **${result.roleName}** in this server. Rename it or set \`BUYER_ROLE_ID\`.`,
      no_permission: 'The bot is missing **Manage Roles**.',
      role_too_high: `The bot's own role sits **below** **${result.roleName}**. `
        + "Drag the bot's role above it in Server Settings → Roles.",
    }[result.reason] || 'Could not run the backfill.';
    await interaction.editReply({ content: `⚠️ ${why}` });
    return;
  }

  await interaction.editReply({
    content: `🏅 **Backfill done** — role **${result.roleName}**\n\n`
      + `• **${result.granted}** given the role just now\n`
      + `• ${result.already} already had it\n`
      + `• ${result.gone} have left the server\n`
      + (result.failed ? `• ⚠️ ${result.failed} failed — check the Railway logs\n` : '')
      + `\nFrom **${ids.length}** people who have ever paid.`,
  });
}

async function handleLogSale(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const productName = interaction.options.getString('product', true);
  const product = findProductByName(productName);
  if (!product) {
    await interaction.editReply({ content: `No product called \`${productName}\`. Pick one from the list.` });
    return;
  }

  const user = interaction.options.getUser('user');
  const name = interaction.options.getString('name');
  if (!user && !name) {
    await interaction.editReply({ content: 'Give me either a Discord user or a name — the label needs one.' });
    return;
  }

  const quantity = interaction.options.getInteger('quantity', true);
  const totalCents = Math.round(interaction.options.getNumber('total', true) * 100);
  const shippingCents = Math.round((interaction.options.getNumber('shipping') ?? 0) * 100);

  const result = logManualOrder({
    product,
    quantity,
    totalCents,
    shippingCents,
    source: interaction.options.getString('source', true),
    discordId: user?.id || null,
    name: name || user?.globalName || user?.username || null,
    phone: interaction.options.getString('phone'),
    address: interaction.options.getString('address'),
    city: interaction.options.getString('suburb'),
    state: interaction.options.getString('state'),
    zip: interaction.options.getString('postcode'),
  });

  if (!result.ok) {
    await interaction.editReply({ content: `Could not log that: \`${result.reason}\`.` });
    return;
  }

  const order = result.order;
  pushToSheetInBackground([order], 'logsale');
  await grantBuyerRole(interaction.client, order.buyer_id);

  const buyer = getBuyer(order.buyer_id);
  const missing = ['shipping_address', 'city', 'state', 'zip'].filter((f) => !buyer?.[f]);

  await interaction.editReply({
    content: `✅ Logged **${order.reference_code}** — ${quantity}x ${product.name}, `
      + `${formatAud(totalCents)}, marked paid.\n`
      + 'It is on the Labels tab and in the Sales sheet now.\n'
      + (missing.length
        ? `\n⚠️ No address yet, so no label will print. Run this again with the address fields, or ask them for it.`
        : `\n📦 Shipping to ${buyer.name}, ${buyer.city} ${buyer.state} ${buyer.zip}.`),
  });
}

async function handleSources(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const rows = getTotalsBySource();
  if (!rows.length) {
    await interaction.reply({ content: 'No sales recorded yet.', ephemeral: true });
    return;
  }

  const label = {
    claim: 'Claim sales', facebook: 'Facebook', wholesale: 'Wholesale',
    dm: 'Discord DM', instagram: 'Instagram', in_person: 'In person', other: 'Other', late: 'Late orders',
  };
  const total = rows.reduce((n, r) => n + r.revenue_cents, 0);
  const lines = rows.map((r) => {
    const share = total ? Math.round((r.revenue_cents / total) * 100) : 0;
    return `**${label[r.source] || r.source}** — ${formatAud(r.revenue_cents)} · ${r.boxes} boxes · ${share}%`;
  });

  await interaction.reply({
    content: `💰 **Where the money came from**\n\n${lines.join('\n')}\n\n**Total ${formatAud(total)}**`,
    ephemeral: true,
  });
}

async function handleSchedule(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const content = interaction.options.getString('message', true);
  const date = interaction.options.getString('date', true);
  const time = interaction.options.getString('time', true);
  const channel = interaction.options.getChannel('channel') || interaction.channel;
  const repeat = interaction.options.getString('repeat');

  const when = melbourneToUtc(date, time);
  if (!when || Number.isNaN(when.getTime())) {
    await interaction.reply({
      content: 'Could not read that date and time. Pick both from the dropdowns.',
      ephemeral: true,
    });
    return;
  }

  if (when.getTime() <= Date.now()) {
    await interaction.reply({
      content: `${formatMelbourne(when.toISOString())} is in the past. Pick a later time.`,
      ephemeral: true,
    });
    return;
  }

  if (!channel.isTextBased?.()) {
    await interaction.reply({ content: 'Pick a text channel.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Copied to the volume now rather than linked, because the Discord URL
  // these arrive on expires long before a post scheduled for next week.
  const files = [];
  try {
    for (const name of ['image', 'image2', 'image3']) {
      const saved = await saveAttachment(interaction.options.getAttachment(name));
      if (saved) files.push(saved);
    }
  } catch (err) {
    await interaction.editReply({ content: `Could not save that attachment: ${err.message}` });
    return;
  }

  const row = scheduleMessage({
    channelId: channel.id,
    content,
    sendAt: when.toISOString(),
    repeatEvery: repeat,
    createdBy: interaction.user.id,
    attachments: files,
  });

  const unix = Math.floor(when.getTime() / 1000);
  const pings = /@everyone|@here/.test(content);

  await interaction.editReply({
    content: `🕒 Scheduled for **${formatMelbourne(row.send_at)}** (<t:${unix}:R>) in ${channel}.\n`
      + (files.length ? `📎 ${files.length} attachment${files.length === 1 ? '' : 's'} saved.\n` : '')
      + (repeat ? `Repeats **${repeat === 'daily' ? 'every day' : 'every week'}** at that time.\n` : '')
      + (pings ? '⚠️ This pings the server. The bot needs **Mention Everyone** in that channel.\n' : '')
      + `\n> ${content.replace(/\n/g, '\n> ').slice(0, 600)}`,
  });
}

async function handleEvent(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const title = interaction.options.getString('title', true);
  const date = interaction.options.getString('date', true);
  const time = interaction.options.getString('time', true);
  const hours = interaction.options.getInteger('hours') ?? 4;
  const where = interaction.options.getString('where') || 'Discord';
  const details = interaction.options.getString('details');
  const image = interaction.options.getAttachment('image');

  const start = melbourneToUtc(date, time);

  // Deferred because the cover picture has to be fetched and uploaded again,
  // which on a big image is slower than Discord's three second reply window.
  await interaction.deferReply({ ephemeral: true });

  const result = await createScheduledEvent(interaction.guild, {
    title, start, hours, where, details, image,
  });

  if (!result.ok) {
    await interaction.editReply({ content: result.reason });
    return;
  }

  const startUnix = Math.floor(start.getTime() / 1000);

  await interaction.editReply({
    content: `📅 **${title}** is up.\n`
      + `Starts **${formatMelbourne(start.toISOString())}** (<t:${startUnix}:R>), `
      + `runs ${hours} hour${hours === 1 ? '' : 's'} until **${formatMelbourne(result.end.toISOString())}**.\n`
      + (result.imageSkipped ? '⚠️ Could not fetch that picture, so it has no cover image.\n' : '')
      + `\n${eventUrl(interaction.guild.id, result.event.id)}\n`
      + '\nIt now shows at the top of the server. Edit or delete it there.',
  });
}

async function handleScheduled(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const rows = listPending();
  if (!rows.length) {
    await interaction.reply({ content: 'Nothing queued.', ephemeral: true });
    return;
  }

  const lines = rows.slice(0, 20).map((r) => {
    const unix = Math.floor(new Date(r.send_at).getTime() / 1000);
    const repeat = r.repeat_every ? ` · repeats ${r.repeat_every}` : '';
    const pics = readAttachments(r).length;
    const media = pics ? ` · 📎 ${pics}` : '';
    return `**${formatMelbourne(r.send_at)}** (<t:${unix}:R>) in <#${r.channel_id}>${repeat}${media}\n`
      + `> ${r.content.replace(/\s+/g, ' ').slice(0, 90)}`;
  });

  await interaction.reply({
    content: `🕒 **${rows.length} queued**\n\n${lines.join('\n\n')}`.slice(0, 1900),
    ephemeral: true,
  });
}

async function handleUnschedule(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const id = Number(interaction.options.getString('message', true));
  const result = cancelScheduled(id);
  if (result.ok) cleanupAttachments(result.row);
  await interaction.reply({
    content: result.ok
      ? `Cancelled the message set for **${formatMelbourne(result.row.send_at)}**.`
      : 'That one has already been sent or cancelled.',
    ephemeral: true,
  });
}

async function handleClaimed(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const wanted = interaction.options.getString('product');

  // Hours rather than calendar days on purpose: the bot runs on UTC and a
  // sale that starts at 8pm Melbourne is already tomorrow there, so
  // "today" would quietly mean the wrong thing.
  const hours = interaction.options.getInteger('since');
  const sinceIso = hours ? new Date(Date.now() - hours * 3600000).toISOString() : null;
  const window = hours ? ` claimed in the last **${hours < 24 ? `${hours}h` : `${hours / 24} days`}**` : '';

  if (wanted) {
    const rows = getClaimsForProduct(wanted, sinceIso);
    if (!rows.length) {
      await interaction.editReply({ content: `Nothing claimed for \`${wanted}\`.` });
      return;
    }
    const total = rows.reduce((n, r) => n + r.quantity, 0);
    const unpaid = rows.filter((r) => r.status === 'pending');
    // Dates, because the same product sells in more than one wave and the
    // name alone cannot tell an order from last month apart from tonight's.
    const lines = rows.map((r) => {
      const name = getBuyer(r.buyer_id)?.name || `<@${r.buyer_id}>`;
      const when = r.claimed_at ? r.claimed_at.slice(0, 10) : 'unknown date';
      return `${r.status === 'pending' ? '⏳' : '✅'} \`${when}\`  ${name} — **${r.quantity}**`;
    });

    // Claims more than a week apart are almost certainly separate waves,
    // and the older one is usually something that shipped but was never
    // marked shipped.
    const dates = rows.map((r) => r.claimed_at).filter(Boolean).sort();
    const spanDays = dates.length
      ? (new Date(dates[dates.length - 1]) - new Date(dates[0])) / 86400000
      : 0;
    const waveWarning = spanDays > 7
      ? `\n\n⚠️ These claims span **${Math.round(spanDays)} days**, so there is more than one wave here. `
        + 'Anything from the older batch that has already been posted needs `/shipped`, '
        + 'or it will keep showing up on the Labels tab.'
      : '';
    await interaction.editReply({
      content: `**${rows[0].product_name}** — order **${total}**${window}\n`
        + `${unpaid.length} buyer${unpaid.length === 1 ? '' : 's'} still to pay.\n\n`
        + lines.join('\n').slice(0, 1500)
        + waveWarning,
    });
    return;
  }

  const totals = getClaimedTotals(sinceIso);
  if (!totals.length) {
    await interaction.editReply({
      content: hours ? `Nothing claimed in the last ${hours} hours.` : 'Nothing claimed at the moment.',
    });
    return;
  }

  const lines = totals.map((t) => (
    `**${t.product_name}** — order **${t.total}**`
    + `  _(${t.paid} paid, ${t.pending} awaiting payment, ${t.buyers} buyers)_`
  ));
  const grand = totals.reduce((n, t) => n + t.total, 0);

  // Anything old in here is almost always an order that was posted but
  // never marked shipped, so say how old the oldest one is rather than
  // letting it quietly inflate a supplier order.
  const oldest = totals.map((t) => t.oldest).filter(Boolean).sort()[0];
  const ageDays = oldest ? (Date.now() - new Date(oldest).getTime()) / 86400000 : 0;
  const warning = !hours && ageDays > 2
    ? `\n\n⚠️ The oldest claim here is **${Math.floor(ageDays)} days** old. `
      + 'If that batch has already been posted, mark it shipped or it inflates this total. '
      + 'Use `since` to count one sale only.'
    : '';

  await interaction.editReply({
    content: `📋 **To order from the supplier**${window}\n\n${lines.join('\n')}\n\n`
      + `**${grand}** boxes in total. Pending claims are included — a spare box is cheaper than cancelling on someone.`
      + warning,
  });
}

async function handleExport(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const includeAll = interaction.options.getBoolean('all') ?? false;
  const result = buildLabelExportCsv(includeAll);
  if (!result) {
    await interaction.reply({ content: 'No paid orders waiting to be exported.', ephemeral: true });
    return;
  }

  const attachment = new AttachmentBuilder(Buffer.from(result.csv, 'utf-8'), {
    name: `labels-${new Date().toISOString().slice(0, 10)}${includeAll ? '-full' : ''}.csv`,
  });

  const note = includeAll
    ? ` This includes every paid order, even ones already exported before — watch for duplicate labels if you already printed some of these.`
    : ` These won't be included if you run \`/export\` again.`;

  await interaction.reply({
    content: `📦 Exported **${result.count}** order${result.count === 1 ? '' : 's'} — upload this to the label printer app.${note}`,
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
    case 'tracking':
      return handleTracking(interaction);
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
    case 'newsale':
      return handleNewSale(interaction);
    case 'schedulesale':
      return handleScheduleSale(interaction);
    case 'scheduledsales':
      return handleScheduledSales(interaction);
    case 'cancelsale':
      return handleCancelSale(interaction);
    case 'backfillbuyers':
      return handleBackfillBuyers(interaction);
    case 'logsale':
      return handleLogSale(interaction);
    case 'sources':
      return handleSources(interaction);
    case 'schedule':
      return handleSchedule(interaction);
    case 'scheduled':
      return handleScheduled(interaction);
    case 'unschedule':
      return handleUnschedule(interaction);
    case 'event':
      return handleEvent(interaction);
    case 'claimed':
      return handleClaimed(interaction);
    case 'giveaway':
      return handleGiveaway(interaction);
    case 'entries':
      return handleEntries(interaction);
    case 'shipall':
      return handleShipAll(interaction);
    case 'unship':
      return handleUnship(interaction);
    case 'sync':
      return handleSync(interaction);
    default:
      await interaction.reply({ content: 'Unknown command.', ephemeral: true });
  }
}

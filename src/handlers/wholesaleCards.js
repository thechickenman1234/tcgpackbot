import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { config } from '../config.js';
import { isStaff } from '../utils/permissions.js';
import { getMeta, setMeta } from '../services/metaService.js';
import { ZONE } from '../services/scheduleService.js';
import { loadPrices, matchTyped, MIN_BOXES, parseCartText, REGION_NAMES } from '../services/wholesalePrices.js';
import { findConversation, sendDm, zernioReady } from '../services/zernioService.js';
import {
  cancelWholesaleOrder, createWholesaleOrder, findRecentDuplicate, getWholesaleOrder, instructionsMessage, isComplete,
  markAsked, markQuoted, markSupplierOrdered, markWholesalePaid, noteError, openWholesaleOrders, orderCode,
  quoteLinkMessage, quoteText, quoteUrl, recordSupplierReply, setCardLocation, setLines, setShipping, summarise,
  supplierAskText, supplierOrderText,
} from '../services/wholesaleOrders.js';

/**
 * The staff side of wholesale orders: one card per order, with a button for
 * each step. A complete order (everything priced, over the minimum) asks the
 * supplier for shipping by itself; nothing else reaches a shop or the
 * supplier without a tap here, and when a DM can't go the text comes back to
 * paste into Instagram, WhatsApp or an email by hand.
 *
 * Cards hold customers' phone numbers and the supplier's name, so they only
 * ever go to a private channel: WHOLESALE_CHANNEL_ID, else a channel with
 * "wholesale" in its name that @everyone can't see, else the staff log.
 */

export const WS_PREFIX = 'ws:';
const SUPPLIER_CHAT_KEY = 'wholesale_supplier_chat';
const AUTO_ASKS_KEY = 'wholesale_auto_asks';
export const CONTACT_NAMES = {
  instagram: 'Instagram', whatsapp: 'WhatsApp', email: 'email', phone: 'phone or text', messenger: 'Messenger', discord: 'Discord',
};
const dollars = (n) => `$${Math.round(n).toLocaleString('en-AU')}`;

function isPrivate(channel) {
  const everyone = channel.guild?.roles?.everyone;
  const perms = everyone && channel.permissionsFor?.(everyone);
  return Boolean(perms) && !perms.has(PermissionFlagsBits.ViewChannel);
}

async function cardChannel(client) {
  if (config.wholesaleChannelId) {
    const byId = await client.channels.fetch(config.wholesaleChannelId).catch(() => null);
    if (byId?.isTextBased?.()) return byId;
  }
  const guild = await client.guilds.fetch(config.guildId).catch(() => null);
  const named = guild
    ? [...(await guild.channels.fetch()).values()].find((c) => c?.isTextBased?.() && /wholesale/i.test(c.name) && isPrivate(c))
    : null;
  return named || client.channels.fetch(config.staffLogChannelId);
}

const STATUS = {
  new: '🆕 New: ask the supplier for shipping, or set it yourself',
  asked: '⏳ Supplier asked for shipping: waiting on their reply',
  quoted: '📨 Quote sent: waiting for them to pay',
  paid: '✅ Paid and recorded as a sale',
  cancelled: '✖️ Cancelled',
};

export function buildCard(order) {
  const s = summarise(order);
  const who = [order.customer_name, order.business, order.customer_username ? `@${order.customer_username}` : null]
    .filter(Boolean).filter((v, i, all) => all.indexOf(v) === i).join(' · ');
  const lines = [];
  if (order.source === 'website') {
    lines.push(`🌐 Sent from the price page · reach them by **${CONTACT_NAMES[order.contact_method] || order.contact_method}**: ${order.contact_value}`);
    if (order.notes) lines.push(`📝 “${order.notes.slice(0, 300)}”`);
    lines.push('');
  }
  for (const r of ['jp', 'cn']) {
    if (!s[r].lines.length) continue;
    lines.push(`**${REGION_NAMES[r]}** · ${s[r].boxes} boxes, ${s[r].tierLabel} pricing`);
    for (const l of s[r].lines) {
      lines.push(l.price == null
        ? `${l.qty}x ${l.name}: ⚠️ no price on the sheet today`
        : `${l.qty}x ${l.name} @ ${dollars(l.price)} = **${dollars(l.total)}**`);
    }
    lines.push('');
  }
  lines.push(`**Boxes ${dollars(s.boxes)}**`);
  if (s.shipping != null) lines.push(`**Shipping ${dollars(s.shipping)}**`, `**Total ${dollars(s.total)} AUD**`);
  else if (order.shipping_guess_cents != null) lines.push(`Shipping: the supplier's reply reads as about **${dollars(order.shipping_guess_cents / 100)}**. Check it, then **Set shipping**.`);
  else lines.push('Shipping: not quoted yet');
  if (order.supplier_reply) lines.push('', `🚚 Supplier said: “${order.supplier_reply.slice(-300)}”`);
  const warnings = [
    ...order.unmatched.map((u) => `Couldn't price “${u}”. Fix it with **Edit boxes**.`),
    ...s.short.map((r) => `Under the ${REGION_NAMES[r]} minimum of ${MIN_BOXES} boxes.`),
  ];
  if (warnings.length) lines.push('', ...warnings.map((w) => `⚠️ ${w}`));
  if (order.last_error) lines.push('', `❗ ${order.last_error}`);

  const embeds = [new EmbedBuilder()
    .setTitle(`📦 ${orderCode(order)}${who ? ` · ${who}` : ''}`.slice(0, 256))
    .setColor({ new: 0x3498db, asked: 0xf1c40f, quoted: 0xe67e22, paid: 0x27ae60, cancelled: 0x7f8c8d }[order.status])
    .setDescription(lines.join('\n').slice(0, 4000))
    .addFields({ name: 'Status', value: STATUS[order.status] })];
  if (['new', 'asked', 'quoted'].includes(order.status) && s.shipping != null) {
    const offInstagram = order.source === 'website' && order.contact_method !== 'instagram';
    embeds.push(new EmbedBuilder()
      .setTitle(offInstagram ? 'What you send them when you tap Send quote' : 'What the shop gets when you tap Send quote')
      .setColor(0x95a5a6)
      .setDescription((offInstagram ? quoteLinkMessage(order) : quoteText(order)).slice(0, 4000)));
  }

  const b = (action, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder()
    .setCustomId(`${WS_PREFIX}${action}:${order.id}`).setLabel(label).setStyle(style).setDisabled(disabled);
  const rows = [];
  if (['new', 'asked', 'quoted'].includes(order.status)) {
    rows.push(new ActionRowBuilder().addComponents(
      b('ask', order.asked_at ? 'Ask supplier again' : 'Ask supplier for shipping', ButtonStyle.Primary),
      b('ship', 'Set shipping'),
      b('send', order.status === 'quoted' ? 'Send quote again' : 'Send quote', ButtonStyle.Success, s.shipping == null),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      b('paid', 'Paid', ButtonStyle.Success, order.status !== 'quoted'),
      b('edit', 'Edit boxes'),
      b('cancel', 'Cancel', ButtonStyle.Danger),
    ));
  } else if (order.status === 'paid' && !order.supplier_ordered_at) {
    rows.push(new ActionRowBuilder().addComponents(b('order', 'Order from supplier', ButtonStyle.Primary)));
  }
  return { embeds, components: rows };
}

/** Posts the card; `ping` tells staff when a shop sent it (not when Lachy made it). */
export async function postCard(client, order, { ping = null } = {}) {
  const channel = await cardChannel(client);
  const message = await channel.send({
    content: ping && config.staffRoleId ? `<@&${config.staffRoleId}> ${ping}` : undefined,
    ...buildCard(order),
    allowedMentions: { roles: ping && config.staffRoleId ? [config.staffRoleId] : [] },
  });
  setCardLocation(order.id, channel.id, message.id);
  return message;
}

async function refreshCard(client, order) {
  if (!order.card_channel_id || !order.card_message_id) return;
  try {
    const channel = await client.channels.fetch(order.card_channel_id);
    const message = await channel.messages.fetch(order.card_message_id);
    await message.edit(buildCard(order));
  } catch (err) {
    console.error(`Wholesale card ${orderCode(order)} refresh failed:`, err.message);
  }
}

async function supplierChat() {
  const saved = getMeta(SUPPLIER_CHAT_KEY);
  if (saved) return saved;
  const convo = await findConversation(config.wholesaleSupplier).catch(() => null);
  if (convo) setMeta(SUPPLIER_CHAT_KEY, convo.id);
  return convo?.id || null;
}

const melbourneDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function autoAsksToday() {
  try {
    const saved = JSON.parse(getMeta(AUTO_ASKS_KEY) || '{}');
    return saved.day === melbourneDay() ? saved.n : 0;
  } catch {
    return 0;
  }
}

/**
 * Asks the supplier for shipping without waiting for a tap, so a shop's
 * order is already being quoted before Lachy sees it. Only for complete
 * orders, only inside Instagram's 24 hours, and at most
 * WHOLESALE_AUTO_ASKS_PER_DAY a day: a form anyone can fill in must never be
 * able to flood the supplier. When it can't, the card says why and the
 * Ask supplier button does it.
 */
export async function autoAskSupplier(client, order) {
  if (!isComplete(order)) return order;
  let updated = order;
  let reason = null;
  if (!zernioReady()) reason = 'The bot can\'t ask the supplier by itself until ZERNIO_API_KEY is on Railway.';
  else if (autoAsksToday() >= config.wholesaleAutoAsksPerDay) reason = `Already asked the supplier ${config.wholesaleAutoAsksPerDay} times by itself today.`;
  else {
    const chat = await supplierChat();
    if (!chat) reason = `There's no chat with @${config.wholesaleSupplier} on @tcgpackbot for the bot to use yet.`;
    else {
      const result = await sendDm(chat, supplierAskText(order));
      if (result.ok) {
        setMeta(AUTO_ASKS_KEY, JSON.stringify({ day: melbourneDay(), n: autoAsksToday() + 1 }));
        updated = markAsked(order.id);
      } else reason = `Couldn't ask the supplier by itself: ${result.error}.`;
    }
  }
  if (reason) updated = noteError(order.id, `${reason} Tap **Ask supplier for shipping** for the text.`);
  await refreshCard(client, updated);
  return updated;
}

/** Sends, or hands the text back to copy when it can't. */
async function sendOrHandBack(interaction, conversationId, text, who, options = {}) {
  const result = await sendDm(conversationId, text, options);
  if (result.ok) return true;
  await interaction.followUp({
    content: `Couldn't send it to ${who}: ${result.error}\nCopy this into Instagram yourself:\n\`\`\`\n${text.slice(0, 1700)}\n\`\`\``,
    ephemeral: true,
  });
  return false;
}

function linesForEditing(order) {
  return order.lines.map((l) => `${l.qty} ${l.region} ${l.name}${l.spec && l.spec !== 'Sealed box' ? ` ${l.spec}` : ''}`
    + (l.override != null ? ` @ ${l.override}` : '')).join('\n');
}

/** ws:<action>:<id> */
export async function handleWholesaleButton(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const [, action, idText] = interaction.customId.split(':');
  const order = getWholesaleOrder(idText);
  if (!order) {
    await interaction.reply({ content: 'That order is gone.', ephemeral: true });
    return;
  }
  const code = orderCode(order);

  if (action === 'ship') {
    const guess = order.shipping_cents ?? order.shipping_guess_cents;
    await interaction.showModal(new ModalBuilder().setCustomId(`${WS_PREFIX}m:ship:${order.id}`).setTitle(`${code}: shipping`)
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount')
        .setLabel('Shipping to charge the shop, in AUD').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)
        .setValue(guess != null ? String(Math.round(guess / 100)) : ''))));
    return;
  }
  if (action === 'edit') {
    await interaction.showModal(new ModalBuilder().setCustomId(`${WS_PREFIX}m:edit:${order.id}`).setTitle(`${code}: boxes`)
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('lines')
        .setLabel('One per line: how many, jp or cn, the set').setStyle(TextInputStyle.Paragraph).setRequired(true)
        .setMaxLength(1500).setValue(linesForEditing(order).slice(0, 1500)))));
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  let updated = order;
  if (action === 'ask') {
    const chat = await supplierChat();
    const sent = chat ? await sendOrHandBack(interaction, chat, supplierAskText(order), `@${config.wholesaleSupplier}`) : false;
    if (!chat) {
      await interaction.followUp({
        content: `There's no chat with @${config.wholesaleSupplier} on @tcgpackbot yet, or the bot can't see it. `
          + 'Send this from @tcgpackbot in the Instagram app; their reply comes back here by itself.\n'
          + `\`\`\`\n${supplierAskText(order)}\n\`\`\``,
        ephemeral: true,
      });
    }
    updated = markAsked(order.id);
    await interaction.editReply(sent ? `Asked @${config.wholesaleSupplier} for shipping on ${code}. Their reply shows on the card.` : `Marked ${code} as asked.`);
  } else if (action === 'send') {
    // A shop that wanted to hear back somewhere other than Instagram gets its
    // quote page's link to paste there; the page has everything else.
    if (order.source === 'website' && order.contact_method !== 'instagram') {
      updated = markQuoted(order.id);
      await interaction.editReply(`${code} is marked quoted. Send this to ${order.customer_name || 'them'} by `
        + `**${CONTACT_NAMES[order.contact_method] || order.contact_method}** (${order.contact_value}):\n\`\`\`\n${quoteLinkMessage(order)}\n\`\`\``);
    } else {
      let chat = order.conversation_id;
      if (!chat && order.customer_username) chat = (await findConversation(order.customer_username).catch(() => null))?.id || null;
      const sent = await sendOrHandBack(interaction, chat, quoteText(order), order.customer_username ? `@${order.customer_username}` : 'the shop', { humanAgent: true });
      // Marked quoted either way: when it didn't send, the text came back to send by hand.
      updated = markQuoted(order.id);
      if (!sent) updated = noteError(order.id, 'The quote didn\'t go through Instagram, so it was handed back to send by hand.');
      await interaction.editReply(sent ? `Quote for ${code} sent on Instagram.` : `${code} is marked quoted. Send the text above yourself.`);
    }
  } else if (action === 'paid') {
    const result = markWholesalePaid(order.id);
    if (result.error) {
      await interaction.editReply(result.error);
      return;
    }
    updated = result.order;
    await interaction.editReply(`${code} is paid. ${dollars(summarise(updated).boxes)} of boxes recorded as wholesale sales. Tap **Order from supplier** when you're ready.`);
  } else if (action === 'order') {
    const chat = await supplierChat();
    const sent = await sendOrHandBack(interaction, chat, supplierOrderText(order), `@${config.wholesaleSupplier}`);
    updated = markSupplierOrdered(order.id);
    await interaction.editReply(sent ? `Ordered ${code} from @${config.wholesaleSupplier}.` : `Marked ${code} as ordered. Send the text above yourself.`);
  } else if (action === 'cancel') {
    updated = cancelWholesaleOrder(order.id);
    await interaction.editReply(`${code} cancelled. Nothing was sent.`);
  } else {
    await interaction.editReply('Unknown button.');
    return;
  }
  await refreshCard(interaction.client, updated);
}

/** ws:m:<ship|edit>:<id> */
export async function handleWholesaleModal(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const [, , kind, idText] = interaction.customId.split(':');
  const order = getWholesaleOrder(idText);
  if (!order) {
    await interaction.reply({ content: 'That order is gone.', ephemeral: true });
    return;
  }
  let updated;
  if (kind === 'ship') {
    const amount = Number(String(interaction.fields.getTextInputValue('amount')).replace(/[$,\s]/g, ''));
    if (!(amount >= 0)) {
      await interaction.reply({ content: 'Type the shipping as a number, like 186.', ephemeral: true });
      return;
    }
    updated = setShipping(order.id, Math.round(amount * 100));
    await interaction.reply({ content: `Shipping on ${orderCode(order)} set to ${dollars(amount)}. Check the quote on the card, then **Send quote**.`, ephemeral: true });
  } else {
    await interaction.deferReply({ ephemeral: true });
    const { lines, unmatched } = matchTyped(interaction.fields.getTextInputValue('lines'), await loadPrices());
    if (!lines.length) {
      await interaction.editReply(`None of those matched a set on today's sheet: ${unmatched.join('; ').slice(0, 1500)}`);
      return;
    }
    updated = await setLines(order.id, lines, unmatched);
    await interaction.editReply(`Updated ${orderCode(order)}: ${lines.length} line${lines.length === 1 ? '' : 's'}${unmatched.length ? `, couldn't match ${unmatched.length}` : ''}.`);
  }
  await refreshCard(interaction.client, updated);
}

/** An order typed by hand: /wholesale new, or the ops door. */
export async function startOrderFromText(client, { username, items, name = null }) {
  const { lines, unmatched } = matchTyped(items, await loadPrices());
  if (!lines.length) return { error: `None of those matched a set on today's sheet: ${unmatched.join('; ')}` };
  const convo = username ? await findConversation(username).catch(() => null) : null;
  const order = await createWholesaleOrder({
    conversationId: convo?.id || null,
    username,
    name: name || convo?.participantName || null,
    lines,
    unmatched,
    sourceText: items,
    source: 'manual',
  });
  const message = await postCard(client, order);
  const asked = await autoAskSupplier(client, order);
  return { ok: true, order: asked, url: message.url, foundChat: Boolean(convo) };
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);

/**
 * Send order on the wholesale price page. The page's own prices are never
 * trusted: the order is priced again from today's sheet. Returns
 * { ok, code, quoteUrl } or { error } in words a shop can act on.
 */
export async function startOrderFromWebsite(client, body = {}) {
  // The hidden field only a bot fills in: pretend it worked, do nothing.
  if (clean(body.website, 200)) return { ok: true, ignored: true };
  const name = clean(body.name, 80);
  const business = clean(body.business, 80);
  const method = clean(body.contactMethod, 20).toLowerCase();
  const contact = clean(body.contact, 120);
  const notes = clean(String(body.notes ?? '').replace(/\r/g, ''), 1000);
  if (!name) return { error: 'Please add your name.' };
  if (!CONTACT_NAMES[method]) return { error: 'Pick how we should get back to you.' };
  if (!contact) return { error: `Add your ${CONTACT_NAMES[method]} details so we can send your quote.` };
  if (method === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact)) return { error: 'That email address doesn\'t look right.' };
  if (['whatsapp', 'phone'].includes(method) && contact.replace(/\D/g, '').length < 8) return { error: 'That number looks too short.' };

  const wanted = (Array.isArray(body.items) ? body.items : []).slice(0, 80).map((i) => ({
    region: i?.region === 'jp' || i?.region === 'cn' ? i.region : null,
    name: clean(i?.name, 120),
    spec: clean(i?.spec, 120) || 'Sealed box',
    qty: Math.floor(Number(i?.qty)),
  })).filter((l) => l.region && l.name && l.qty >= 1 && l.qty <= 500);
  if (!wanted.length) return { error: 'Your order is empty. Add some boxes first.' };

  const data = await loadPrices();
  const lines = [];
  const unmatched = [];
  for (const l of wanted) {
    const onSheet = data[l.region].find((p) => p.name === l.name && p.spec === l.spec);
    if (onSheet?.prices) lines.push(l);
    else unmatched.push(`${l.qty}x ${l.name} (not priced on today's sheet)`);
  }
  if (!lines.length) return { error: 'None of those sets are priced today. Message us and we\'ll quote them.' };
  for (const r of ['jp', 'cn']) {
    const boxes = lines.filter((l) => l.region === r).reduce((t, l) => t + l.qty, 0);
    if (boxes > 0 && boxes < MIN_BOXES) return { error: `The minimum is ${MIN_BOXES} ${REGION_NAMES[r]} boxes. You have ${boxes}.` };
  }

  const again = findRecentDuplicate({ contactValue: contact, lines });
  if (again) return { ok: true, code: orderCode(again), quoteUrl: quoteUrl(again), contactMethod: method, duplicate: true };

  const username = method === 'instagram' ? contact.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[/?].*$/, '') : null;
  const convo = username ? await findConversation(username).catch(() => null) : null;
  const order = await createWholesaleOrder({
    conversationId: convo?.id || null,
    username,
    name,
    business,
    contactMethod: method,
    contactValue: contact,
    notes,
    lines,
    unmatched,
    source: 'website',
  });
  // The order is saved either way; a Discord hiccup mustn't tell the shop it failed
  // (they'd send it again). /wholesale list still shows it.
  try {
    await postCard(client, order, { ping: `📦 New wholesale order from the price page: **${name}**${business ? ` (${business})` : ''}, ${dollars(order.boxes_cents / 100)} of boxes.` });
    await autoAskSupplier(client, order);
  } catch (err) {
    console.error(`Wholesale ${orderCode(order)} card or supplier ask failed:`, err);
  }
  return { ok: true, code: orderCode(order), quoteUrl: quoteUrl(order), contactMethod: method };
}

const FORM_TITLES = { wholesale: '📨 Wholesale enquiry', contact: '📩 Contact form', 'host-a-machine': '🎰 Host a machine' };
const FORM_FIELDS = {
  wholesale: [['business', 'Business'], ['type', 'After'], ['products', 'Products'], ['phone', 'Phone'], ['email', 'Email']],
  contact: [['phone', 'Phone'], ['email', 'Email'], ['message', 'Message']],
  'host-a-machine': [['business', 'Business'], ['location', 'Location'], ['traffic', 'Foot traffic'], ['phone', 'Phone'], ['email', 'Email'], ['notes', 'Notes']],
};
const WHOLESALE_TYPES = { shop: 'Shop restock', streamer: 'Streamer / content', other: 'Something else' };

/**
 * A website form (passed on by the site's Netlify function), as a staff
 * alert. A wholesale enquiry comes with the how-to-order reply ready to
 * paste, since the price page's Send order is the quickest way to an order.
 */
export async function postFormAlert(client, { form, data = {} }) {
  const kind = FORM_TITLES[form] ? form : 'contact';
  const value = (k) => {
    const v = clean(data[k], 1000);
    return kind === 'wholesale' && k === 'type' ? (WHOLESALE_TYPES[v] || v) : v;
  };
  const name = value('name') || 'Someone';
  const fields = FORM_FIELDS[kind].filter(([k]) => value(k)).map(([k, label]) => ({
    name: label, value: value(k).slice(0, 1000), inline: ['phone', 'email', 'type'].includes(k),
  }));
  const embeds = [new EmbedBuilder().setTitle(`${FORM_TITLES[kind]}: ${name}`.slice(0, 256)).setColor(0xf5a623).addFields(fields).setTimestamp()];
  if (kind === 'wholesale') {
    embeds.push(new EmbedBuilder().setTitle('Reply ready to paste (text or email)').setColor(0x95a5a6)
      .setDescription(`\`\`\`\n${instructionsMessage(name)}\n\`\`\``));
  }
  const channel = kind === 'wholesale' ? await cardChannel(client) : await client.channels.fetch(config.staffLogChannelId);
  const ping = config.staffRoleId ? `<@&${config.staffRoleId}> ` : '';
  const reach = value('phone') ? `📞 ${value('phone')}` : value('email') ? `✉️ ${value('email')}` : '';
  await channel.send({
    content: `${ping}${FORM_TITLES[kind]} from **${name}**${value('business') ? ` (${value('business')})` : ''} ${reach}`.trim().slice(0, 1900),
    embeds,
    allowedMentions: { roles: config.staffRoleId ? [config.staffRoleId] : [] },
  });
}

function supplierNote(guess) {
  if (!guess) return '';
  const was = {
    AUD: '',
    CNY: ` (from ¥${guess.amount} in yuan)`,
    JPY: ` (from ¥${guess.amount} in yen)`,
    $: ` (from $${guess.amount}: check it's AUD)`,
    '?': ` (from ${guess.amount} with no currency: check it)`,
  }[guess.currency] ?? '';
  return `: reads as about **${dollars(guess.cents / 100)}**${was}`;
}

/**
 * A DM to @tcgpackbot, from Zernio's webhook. The supplier's replies fill in
 * shipping; a cart pasted from the wholesale price page becomes an order.
 * Everything else is left alone.
 */
export async function handleInstagramDm(client, payload) {
  if (payload?.event !== 'message.received') return null;
  const message = payload.message || {};
  if (message.platform !== 'instagram' || message.direction !== 'incoming') return null;
  const account = payload.account?.accountId || payload.account?.id;
  if (account && account !== config.zernioInstagramId) return null;
  const sender = message.sender || {};
  const username = String(sender.username || '').toLowerCase();
  const text = message.text || '';

  if (username && username === config.wholesaleSupplier) {
    setMeta(SUPPLIER_CHAT_KEY, message.conversationId || payload.conversation?.id);
    const result = recordSupplierReply(text);
    if (!result) return 'supplier, no open question';
    await refreshCard(client, result.order);
    const channel = await client.channels.fetch(result.order.card_channel_id).catch(() => null);
    await channel?.send({
      content: `🚚 @${config.wholesaleSupplier} replied about **${orderCode(result.order)}**${supplierNote(result.guess)}. Check it and tap **Set shipping** on the card.`,
      allowedMentions: { parse: [] },
    });
    return 'supplier reply';
  }

  const lines = parseCartText(text);
  if (!lines) return null;
  const order = await createWholesaleOrder({
    conversationId: message.conversationId || payload.conversation?.id,
    username: sender.username,
    name: sender.name,
    lines,
    sourceText: text,
  });
  await postCard(client, order, { ping: `📦 New wholesale order by Instagram DM from **${sender.name || `@${sender.username}`}**, ${dollars(order.boxes_cents / 100)} of boxes.` });
  await autoAskSupplier(client, order);
  return 'new order';
}

export async function handleWholesaleCommand(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const sub = interaction.options.getSubcommand();
  if (sub === 'new') {
    await interaction.deferReply({ ephemeral: true });
    const result = await startOrderFromText(interaction.client, {
      username: interaction.options.getString('instagram', true).trim().replace(/^@/, ''),
      items: interaction.options.getString('items', true),
    });
    await interaction.editReply(result.error || `📦 ${orderCode(result.order)} is up: ${result.url}`
      + (result.foundChat ? '' : `\n⚠️ No chat with @${result.order.customer_username} on @tcgpackbot found, so the quote will come back to copy.`));
    return;
  }
  if (sub === 'howto') {
    await interaction.reply({
      content: `Paste this to anyone asking about wholesale:\n\`\`\`\n${instructionsMessage(interaction.options.getString('name'))}\n\`\`\``,
      ephemeral: true,
    });
    return;
  }
  const open = openWholesaleOrders();
  await interaction.reply({
    content: open.length
      ? open.map((o) => `**${orderCode(o)}** · ${o.customer_name || o.business || `@${o.customer_username}`} · ${dollars(o.boxes_cents / 100)} of boxes · ${o.status}`).join('\n').slice(0, 1900)
      : 'No open wholesale orders.',
    ephemeral: true,
  });
}

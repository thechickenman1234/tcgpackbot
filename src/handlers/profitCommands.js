import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { isStaff } from '../utils/permissions.js';
import { findProductByName, listAllProducts, setProductCost } from '../services/productService.js';
import { money, profitFor, profitLines, soldOrders, summarise } from '../services/profitService.js';
import { loginLink } from '../dashboard/dashboard.js';
import { latestOrderSheet } from '../services/orderSheet.js';

/**
 * /dashboard, /cost and /profit: what a unit cost, and what that leaves.
 * /ordersheet: what to buy for the last sale night.
 * Everything else profit needs (what each order sold for, its label) the bot
 * already knows. The dashboard is the easy way; the commands do the same.
 */

export async function handleDashboardCommand(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const link = loginLink(interaction.user.id);
  if (!link) {
    await interaction.reply({ content: 'The dashboard needs OPS_SECRET set on Railway.', ephemeral: true });
    return;
  }
  // A button, not a link in the text: Discord would open a text link itself
  // to make a preview, and that would use up the one-time link.
  await interaction.reply({
    content: '📊 Your profit dashboard. The button works once, within 15 minutes; after that this device stays signed in for 30 days.',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open dashboard').setURL(link),
    )],
    ephemeral: true,
  });
}

export async function handleCostCommand(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const name = interaction.options.getString('product', true).trim();
  const product = findProductByName(name);
  if (!product) {
    await interaction.reply({ content: `No product called **${name}**. Pick one from the list.`, ephemeral: true });
    return;
  }
  const cents = Math.round(interaction.options.getNumber('amount', true) * 100);
  const fix = interaction.options.getBoolean('fix') ?? false;
  const actual = !(interaction.options.getBoolean('estimate') ?? false);
  const before = product.cost_cents;
  setProductCost(product.id, cents, { actual, fix });

  const sold = summarise(soldOrders({ product: product.name }));
  const lines = [`💰 **${product.name}** now costs **${money(cents)}** each (${actual ? 'real cost' : 'estimate'}).`];
  if (!actual && before != null && before !== cents && !fix) {
    lines.push(`Orders already claimed keep the old ${money(before)}. Typed the old one wrong? Run it again with \`fix: True\`.`);
  }
  if (sold.units && !sold.missing.length) {
    lines.push(`Sold so far: ${sold.units} for ${money(sold.sales)}, profit **${money(sold.profit)}**.`);
  }
  await interaction.reply({ content: lines.join('\n'), ephemeral: true });
}

export async function handleProfitCommand(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const period = interaction.options.getString('period') || 'week';
  const product = interaction.options.getString('product')?.trim() || null;
  const s = profitFor(period, { product });

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setTitle(`📈 Profit: ${s.label}${product ? ` · ${product}` : ''}`)
      .setColor(s.profit < 0 ? 0xc0392b : 0x27ae60)
      .setDescription(profitLines(s, { top: 12 }).join('\n').slice(0, 4000))
      .setFooter({ text: 'Sales include the shipping buyers paid. Postage is the Label Pro label. Your own test orders are left out.' })],
    ephemeral: true,
  });
}

export async function handleOrderSheetCommand(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const latest = latestOrderSheet();
  if (!latest) {
    await interaction.reply({ content: 'No sale has closed since the order sheet was added. It posts in the staff log when the next one does.', ephemeral: true });
    return;
  }
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setTitle(latest.title)
      .setColor(0x3498db)
      .setDescription(latest.text.slice(0, 4000))
      .setFooter({ text: 'Numbers as they are right now. Your own test orders are left out.' })],
    ephemeral: true,
  });
}

/** Product names for /cost and /profit, ones still missing a cost first. */
export async function costAutocomplete(interaction, typed) {
  const choices = listAllProducts()
    .filter((p) => p.name.toLowerCase().includes(typed))
    .sort((a, b) => (a.cost_cents == null ? 0 : 1) - (b.cost_cents == null ? 0 : 1))
    .slice(0, 25)
    .map((p) => ({
      name: `${p.name} · ${p.cost_cents == null ? 'no cost yet' : `costs ${money(p.cost_cents)}`}`.slice(0, 100),
      value: p.name.slice(0, 100),
    }));
  await interaction.respond(choices);
}

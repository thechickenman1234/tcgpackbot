import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { isStaff, slugify } from '../utils/permissions.js';
import { getBuyer } from '../services/buyerService.js';
import { formatMelbourne } from '../services/scheduleService.js';
import { labelRowsByBuyer, labelRowsToCsv, pushToSheetInBackground } from '../services/sheetService.js';
import {
  countParcels,
  createBatch,
  getBatch,
  markPosted,
  openBatches,
  openOrdersInBatch,
  planBatch,
  setLabelsBatch,
  statusLines,
  sumUnits,
  unprintedByProduct,
  unprintedForProduct,
} from '../services/shippingService.js';
import { applyTrackingPaste, trackingReply } from '../services/trackingService.js';
import { setMeta } from '../services/metaService.js';

/**
 * The shipping panel: three buttons that replace remembering commands.
 *
 *   🏷️ Print labels  pick a drop, get its label file. Nothing else on it.
 *   📦 Mark posted   tick off what went out, a whole batch or a few.
 *   🔢 Add tracking  paste codes; those parcels are posted and buyers told.
 *
 * Every custom id starts with "shp:" and carries what it needs in the id
 * itself (product ids, a batch id), so the buttons keep working across bot
 * restarts with nothing held in memory.
 */

export const SHIPPING_PREFIX = 'shp:';
const MAX_OPTIONS = 25;
const MAX_ROWS = 5;

const day = (iso) => (iso ? formatMelbourne(iso).split(',').slice(0, 2).join(',') : '?');

function header() {
  return statusLines().join('\n');
}

function panelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shp:print').setLabel('Print labels').setEmoji('🏷️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('shp:posted').setLabel('Mark posted').setEmoji('📦').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('shp:tracking').setLabel('Add tracking').setEmoji('🔢').setStyle(ButtonStyle.Secondary),
  );
}

/** /shippingpanel: posts the buttons where it was run. Pin it and forget it. */
export async function postShippingPanel(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  await interaction.reply({ content: 'Posting the shipping panel here. Pin it so it stays at the top.', ephemeral: true });
  // Label PDFs dropped in this channel get read and sent to buyers (labelDrop.js).
  setMeta('shipping_panel_channel', interaction.channelId);
  await interaction.channel.send({
    content: [
      '## 📦 Shipping',
      '**🏷️ Print labels**: pick a drop and get its label file. Only that drop.',
      '**📦 Mark posted**: tick off what went out. A whole batch or just some.',
      '**🔢 Add tracking**: paste the codes. Those parcels are marked posted and buyers are told.',
      '**📄 Or just drop the Label Pro PDFs here**: the bot reads each label, tells every buyer and marks it posted.',
    ].join('\n'),
    components: [panelButtons()],
  });
}

function orderLine(o) {
  const buyer = getBuyer(o.buyer_id);
  return `${buyer?.name || o.buyer_id} — ${o.quantity}x ${o.product_name}`;
}

function summarise(orders) {
  const byProduct = new Map();
  for (const o of orders) byProduct.set(o.product_name, (byProduct.get(o.product_name) || 0) + o.quantity);
  return [...byProduct.entries()].map(([name, n]) => `${n}x ${name}`).join(' + ');
}

/** The label file for a set of orders, one row per buyer. */
function labelFile(orders, batch) {
  const csv = labelRowsToCsv(labelRowsByBuyer(orders));
  const name = `labels-batch-${batch.id}-${slugify(batch.title).slice(0, 40) || 'drop'}.csv`;
  return new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name });
}

// ---------------------------------------------------------------- print

async function showPrintMenu(interaction) {
  const waiting = unprintedByProduct();
  const batches = openBatches();
  const rows = [];

  if (waiting.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('shp:pp')
        .setPlaceholder('Pick what to print (you can pick more than one)')
        .setMinValues(1)
        .setMaxValues(Math.min(waiting.length, MAX_OPTIONS))
        .addOptions(waiting.slice(0, MAX_OPTIONS).map((g) => ({
          label: g.product.slice(0, 100),
          value: String(g.productId),
          description: (`${g.parcels} parcels · ${g.units}x · claimed ${day(g.firstClaim)}`
            + (day(g.lastClaim) !== day(g.firstClaim) ? ` to ${day(g.lastClaim)}` : '')).slice(0, 100),
        }))),
    ));
  }
  if (batches.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('shp:rp')
        .setPlaceholder('…or get an earlier batch\'s file again')
        .addOptions(batches.slice(0, MAX_OPTIONS).map((b) => ({
          label: `Batch ${b.id} · ${b.title}`.slice(0, 100),
          value: String(b.id),
          description: `${b.open_parcels} parcels not posted · printed ${day(b.created_at)}`.slice(0, 100),
        }))),
    ));
  }

  await interaction.reply({
    content: `${header()}\n\n${waiting.length ? '**What do you want to print?**' : 'Everything paid has been printed already.'}`,
    components: rows,
    ephemeral: true,
  });
}

async function confirmPrint(interaction) {
  const ids = interaction.values.map(Number);
  const { included } = planBatch(ids);
  if (!included.length) {
    await interaction.update({ content: 'Those have just been printed. Press 🏷️ Print labels again.', components: [] });
    return;
  }

  // The ids ride in the button id, which Discord caps at 100 characters.
  const idPart = ids.join('.');
  if (idPart.length > 80) {
    await interaction.update({ content: 'That is a lot at once. Pick 10 or fewer products and print the rest after.', components: [] });
    return;
  }

  const buttons = [
    new ButtonBuilder()
      .setCustomId(`shp:pa:${idPart}`)
      .setLabel(`Print all ${countParcels(included)} parcels`)
      .setEmoji('🏷️')
      .setStyle(ButtonStyle.Primary),
    // Labels printed by hand before these buttons existed, or straight from
    // the sheet: record them as printed so the counts tell the truth.
    new ButtonBuilder()
      .setCustomId(`shp:pk:${idPart}`)
      .setLabel('I already printed these')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Secondary),
  ];
  // Partial deliveries only make sense one product at a time.
  if (ids.length === 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`shp:ps:${ids[0]}`)
        .setLabel('Only some arrived…')
        .setEmoji('📦')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  await interaction.update({
    content: `**${summarise(included)}**\n${countParcels(included)} parcels, one label each.`,
    components: [new ActionRowBuilder().addComponents(buttons)],
  });
}

async function finishPrint(interaction, orders, title, waiting = [], { alreadyPrinted = false } = {}) {
  const { batch, orders: got } = createBatch(orders, title, interaction.user.id);
  if (!got.length) {
    const payload = { content: 'Those have just been printed by someone else. Press 🏷️ Print labels again.', components: [] };
    if (interaction.isModalSubmit()) await interaction.reply({ ...payload, ephemeral: true });
    else await interaction.update(payload);
    return;
  }
  pushToSheetInBackground(got, 'labels');

  if (alreadyPrinted) {
    await interaction.update({
      content: `📝 **Saved as Batch ${batch.id}: ${title}**\n${countParcels(got)} parcels marked as printed. No file, since you have the labels.\n`
        + 'When they go out: 🔢 **Add tracking**, or 📦 **Mark posted** and pick Batch '
        + `${batch.id}.\n\n${header()}`,
      components: [],
    });
    return;
  }

  const lines = [
    `🏷️ **Batch ${batch.id} printed: ${title}**`,
    `${countParcels(got)} parcels · ${summarise(got)}`,
    '',
    'The file is below. Upload it to your label app. The Labels tab shows the same parcels and nothing else.',
  ];
  if (waiting.length) {
    lines.push('', `⏳ **Still waiting for stock (${sumUnits(waiting)}x):**`, ...waiting.slice(0, 15).map((o) => `• ${orderLine(o)}`));
    if (waiting.length > 15) lines.push(`• …and ${waiting.length - 15} more`);
  }
  lines.push('', 'After the post office: 🔢 **Add tracking** marks them posted and tells buyers. No codes? 📦 **Mark posted**.');

  const payload = { content: lines.join('\n').slice(0, 1900), components: [], files: [labelFile(got, batch)] };
  if (interaction.isModalSubmit()) await interaction.reply({ ...payload, ephemeral: true });
  else await interaction.update(payload);
}

async function printAll(interaction, idPart, options = {}) {
  const ids = idPart.split('.').map(Number);
  const { included } = planBatch(ids);
  const names = [...new Set(included.map((o) => o.product_name))];
  await finishPrint(interaction, included, names.join(' + ') || 'labels', [], options);
}

async function askHowMany(interaction, productId) {
  const waiting = unprintedForProduct(productId);
  const name = waiting[0]?.product_name || 'that product';
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`shp:psm:${productId}`)
      .setTitle(`How many arrived?`.slice(0, 45))
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('units')
          .setLabel(`${name}`.slice(0, 45))
          .setPlaceholder(`A number, e.g. 30. ${sumUnits(waiting)} are waiting.`.slice(0, 100))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(5),
      )),
  );
}

async function printSome(interaction, productId) {
  const units = Number.parseInt(interaction.fields.getTextInputValue('units').replace(/\D/g, ''), 10);
  if (!Number.isFinite(units) || units <= 0) {
    await interaction.reply({ content: 'That needs to be a number, like `30`.', ephemeral: true });
    return;
  }
  const { included, waiting } = planBatch([productId], units);
  if (!included.length) {
    await interaction.reply({
      content: `No waiting order fits in ${units}. The smallest needs ${Math.min(...waiting.map((o) => o.quantity))}.`,
      ephemeral: true,
    });
    return;
  }
  const name = included[0].product_name;
  await finishPrint(interaction, included, `${name} (${sumUnits(included)} of ${sumUnits(included) + sumUnits(waiting)})`, waiting);
}

async function reprint(interaction) {
  const batch = getBatch(interaction.values[0]);
  const orders = batch ? openOrdersInBatch(batch.id) : [];
  if (!orders.length) {
    await interaction.update({ content: 'Everything on that batch has been posted already.', components: [] });
    return;
  }
  setLabelsBatch(batch.id);
  pushToSheetInBackground(orders, 'labels');
  await interaction.update({
    content: `🏷️ **Batch ${batch.id} again: ${batch.title}**\n${countParcels(orders)} parcels not posted yet. `
      + 'Already-posted ones are left off. The Labels tab shows this batch again.',
    components: [],
    files: [labelFile(orders, batch)],
  });
}

// ---------------------------------------------------------------- posted

/**
 * A scope is what "All" and "Choose which" act on:
 *   b<id>  everything still to post on batch <id>
 *   u<id>  orders for product <id> that were never printed with the buttons
 */
function ordersInScope(scope) {
  if (scope.startsWith('b')) return openOrdersInBatch(scope.slice(1));
  if (scope.startsWith('u')) return unprintedForProduct(scope.slice(1));
  return [];
}

function scopeTitle(scope, orders) {
  if (scope.startsWith('b')) {
    const batch = getBatch(scope.slice(1));
    return `Batch ${batch?.id} · ${batch?.title}`;
  }
  return `${orders[0]?.product_name || 'Older orders'} (not printed with the buttons)`;
}

async function showPostedMenu(interaction) {
  const batches = openBatches();
  const older = unprintedByProduct();
  const options = batches.slice(0, MAX_OPTIONS - (older.length ? 1 : 0)).map((b) => ({
    label: `Batch ${b.id} · ${b.title}`.slice(0, 100),
    value: `b${b.id}`,
    description: `${b.open_parcels} parcels · ${b.open_units}x · printed ${day(b.created_at)}`.slice(0, 100),
  }));
  if (older.length) {
    options.push({
      label: 'Older orders (printed before these buttons)',
      value: 'u',
      description: older.map((g) => g.product).join(', ').slice(0, 100),
    });
  }

  if (!options.length) {
    await interaction.reply({ content: `${header()}\n\nNothing is waiting to be posted.`, ephemeral: true });
    return;
  }

  await interaction.reply({
    content: `${header()}\n\n**What went out?**`,
    components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('shp:mb').setPlaceholder('Pick a batch').addOptions(options),
    )],
    ephemeral: true,
  });
}

async function pickedPostedScope(interaction) {
  const value = interaction.values[0];
  if (value === 'u') {
    const older = unprintedByProduct();
    await interaction.update({
      content: '**Which product?**',
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('shp:mu')
          .setPlaceholder('Pick a product')
          .addOptions(older.slice(0, MAX_OPTIONS).map((g) => ({
            label: g.product.slice(0, 100),
            value: `u${g.productId}`,
            description: `${g.orders.length} orders · ${g.units}x · claimed ${day(g.firstClaim)}`.slice(0, 100),
          }))),
      )],
    });
    return;
  }
  await showScope(interaction, value);
}

async function showScope(interaction, scope, note = '') {
  const orders = ordersInScope(scope);
  if (!orders.length) {
    await interaction.update({ content: `${note}${note ? '\n\n' : ''}✅ Nothing left to post there.\n\n${header()}`, components: [] });
    return;
  }
  const parcels = countParcels(orders);
  await interaction.update({
    content: `${note}${note ? '\n\n' : ''}**${scopeTitle(scope, orders)}**\n${parcels} parcels · ${summarise(orders)}`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`shp:ma:${scope}`)
        .setLabel(`All ${parcels} parcels went out`)
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`shp:mc:${scope}`)
        .setLabel('Choose which…')
        .setEmoji('☑️')
        .setStyle(ButtonStyle.Secondary),
    )],
  });
}

async function postAll(interaction, scope) {
  const orders = ordersInScope(scope);
  const shipped = markPosted(orders.map((o) => o.id));
  pushToSheetInBackground(shipped, 'posted');
  await interaction.update({
    content: `📦 **Marked ${countParcels(shipped)} parcels posted** (${summarise(shipped) || 'nothing'}).\n`
      + 'Buyers get their tracking when you use 🔢 **Add tracking**. Marked one by mistake? `/unship` puts it back.\n\n'
      + header(),
    components: [],
  });
}

/** Up to five dropdowns of 25, one tick per order. */
function chooserRows(scope, orders) {
  const rows = [];
  for (let i = 0; i < orders.length && rows.length < MAX_ROWS; i += MAX_OPTIONS) {
    const chunk = orders.slice(i, i + MAX_OPTIONS);
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`shp:mo:${scope}:${i}`)
        .setPlaceholder(rows.length ? `More (${i + 1}–${i + chunk.length})` : 'Tick the ones that went out')
        .setMinValues(1)
        .setMaxValues(chunk.length)
        .addOptions(chunk.map((o) => ({
          label: orderLine(o).slice(0, 100),
          value: String(o.id),
          description: `${o.reference_code} · claimed ${day(o.claimed_at)}`.slice(0, 100),
        }))),
    ));
  }
  return rows;
}

async function chooseWhich(interaction, scope, note = '') {
  const orders = ordersInScope(scope);
  if (!orders.length) {
    await interaction.update({ content: `${note}${note ? '\n\n' : ''}✅ Nothing left to post there.\n\n${header()}`, components: [] });
    return;
  }
  const shown = Math.min(orders.length, MAX_OPTIONS * MAX_ROWS);
  await interaction.update({
    content: `${note}${note ? '\n\n' : ''}**${scopeTitle(scope, orders)}**\n`
      + 'Tick the ones that went out. Each tick saves as soon as the list closes.'
      + (shown < orders.length ? `\nShowing the oldest ${shown} of ${orders.length}.` : ''),
    components: chooserRows(scope, orders),
  });
}

async function postChosen(interaction, scope) {
  const shipped = markPosted(interaction.values);
  pushToSheetInBackground(shipped, 'posted');
  const note = shipped.length
    ? `📦 Marked posted: ${shipped.map((o) => orderLine(o)).join(', ')}`.slice(0, 900)
    : 'Those were already marked posted.';
  await chooseWhich(interaction, scope, note);
}

// ---------------------------------------------------------------- tracking

async function askTracking(interaction) {
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId('shp:trm')
      .setTitle('Add tracking')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('paste')
          .setLabel('One parcel per line: name, then code')
          .setPlaceholder('Ben Broadhurst: 0301018247797006320996\nAmanda Chen: 0301018247797006320997')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(4000),
      )),
  );
}

async function saveTracking(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const result = await applyTrackingPaste(interaction.client, interaction.fields.getTextInputValue('paste'));
  pushToSheetInBackground(result.synced, 'tracking');
  await interaction.editReply({ content: `${trackingReply(result)}\n\n${header()}`.slice(0, 1900) });
}

// ---------------------------------------------------------------- router

export async function handleShippingPanel(interaction) {
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const [, action, ...rest] = interaction.customId.split(':');
  const arg = rest.join(':');

  switch (action) {
    case 'print': return showPrintMenu(interaction);
    case 'pp': return confirmPrint(interaction);
    case 'pa': return printAll(interaction, arg);
    case 'pk': return printAll(interaction, arg, { alreadyPrinted: true });
    case 'ps': return askHowMany(interaction, Number(arg));
    case 'psm': return printSome(interaction, Number(arg));
    case 'rp': return reprint(interaction);
    case 'posted': return showPostedMenu(interaction);
    case 'mb': return pickedPostedScope(interaction);
    case 'mu': return showScope(interaction, interaction.values[0]);
    case 'ma': return postAll(interaction, arg);
    case 'mc': return chooseWhich(interaction, arg);
    case 'mo': return postChosen(interaction, rest[0]);
    case 'tracking': return askTracking(interaction);
    case 'trm': return saveTracking(interaction);
    default:
      await interaction.reply({ content: 'That button is out of date. Press it again from the panel.', ephemeral: true });
      return undefined;
  }
}

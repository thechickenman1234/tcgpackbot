import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('product')
    .setDescription('Manage claim-sale products')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a product to the active sale')
        .addStringOption((o) => o.setName('name').setDescription('Product name buyers must claim').setRequired(true))
        .addNumberOption((o) => o.setName('price').setDescription('Price in AUD e.g. 150').setRequired(true))
        .addIntegerOption((o) => o.setName('quantity').setDescription('Units available').setRequired(true).setMinValue(0))
        .addNumberOption((o) => o.setName('shipping').setDescription('Flat shipping in AUD e.g. 15').setRequired(false))
        .addIntegerOption((o) =>
          o
            .setName('limit')
            .setDescription('Optional max units each person can buy (omit = no limit)')
            .setRequired(false)
            .setMinValue(1),
        )
        .addStringOption((o) => o.setName('sale_window').setDescription('Optional sale window text').setRequired(false)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('stock')
        .setDescription('Set remaining stock for a product')
        .addStringOption((o) => o.setName('name').setDescription('Product name').setRequired(true))
        .addIntegerOption((o) => o.setName('quantity').setDescription('New quantity').setRequired(true).setMinValue(0)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('limit')
        .setDescription('Set or clear per-person purchase limit for a product')
        .addStringOption((o) => o.setName('name').setDescription('Product name').setRequired(true))
        .addIntegerOption((o) =>
          o
            .setName('max')
            .setDescription('Max units per person (0 = remove limit)')
            .setRequired(true)
            .setMinValue(0),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('price')
        .setDescription('Update product price')
        .addStringOption((o) => o.setName('name').setDescription('Product name').setRequired(true))
        .addNumberOption((o) => o.setName('price').setDescription('New price in AUD').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('shipping')
        .setDescription('Update flat shipping cost for a product')
        .addStringOption((o) => o.setName('name').setDescription('Product name').setRequired(true))
        .addNumberOption((o) => o.setName('shipping').setDescription('Shipping in AUD e.g. 15').setRequired(true).setMinValue(0)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('deactivate')
        .setDescription('Remove a product from the active sale')
        .addStringOption((o) => o.setName('name').setDescription('Product name').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('List products'),
    ),

  new SlashCommandBuilder()
    .setName('stockpost')
    .setDescription('Post current stock listing in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('endsale')
    .setDescription('End the claim sale and post the sale-over message')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('paid')
    .setDescription('Mark the order in this ticket as paid (manual confirmation)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o.setName('reference').setDescription('Optional order reference if not run inside the ticket').setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName('shipped')
    .setDescription('Mark the order in this ticket as shipped')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o.setName('reference').setDescription('Optional order reference if not run inside the ticket').setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Manually ban a buyer from claiming')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((o) => o.setName('user').setDescription('Buyer to ban').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true)),

  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Manually lift a claim ban (never automatic)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((o) => o.setName('user').setDescription('Buyer to unban').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why the ban is lifted').setRequired(false)),

  new SlashCommandBuilder()
    .setName('appeal')
    .setDescription('Ban appeals')
    .addSubcommand((sub) =>
      sub
        .setName('submit')
        .setDescription('Submit an appeal if you are banned from claiming')
        .addStringOption((o) =>
          o.setName('reason').setDescription('Explain your situation').setRequired(true).setMaxLength(1000),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reject')
        .setDescription('Staff: reject an appeal (ban stays)')
        .addUserOption((o) => o.setName('user').setDescription('Buyer').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Rejection note').setRequired(false)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('history')
        .setDescription('Staff: view ban/appeal history')
        .addUserOption((o) => o.setName('user').setDescription('Buyer').setRequired(true)),
    ),

  new SlashCommandBuilder()
    .setName('order')
    .setDescription('Look up an order')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) => o.setName('reference').setDescription('Order reference e.g. TCG-A1B2C3').setRequired(true)),
].map((c) => c.toJSON());

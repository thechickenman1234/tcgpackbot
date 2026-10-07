import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('product')
    .setDescription('Manage claim-sale products')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('describe')
        .setDescription('Set the long name and pack structure used in sale announcements')
        .addStringOption((o) =>
          o.setName('name').setDescription('The short name buyers type, e.g. pika box').setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName('display')
            .setDescription('Long name for announcements, e.g. Chinese Dreamscape Flourish Vol 4 (Pika Box)')
            .setRequired(false),
        )
        .addStringOption((o) =>
          o
            .setName('line1')
            .setDescription('Line under the price, e.g. 15 packs = 1 inner box')
            .setRequired(false),
        )
        .addStringOption((o) =>
          o
            .setName('line2')
            .setDescription('Another line, e.g. 12 inner box = 1 case')
            .setRequired(false),
        )
        .addStringOption((o) =>
          o.setName('line3').setDescription('And another').setRequired(false),
        )
        .addStringOption((o) =>
          o
            .setName('unit')
            .setDescription('What the price is per. Default box.')
            .setRequired(false)
            .addChoices(
              { name: 'box', value: 'box' },
              { name: 'case', value: 'case' },
              { name: 'pack', value: 'pack' },
              { name: 'coin set', value: 'coin set' },
              { name: 'bundle', value: 'bundle' },
            ),
        ),
    )
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
        .setDescription('Set remaining stock for a product (reactivates if qty > 0)')
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
        .setName('tiers')
        .setDescription('Set quantity-based pricing tiers (overrides flat price/shipping)')
        .addStringOption((o) => o.setName('name').setDescription('Product name').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('tiers')
            .setDescription('range:price:shipping per tier, e.g. 1-4:200:5,5-9:200:0,10+:197:0')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('cleartiers')
        .setDescription('Remove tiered pricing — goes back to the flat price/shipping')
        .addStringOption((o) => o.setName('name').setDescription('Product name').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('activate')
        .setDescription('Put a product back on the live sale')
        .addStringOption((o) => o.setName('name').setDescription('Product name').setRequired(true)),
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
      o.setName('tracking').setDescription('Tracking number — posted to the buyer automatically').setRequired(false),
    )
    .addStringOption((o) =>
      o
        .setName('reference')
        .setDescription('Search by buyer name if you are not in their ticket')
        .setRequired(false)
        .setAutocomplete(true),
    ),

  new SlashCommandBuilder()
    .setName('tracking')
    .setDescription('Add tracking to many orders at once and tell every buyer')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o
        .setName('paste')
        .setDescription('Paste from your label printer: Ben Broadhurst: 0301018247797006320996')
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName('cancel')
    .setDescription('Cancel a pending claim ticket and return stock')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o.setName('reason').setDescription('Optional cancel reason').setRequired(false),
    )
    .addStringOption((o) =>
      o.setName('reference').setDescription('Optional order reference if not run inside the ticket').setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName('shipping')
    .setDescription('Update saved shipping details')
    .addUserOption((o) =>
      o.setName('user').setDescription('Staff only: update another buyer').setRequired(false),
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

  new SlashCommandBuilder()
    .setName('export')
    .setDescription('Export a CSV of every paid, not-yet-exported order for bulk label printing')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addBooleanOption((o) =>
      o
        .setName('all')
        .setDescription('Re-export EVERY paid order, including ones already exported before')
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName('shipall')
    .setDescription('Mark everything as shipped except the products you pick — shows a preview first')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o
        .setName('keep')
        .setDescription('Product to leave alone — pick from the list')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName('keep2')
        .setDescription('Another product to leave alone')
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName('keep3')
        .setDescription('And another')
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addBooleanOption((o) =>
      o
        .setName('confirm')
        .setDescription('Leave this OFF to preview. Turn it on to actually do it.')
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName('schedulesale')
    .setDescription('Open and close a claim sale automatically — defaults to 8pm until midnight')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o.setName('product').setDescription('What is on sale').setRequired(true).setAutocomplete(true),
    )
    .addStringOption((o) =>
      o.setName('date').setDescription('Which night').setRequired(true).setAutocomplete(true),
    )
    .addStringOption((o) =>
      o.setName('product2').setDescription('A second product').setRequired(false).setAutocomplete(true),
    )
    .addStringOption((o) =>
      o.setName('product3').setDescription('A third product').setRequired(false).setAutocomplete(true),
    )
    .addStringOption((o) =>
      o.setName('start').setDescription('Start time (default 8:00 pm)').setRequired(false).setAutocomplete(true),
    )
    .addStringOption((o) =>
      o.setName('end').setDescription('End time (default midnight)').setRequired(false).setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName('announce')
        .setDescription('When to post the prices in announcements (default 7:00 pm)')
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName('note')
        .setDescription('Extra line for both posts, e.g. ordering both boxes gets shipping off one')
        .setRequired(false),
    )
    .addStringOption((o) =>
      o
        .setName('title')
        .setDescription('Override the sale name in the headings')
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName('scheduledsales')
    .setDescription('See the claim sales that are queued up')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('cancelsale')
    .setDescription('Cancel a scheduled claim sale')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o.setName('sale').setDescription('Which one').setRequired(true).setAutocomplete(true),
    ),

  new SlashCommandBuilder()
    .setName('backfillbuyers')
    .setDescription('Give the buyer role to everyone who has ever paid — safe to run more than once')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('logsale')
    .setDescription('Record a sale from Facebook, a DM or wholesale — it becomes a normal order')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o.setName('product').setDescription('Which product').setRequired(true).setAutocomplete(true),
    )
    .addIntegerOption((o) =>
      o.setName('quantity').setDescription('How many boxes').setRequired(true).setMinValue(1),
    )
    .addNumberOption((o) =>
      o.setName('total').setDescription('Total they paid you in AUD, including any shipping').setRequired(true).setMinValue(0),
    )
    .addStringOption((o) =>
      o
        .setName('source')
        .setDescription('Where the sale came from')
        .setRequired(true)
        .addChoices(
          { name: 'Facebook', value: 'facebook' },
          { name: 'Wholesale', value: 'wholesale' },
          { name: 'Discord DM', value: 'dm' },
          { name: 'Instagram', value: 'instagram' },
          { name: 'In person', value: 'in_person' },
          { name: 'Other', value: 'other' },
        ),
    )
    .addUserOption((o) =>
      o.setName('user').setDescription('If they are in the server — reuses their saved address').setRequired(false),
    )
    .addStringOption((o) =>
      o.setName('name').setDescription('Full name for the label').setRequired(false),
    )
    .addStringOption((o) =>
      o.setName('address').setDescription('Street address').setRequired(false),
    )
    .addStringOption((o) =>
      o.setName('suburb').setDescription('Suburb').setRequired(false),
    )
    .addStringOption((o) =>
      o.setName('state').setDescription('State e.g. VIC').setRequired(false),
    )
    .addStringOption((o) =>
      o.setName('postcode').setDescription('Postcode').setRequired(false),
    )
    .addStringOption((o) =>
      o.setName('phone').setDescription('Phone for the courier').setRequired(false),
    )
    .addNumberOption((o) =>
      o.setName('shipping').setDescription('How much of the total was shipping (default 0)').setRequired(false).setMinValue(0),
    ),

  new SlashCommandBuilder()
    .setName('sources')
    .setDescription('Revenue split by where the sale came from')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('Post a message at a set date and time — Melbourne time')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o
        .setName('message')
        .setDescription('What to post. @everyone works.')
        .setRequired(true)
        .setMaxLength(1900),
    )
    .addStringOption((o) =>
      o.setName('date').setDescription('Pick a date').setRequired(true).setAutocomplete(true),
    )
    .addStringOption((o) =>
      o.setName('time').setDescription('Pick a time').setRequired(true).setAutocomplete(true),
    )
    .addAttachmentOption((o) =>
      o.setName('image').setDescription('Picture or video to post with it').setRequired(false),
    )
    .addAttachmentOption((o) =>
      o.setName('image2').setDescription('Another one').setRequired(false),
    )
    .addAttachmentOption((o) =>
      o.setName('image3').setDescription('And another').setRequired(false),
    )
    .addChannelOption((o) =>
      o.setName('channel').setDescription('Where to post it (default: this channel)').setRequired(false),
    )
    .addStringOption((o) =>
      o
        .setName('repeat')
        .setDescription('Send it again on a schedule')
        .setRequired(false)
        .addChoices(
          { name: 'Every day', value: 'daily' },
          { name: 'Every week', value: 'weekly' },
        ),
    ),

  new SlashCommandBuilder()
    .setName('scheduled')
    .setDescription('See everything queued to post')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('unschedule')
    .setDescription('Cancel a scheduled message')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o.setName('message').setDescription('Pick the one to cancel').setRequired(true).setAutocomplete(true),
    ),

  new SlashCommandBuilder()
    .setName('claimed')
    .setDescription('How many of each product to order — includes claims that have not been paid yet')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o
        .setName('product')
        .setDescription('Break one product down buyer by buyer')
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addIntegerOption((o) =>
      o
        .setName('since')
        .setDescription('Only count recent claims — use this to price one sale')
        .setRequired(false)
        .addChoices(
          { name: 'Last 12 hours', value: 12 },
          { name: 'Last 24 hours', value: 24 },
          { name: 'Last 3 days', value: 72 },
          { name: 'Last 7 days', value: 168 },
        ),
    ),

  new SlashCommandBuilder()
    .setName('unship')
    .setDescription('Undo a shipped mark — puts the order back on the Labels tab')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o
        .setName('reference')
        .setDescription('Pick the order to put back')
        .setRequired(true)
        .setAutocomplete(true),
    ),

  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Run an invite giveaway')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('Start a giveaway and post the leaderboard here')
        .addStringOption((o) =>
          o.setName('prize').setDescription('What they win, e.g. 1x Mega Dream booster box').setRequired(true),
        )
        .addIntegerOption((o) =>
          o
            .setName('days')
            .setDescription('How many days it runs for')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(90),
        )
        .addIntegerOption((o) =>
          o
            .setName('winners')
            .setDescription('How many winners (default 1)')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(20),
        )
        .addIntegerOption((o) =>
          o
            .setName('min_account_age')
            .setDescription('Invited accounts must be this many days old (default 7)')
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(365),
        ),
    )
    .addSubcommand((s) => s.setName('draw').setDescription('Pick the winner and announce it'))
    .addSubcommand((s) => s.setName('end').setDescription('Stop entries without drawing yet'))
    .addSubcommand((s) => s.setName('cancel').setDescription('Call the whole thing off — no winner'))
    .addSubcommand((s) => s.setName('status').setDescription('Full standings, staff only')),

  new SlashCommandBuilder()
    .setName('entries')
    .setDescription('See your giveaway entries and the leaderboard'),

  new SlashCommandBuilder()
    .setName('sync')
    .setDescription('Push every paid order to the accounting spreadsheet and rebuild the Labels tab')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((c) => c.toJSON());

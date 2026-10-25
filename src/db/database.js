import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

let db;

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function initDatabase() {
  const dbPath = path.resolve(config.databasePath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS buyers (
      discord_id TEXT PRIMARY KEY,
      name TEXT,
      phone TEXT,
      shipping_address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      is_banned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ban_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      buyer_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('ban', 'unban', 'appeal_submitted', 'appeal_rejected', 'appeal_accepted')),
      reason TEXT,
      staff_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (buyer_id) REFERENCES buyers(discord_id)
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      price_cents INTEGER NOT NULL,
      shipping_cents INTEGER NOT NULL DEFAULT 0,
      quantity_available INTEGER NOT NULL DEFAULT 0,
      max_per_buyer INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      sale_window TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reference_code TEXT NOT NULL UNIQUE,
      buyer_id TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      shipping_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'archived', 'cancelled')),
      thread_id TEXT,
      claim_message_id TEXT,
      claimed_at TEXT NOT NULL,
      payment_deadline_at TEXT NOT NULL,
      paid_at TEXT,
      shipped_at TEXT,
      archive_at TEXT,
      archived_at TEXT,
      cancelled_at TEXT,
      cancel_reason TEXT,
      FOREIGN KEY (buyer_id) REFERENCES buyers(discord_id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS bot_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Every invoice the bot makes, so a number is never used twice and any
    -- invoice can be looked up later.
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number TEXT NOT NULL UNIQUE,
      bill_to TEXT NOT NULL,
      items TEXT NOT NULL,
      shipping_cents INTEGER NOT NULL DEFAULT 0,
      shipping_label TEXT,
      paid INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      order_id INTEGER,
      total_cents INTEGER NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    -- The bill-to a buyer was last invoiced with (business name, ABN), so
    -- their next invoice starts with it filled in.
    CREATE TABLE IF NOT EXISTS invoice_billing (
      buyer_id TEXT PRIMARY KEY,
      bill_to TEXT NOT NULL
    );

    -- One row per video posted. The bot pings 24 hours later to log how it
    -- did, and the answers stay here for the next feedback loop.
    CREATE TABLE IF NOT EXISTS reels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      link TEXT,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      posted_at TEXT NOT NULL,
      remind_at TEXT NOT NULL,
      reminded_at TEXT,
      reminder_message_id TEXT,
      numbers TEXT,
      worked TEXT,
      didnt TEXT,
      next_time TEXT,
      logged_at TEXT
    );

    -- One row per press of Print labels. Orders point at the batch they were
    -- printed in, so "have I printed this one?" has a real answer.
    CREATE TABLE IF NOT EXISTS label_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_deadline ON orders(payment_deadline_at);
    CREATE INDEX IF NOT EXISTS idx_orders_archive ON orders(archive_at);
    CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);

    CREATE TABLE IF NOT EXISTS giveaways (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prize TEXT NOT NULL,
      winner_count INTEGER NOT NULL DEFAULT 1,
      min_account_age_days INTEGER NOT NULL DEFAULT 7,
      started_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      ended_at TEXT,
      channel_id TEXT,
      message_id TEXT,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'ended', 'drawn', 'cancelled'))
    );

    -- One row per person who joined, not per join. The UNIQUE constraint is
    -- what stops someone farming entries by leaving and rejoining: the same
    -- invitee can only ever be worth one entry in one giveaway.
    CREATE TABLE IF NOT EXISTS giveaway_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      giveaway_id INTEGER NOT NULL,
      inviter_id TEXT NOT NULL,
      invitee_id TEXT NOT NULL,
      invite_code TEXT,
      joined_at TEXT NOT NULL,
      left_at TEXT,
      UNIQUE (giveaway_id, invitee_id),
      FOREIGN KEY (giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS giveaway_winners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      giveaway_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      drawn_at TEXT NOT NULL,
      FOREIGN KEY (giveaway_id) REFERENCES giveaways(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      content TEXT NOT NULL,
      send_at TEXT NOT NULL,
      repeat_every TEXT CHECK (repeat_every IN ('daily', 'weekly')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_sent_at TEXT,
      last_error TEXT,
      attachments TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'cancelled', 'failed'))
    );

    CREATE TABLE IF NOT EXISTS scheduled_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_ids TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      opened_at TEXT,
      closed_at TEXT,
      last_error TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'open', 'closed', 'cancelled', 'failed'))
    );

    CREATE INDEX IF NOT EXISTS idx_sales_due ON scheduled_sales(status, start_at, end_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_messages(status, send_at);
    CREATE INDEX IF NOT EXISTS idx_entries_giveaway ON giveaway_entries(giveaway_id);
    CREATE INDEX IF NOT EXISTS idx_entries_inviter ON giveaway_entries(giveaway_id, inviter_id);
  `);

  // Migrations for existing DBs created before these columns existed
  ensureColumn('buyers', 'city', 'TEXT');
  ensureColumn('buyers', 'state', 'TEXT');
  ensureColumn('buyers', 'zip', 'TEXT');
  ensureColumn('products', 'shipping_cents', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('products', 'max_per_buyer', 'INTEGER');
  ensureColumn('products', 'pricing_tiers', 'TEXT');
  // The long name used in announcements. products.name stays the short
  // thing buyers actually type, e.g. "pika box".
  ensureColumn('products', 'display_name', 'TEXT');
  // Free text under the price: pack counts, case structure, that sort of thing.
  ensureColumn('products', 'details', 'TEXT');
  // box, case, pack, coin set - whatever the price is per.
  ensureColumn('products', 'unit', "TEXT NOT NULL DEFAULT 'box'");
  ensureColumn('orders', 'shipping_cents', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('orders', 'reminder_sent_at', 'TEXT');
  ensureColumn('orders', 'shipping_method', "TEXT CHECK (shipping_method IN ('standard', 'express'))");
  ensureColumn('orders', 'exported_at', 'TEXT');
  ensureColumn('orders', 'tracking_code', 'TEXT');
  ensureColumn('orders', 'combined_with', 'TEXT');
  ensureColumn('scheduled_messages', 'attachments', 'TEXT');
  ensureColumn('scheduled_sales', 'announce_at', 'TEXT');
  ensureColumn('scheduled_sales', 'announce_channel_id', 'TEXT');
  ensureColumn('scheduled_sales', 'announced_at', 'TEXT');
  ensureColumn('scheduled_sales', 'note', 'TEXT');
  ensureColumn('scheduled_sales', 'title', 'TEXT');
  ensureColumn('scheduled_sales', 'attachments', 'TEXT');
  // Where an order came from. Claim sales stay the default so every
  // existing row keeps meaning what it already meant.
  ensureColumn('orders', 'source', "TEXT NOT NULL DEFAULT 'claim'");
  // A grace window after a sale ends, priced higher so waiting to see what
  // is left is never the cheaper move.
  ensureColumn('products', 'late_until', 'TEXT');
  ensureColumn('products', 'late_markup_percent', 'INTEGER NOT NULL DEFAULT 0');
  // Which Print labels press an order went out on. Null means it has never
  // been printed through the shipping buttons. Indexed after the column
  // exists, since an older database only gets it from the line above.
  ensureColumn('orders', 'label_batch_id', 'INTEGER');
  // The date printed on an invoice, which can be the day it was paid rather
  // than the day the PDF was made.
  ensureColumn('invoices', 'issued_on', 'TEXT');
  // When the buyer posted a payment screenshot in their ticket. While it is
  // set the order is never auto-cancelled or banned: staff press Paid or
  // Not paid on it instead.
  ensureColumn('orders', 'proof_at', 'TEXT');
  ensureColumn('orders', 'proof_message_id', 'TEXT');
  // When staff were pinged that a held order went past its deadline unchecked.
  ensureColumn('orders', 'proof_overdue_pinged_at', 'TEXT');
  // Staff's own text for the shipping label's reference box (/label), when
  // an order changed after claiming. Null prints the default.
  ensureColumn('orders', 'label_reference', 'TEXT');
  // What one unit cost, landed (supplier, freight, fees), for /profit. Set on
  // the product with /cost or when its sale is queued. An order gets its own
  // copy only once the product's cost changes, so a dearer second wave of the
  // same product can't rewrite the profit on the first.
  ensureColumn('products', 'cost_cents', 'INTEGER');
  ensureColumn('orders', 'unit_cost_cents', 'INTEGER');
  // 0 while the cost is the estimate from the quote, 1 once the real cost
  // (after bulk discounts, the actual freight) has been put in.
  ensureColumn('products', 'cost_actual', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('orders', 'unit_cost_actual', 'INTEGER');
  // Each parcel an order went out in, read off its dropped label. Usually one;
  // more when only part of an order had arrived and the rest went later.
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_parcels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      tracking_code TEXT NOT NULL UNIQUE,
      quantity INTEGER NOT NULL,
      posted_at TEXT NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_parcels_order ON order_parcels(order_id)');
  // What the dashboard tracks about the server from now on (activityService):
  // members each day, chat per Melbourne hour, who chats, and which invite
  // link each new member came through.
  db.exec(`
    CREATE TABLE IF NOT EXISTS member_daily (
      date TEXT PRIMARY KEY,
      members INTEGER,
      joins INTEGER NOT NULL DEFAULT 0,
      leaves INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chat_hourly (
      date TEXT NOT NULL,
      hour INTEGER NOT NULL,
      messages INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, hour)
    );
    CREATE TABLE IF NOT EXISTS chat_authors (
      author_id TEXT PRIMARY KEY,
      first_at TEXT NOT NULL,
      last_at TEXT NOT NULL,
      messages INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS member_joins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      invite_code TEXT,
      inviter_id TEXT,
      left_at TEXT
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_member_joins_member ON member_joins(member_id)');
  // Every payment in or out of Wise (wiseService), and what Lachy tagged it
  // as on the dashboard: stock, freight, expense, wholesale or not business.
  // Amounts are hundredths of their currency (cents, or yen x 100).
  db.exec(`
    CREATE TABLE IF NOT EXISTS wise_payments (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
      happened_at TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      aud_cents INTEGER,
      aud_estimated INTEGER NOT NULL DEFAULT 0,
      other_amount INTEGER,
      other_currency TEXT,
      counterparty TEXT,
      reference TEXT,
      status TEXT,
      tag TEXT,
      product_id INTEGER,
      units INTEGER,
      expense_id INTEGER,
      order_id INTEGER,
      note TEXT,
      tagged_at TEXT,
      synced_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_wise_payments_when ON wise_payments(happened_at)');
  // Money out that isn't stock or labels (packaging, fees, tools), so the
  // dashboard's profit can be after everything.
  db.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spent_on TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      what TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_batch ON orders(label_batch_id)');
  // Wholesale orders that come in by Instagram DM: priced, sent to the
  // supplier for a shipping quote, quoted back to the shop, then paid.
  // lines is JSON: [{ region, name, spec, qty, price }], price in dollars.
  db.exec(`
    CREATE TABLE IF NOT EXISTS wholesale_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT,
      customer_username TEXT,
      customer_name TEXT,
      business TEXT,
      contact_method TEXT,
      contact_value TEXT,
      notes TEXT,
      source TEXT NOT NULL DEFAULT 'instagram',
      quote_token TEXT,
      lines TEXT NOT NULL,
      unmatched TEXT,
      boxes_cents INTEGER NOT NULL DEFAULT 0,
      shipping_cents INTEGER,
      shipping_guess_cents INTEGER,
      supplier_reply TEXT,
      status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'asked', 'quoted', 'paid', 'cancelled')),
      source_text TEXT,
      card_channel_id TEXT,
      card_message_id TEXT,
      sale_order_ids TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      asked_at TEXT,
      quoted_at TEXT,
      paid_at TEXT,
      supplier_ordered_at TEXT
    )
  `);
  // One row per sale night's stock, from claims closing to every parcel
  // posted (stockTracker). The steps staff tap are stored here; the rest
  // (supplier paid in Wise, labels printed, posted) are read off the orders.
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_ids TEXT NOT NULL,
      since_at TEXT NOT NULL,
      closed_at TEXT NOT NULL,
      ordered_at TEXT,
      supplier_paid_at TEXT,
      on_way_at TEXT,
      on_way_note TEXT,
      arrived_at TEXT,
      done_at TEXT,
      card_channel_id TEXT,
      card_message_id TEXT,
      created_at TEXT NOT NULL
    )
  `);
  // Tracking codes uploaded on the dashboard (trackingCodes.js), matched to
  // orders and held until staff tick the parcel as shipped; only then is the
  // buyer told. order_id stays null until a code is matched.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracking_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracking_code TEXT NOT NULL UNIQUE,
      order_id INTEGER,
      quantity INTEGER,
      label_name TEXT,
      label_ref TEXT,
      source TEXT,
      status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'sent', 'skipped')),
      created_at TEXT NOT NULL,
      sent_at TEXT
    )
  `);

  return db;
}

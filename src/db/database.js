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
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_batch ON orders(label_batch_id)');

  return db;
}

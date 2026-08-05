# TCG Pack Bot — Claim Sale Discord Bot

Discord claim-sale bot for **TCG Pack Bot** (Pokémon TCG reselling). Buyers claim stock with a strict message format; each valid claim becomes a private ticket thread with PayID payment details. Payment confirmation is always manual.

## Flow

1. Staff adds products (`/product add`) and posts stock (`/stockpost`).
2. Buyer claims: `claim 2x mega dream`
3. Bot reacts ✅ and opens a **private thread** for buyer + staff.
4. Buyer fills the intake modal (name, phone, address).
5. Bot posts PayID, amount, order reference, and payment deadline (default **2 hours**).
6. Buyer posts a payment screenshot; staff runs `/paid`, later `/shipped`.
7. Thread **auto-archives 7 days** after shipped.
8. Missed payment deadline → buyer banned, staff log, thread closed. Unban is **manual only** (`/unban` or appeal review).

## Requirements

- Node.js 20+
- Discord bot with intents: **Server Members**, **Message Content**, **Guilds**
- Bot permissions: Send Messages, Create Public/Private Threads, Manage Threads, Add Reactions, Manage Roles (for banned role), Read Message History

## Setup

```bash
cp .env.example .env
# fill in token, IDs, PayID, role IDs

npm install
npm run register-commands
npm start
```

### Discord setup checklist

1. Create bot application → copy token & client ID.
2. Invite bot with needed permissions.
3. Create a public **claims** channel and a staff-only **log** channel.
4. Optional: `#appeals` channel for free-text appeals.
5. Create **Staff** role and optional **Banned** role.
6. Put channel/role IDs in `.env`.

## Slash commands

| Command | Who | Purpose |
|---------|-----|---------|
| `/product add\|stock\|price\|deactivate\|list` | Staff | Manage sale inventory |
| `/stockpost` | Staff | Post public stock + claim instructions |
| `/paid` | Staff | Manual payment confirmation |
| `/shipped` | Staff | Mark shipped (starts archive timer) |
| `/ban` / `/unban` | Staff | Manual claim ban control |
| `/appeal submit\|reject\|history` | Buyer / Staff | Ban appeals |
| `/order` | Staff | Lookup by reference |

## Claim format (strict)

```
claim [quantity]x [product]
```

Example: `claim 2x mega dream`

Wrong format / sold out / duplicate → brief rejection, no thread.  
Banned buyers → silent ignore.

## Data

SQLite (`./data/bot.sqlite` by default) stores buyers, ban history, products, and orders (`pending` → `paid` → `shipped` → `archived`, or `cancelled` on no-show).

## Out of scope (v1)

Automated PayID / bank-feed verification — payment stays manual.

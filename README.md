# TCG Pack Bot — Claim Sale Discord Bot

Discord claim-sale bot for **TCG Pack Bot** (Pokémon TCG reselling). Staff posts stock; buyers claim via a dropdown on that post. Each valid claim becomes a private ticket thread with PayID payment details. Payment confirmation is always manual.

## Flow

1. Staff adds products (`/product add`) and posts stock (`/stockpost`).
2. Buyer picks a product from the **dropdown**, enters quantity (and shipping on first claim).
3. Bot opens a **private thread** and posts PayID, amount, order reference, and payment deadline immediately.
4. Returning buyers with saved shipping details only enter quantity.
5. Buyer posts a payment screenshot; staff runs `/paid`, later `/shipped`.
6. Thread **auto-archives 7 days** after shipped.
7. Missed payment deadline → buyer banned, staff log, thread closed. Unban is **manual only** (`/unban` or appeal review).

Text backup (optional): `claim 2x mega dream` still works in the claims channel.

## Requirements

- Node.js 20+
- Discord bot with intents: **Server Members**, **Message Content**, **Guilds**
- Bot permissions: Send Messages, Create Public/Private Threads, Manage Threads, Add Reactions, Manage Roles (for banned role), Read Message History

## Setup

```bash
cp .env.example .env
# fill in token, IDs, PayID, role IDs

npm install
npm start
```

Slash commands register **automatically on bot startup** (guild commands, usually visible within seconds). You do not need a separate `npm run register-commands` step.

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
| `/stockpost` | Staff | Post public stock + claim dropdown |
| `/paid` | Staff | Manual payment confirmation |
| `/shipped` | Staff | Mark shipped (starts archive timer) |
| `/ban` / `/unban` | Staff | Manual claim ban control |
| `/appeal submit\|reject\|history` | Buyer / Staff | Ban appeals |
| `/order` | Staff | Lookup by reference |

## Claiming

**Primary:** use the dropdown on `/stockpost`.

**Backup text format:**

```
claim [quantity]x [product]
```

Example: `claim 2x mega dream`

Sold out / duplicate → brief rejection, no thread.  
Banned buyers → blocked from claiming.

## Data

SQLite (`./data/bot.sqlite` by default) stores buyers, ban history, products, and orders (`pending` → `paid` → `shipped` → `archived`, or `cancelled` on no-show).

## Out of scope (v1)

Automated PayID / bank-feed verification — payment stays manual.

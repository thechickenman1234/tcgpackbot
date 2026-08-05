# TCG Pack Bot — Claim Sale Discord Bot

Discord claim-sale bot for **TCG Pack Bot** (Pokémon TCG reselling). Staff posts stock; buyers claim via a dropdown (or flexible text). Each valid claim becomes a private ticket with PayID details. Payment confirmation is always manual.

**Staff how-to:** see [USAGE.md](./USAGE.md) for the full English operating guide.

## Flow

1. Staff adds a product (`/product add`) with price, quantity, and optional **shipping**, then `/stockpost`.
2. Buyer picks a product from the **dropdown**, enters quantity (and shipping details on first claim: street, city, state, ZIP).
3. Bot opens a **private thread** and posts PayID, item total, shipping, order reference, and deadline immediately.
4. When a product hits 0, the bot posts a **SOLD OUT** message. When nothing remains (or staff runs `/endsale`), it posts **CLAIM SALE IS NOW OVER**.
5. Buyer posts a payment screenshot; staff runs `/paid`, later `/shipped`.
6. Thread **auto-archives 7 days** after shipped.
7. Missed payment deadline → buyer banned. Unban is **manual only**.

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

Slash commands register **automatically on bot startup**.

Default payment deadline is **24 hours** (`PAYMENT_DEADLINE_HOURS`).

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
| `/product add\|stock\|price\|shipping\|deactivate\|list` | Staff | Manage sale inventory |
| `/stockpost` | Staff | Post public stock + claim dropdown |
| `/endsale` | Staff | End sale + post sale-over message |
| `/paid` | Staff | Manual payment confirmation |
| `/shipped` | Staff | Mark shipped (starts archive timer) |
| `/ban` / `/unban` | Staff | Manual claim ban control |
| `/appeal submit\|reject\|history` | Buyer / Staff | Ban appeals |
| `/order` | Staff | Lookup by reference |

Example product:

```
/product add name:mega dream price:150 quantity:10 shipping:15
```

## Claiming

**Primary:** dropdown on `/stockpost`.

**Text variants also work** (if only one product is live, the name can be omitted):

- `claim 2x mega dream`
- `claim 2 mega dream`
- `claim x2 mega dream`
- `claim 2x` / `claim 2` / `claim x2`
- `2x claim mega dream` / `2x claim`
- `2x mega dream`

## Data

SQLite stores buyers (including city/state/zip), ban history, products (price + flat shipping), and orders.

## Out of scope (v1)

Automated PayID / bank-feed verification — payment stays manual.

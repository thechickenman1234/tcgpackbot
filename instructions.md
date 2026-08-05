# TCG Pack Bot — Claim Sale Discord Bot Specification

## Background

- TCG Pack Bot is a Pokémon TCG (trading card game) reselling business
- This bot is for a new Discord-based "claim sale" system — a common sales format in the TCG reselling community
- Model: seller posts limited stock at set prices → buyers "claim" what they want in a specific message format → each claim becomes a private, trackable order
- Think of it as a lightweight checkout flow built entirely inside Discord instead of a website
- Payment is via PayID/bank transfer (Australian instant payment system), confirmed manually — not card/PayPal

---

## Why private threads

- Using Discord's private threads for tickets — invisible to everyone except the buyer and staff added to them, same privacy as a dedicated channel
- No boost requirement — available on a normal server
- Threads don't count against Discord's 500-channel cap, so there's no risk of ever running out of space even at high claim volume
- Closed/resolved tickets can still auto-archive after a set period (e.g. 7 days post-shipment) for tidiness, but this isn't a hard requirement the way it would be with channels

---

## Stage 1 — Claim becomes a private ticket (automatic)

- Seller posts available stock in a public channel: product name, price, quantity available, sale window time
- Buyers respond using a **strict, required format**: `claim [quantity]x [product]`
    - Example: `claim 2x mega dream`
    - Format must stay strict — the bot is parsing free-form text, so predictability = reliability
- On a **valid** claim (correct format, product exists, still in stock):
    - Bot reacts with a checkmark in the public channel
    - Bot immediately creates a new private thread, visible only to that buyer + staff
    - Buyer is auto-added directly (no invite link — the thread appears in their list automatically, with a notification)
- On an **invalid** claim (wrong format, sold out, duplicate):
    - Bot rejects it silently or with a brief reason
    - No thread created

## Stage 2 — Ticket becomes a paid, shipped order

- Thread opens with a short intake form (use Discord's native modal/form UI): name, phone number, shipping address
- On form submission, bot automatically posts:
    - Seller's PayID
    - Exact amount owed (calculated from claimed quantity × active price)
    - Unique order reference code
    - Payment deadline: **2 hours** from ticket creation (should be configurable)
- Buyer transfers payment, posts a screenshot of it in the channel
- **Payment confirmation is manual** — a staff member checks the screenshot against the reference code/amount and applies a "paid" tag
    - This is intentional: PayID transfers aren't reversible like card payments, so manual confirmation avoids fraud exposure. Do not build automatic payment verification for v1.
- Once shipped, staff applies a "shipped" tag
- Thread **auto-archives 7 days after the "shipped" tag is applied** — keeps the active thread list tidy; not a hard cap concern since threads don't count toward the 500-channel limit

## Stage 3 — No-show handling (unpaid claims)

- If the 2-hour payment deadline passes with no "paid" tag applied:
    - Bot automatically bans the buyer from making future claims
    - Bot logs the incident (buyer, product, amount, timestamp) in a staff-only channel
    - The abandoned thread is closed and archived
- Bans are **not permanent by default**:
    - Banned buyer can submit an appeal (e.g. a dedicated `#appeals` channel or a button/command) explaining their reason
    - A staff member manually reviews and lifts the ban if valid
    - **Unbanning must always be a manual decision — never automatic**

---

## Data the bot needs to store persistently

*(Not just relying on Discord message history — needs a real database, e.g. SQLite is sufficient for this scale)*

**Buyer records**

- Discord user ID
- Name, phone, shipping address (from intake form)
- Ban/strike status and history (timestamp, reason, appeal outcome)

**Order records**

- Unique order reference code
- Buyer ID, product, quantity, price
- Status: `pending` → `paid` → `shipped` → `archived`
- Associated thread ID
- Timestamps: claimed, payment deadline, paid, shipped

---

## Roles and permissions

- **Staff role**: can view all ticket threads, apply "paid"/"shipped" tags, review appeals, manually ban/unban
- **Buyers**: no special server-wide role needed — access is scoped per-thread by the bot at creation
- Consider a "banned" flag/role the bot checks during claim validation, to silently block claims from banned users

---

## Explicitly out of scope for v1 (phase 2 later)

- Automated PayID payment verification (matching a live bank feed/webhook) — blocked on confirming a business bank account that supports this

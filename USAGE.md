# TCG Pack Bot — How to Use (Staff Guide)

This bot runs **claim sales** inside Discord.  
Buyers claim stock → get a private ticket → pay via PayID → you manually confirm.

---

## Quick start (one sale)

1. Make sure the bot is online.
2. Add the product for this sale:
   ```
   /product add name:mega dream price:150 quantity:10 shipping:15 limit:2
   ```
   - `shipping` and `limit` are optional  
   - `limit` = max units **each person** can buy of that product  
   - Omit `limit` for no per-person cap
3. Post the sale in your **claims channel**:
   ```
   /stockpost
   ```
   The stock post **auto-updates** after claims, cancels, and stock changes.
4. Buyers claim with the dropdown (or text — see below).
5. When you’re done (or everything is gone), end it:
   ```
   /endsale
   ```
   Or let the bot end it automatically when stock hits zero.

That’s the whole loop. One active claim sale at a time.

---

## Buyer experience

### Main way (recommended)
1. Open the stock post.
2. Use the dropdown: **Claim a product…**
3. Enter **quantity**.
4. First-time buyers also enter:
   - Full name  
   - Phone  
   - Street address  
   - City, State, ZIP (e.g. `Melbourne, VIC, 3000`)
5. Bot opens a **private thread** with:
   - PayID  
   - Item total + shipping  
   - Order reference (must be on the transfer)  
   - Payment deadline  
6. Buyer pays and posts a **screenshot** in the thread.
7. You confirm with `/paid`, then later `/shipped`.

Returning buyers only need quantity — their shipping details are saved.

### Top-ups (same product)
If a buyer still has a **pending** claim for a product and is under the per-person limit, another claim **adds quantity to the same ticket** (no second thread). Shipping stays flat once. They must pay the **new total**.

### Per-person limits
If a product has a limit (e.g. max 2 per person):
- the stock post and dropdown show it
- a claim above the remaining allowance is rejected
- cancelled orders do **not** count toward the limit (paid / shipped / archived do)

### Change shipping later
Buyers (or staff) can update saved address with:
```
/shipping
```
Staff can update someone else:
```
/shipping user:@buyer
```
There is also an **Update shipping** button in the ticket.

### Payment reminder
About **1 hour before** the deadline (configurable), the bot pings the buyer in their ticket.

### Text claims (also work)
If only **one** product is live, the product name can be left out.

Examples:
- `claim 2x mega dream`
- `claim 2 mega dream`
- `claim x2 mega dream`
- `claim 2x` / `claim 2` / `claim x2`
- `2x claim mega dream`
- `2x claim`
- `2x mega dream`

Valid claim → ✅ reaction + private ticket (or top-up on an existing pending ticket).  
Invalid / sold out / over limit → short error (or silent if banned).

---

## Staff commands

| Command | What it does |
|---------|----------------|
| `/product add` | Add a product (`name`, `price`, `quantity`, optional `shipping`, optional `limit`, optional `sale_window`) |
| `/product stock` | Change remaining quantity (**reactivates** the product if qty > 0) |
| `/product price` | Change unit price |
| `/product shipping` | Change flat shipping cost |
| `/product limit` | Set or clear per-person purchase limit (`max:0` = unlimited) |
| `/product activate` | Put a product back on the live sale (needs stock > 0) |
| `/product deactivate` | Take a product off the live sale |
| `/product list` | List all products (shows limit when set) |
| `/stockpost` | Post the public sale embed + claim dropdown (**must be in claims channel**) |
| `/endsale` | End the sale + post the “CLAIM SALE IS NOW OVER” message |
| `/paid` | Mark ticket as paid (run in the ticket thread, or pass `reference`) |
| `/shipped` | Mark as shipped (starts 7-day auto-archive) |
| `/cancel` | Cancel a **pending** claim, return stock, close ticket |
| `/shipping` | Update buyer shipping details (optional `user` for staff) |
| `/order` | Look up an order by reference (e.g. `TCG-A1B2C3`) |
| `/ban` | Manually ban someone from claiming |
| `/unban` | Manually lift a ban (**never automatic**) |
| `/appeal submit` | Buyer submits an appeal |
| `/appeal reject` / `/appeal history` | Staff review tools |

### Example: start Mega Dream sale (with 2-per-person limit)
```
/product add name:mega dream price:150 quantity:10 shipping:15 limit:2
/stockpost
```

### Example: restock after sold out
```
/product stock name:mega dream quantity:5
```
(or `/product activate` if stock is already set)

### Example: cancel a bad claim
Run inside the ticket:
```
/cancel reason:buyer asked to cancel
```
Or:
```
/cancel reference:TCG-A1B2C3 reason:duplicate
```

### Example: change or remove a limit later
```
/product limit name:mega dream max:3
/product limit name:mega dream max:0
```

Price = per unit.  
Shipping = **flat per order** (added once to the total; top-ups do not add shipping again).  
Limit = **max units per Discord user** for that product (optional).

---

## Sale lifecycle messages

### Sold out
When a product hits **0** remaining, the bot posts something like:

> **[MEGA DREAM] SOLD OUT!** No more claims for this product.

That product is taken off the live sale. Restocking with `/product stock` (qty > 0) brings it back.

### Sale over
When:
- you run `/endsale`, **or**
- nothing with stock is left,

the bot posts:

> **[PRODUCT] CLAIM SALE IS NOW OVER!!!** Please check the thread that opened up for payment and shipping details. Payments must be sent within **X hours**, or you will be banned from all future Claim Sales. DM staff if you have any issues.

`X` comes from `PAYMENT_DEADLINE_HOURS` in `.env` (default **24**).

---

## Payment & tickets

1. Buyer gets PayID + exact amount + order reference in their private thread.
2. They transfer and post a screenshot.
3. You check amount + reference, then run **`/paid`** in that thread.
4. After you ship, run **`/shipped`**.
5. Thread auto-archives **7 days** after shipped.
6. Need to void a pending claim? **`/cancel`** returns stock (no ban).

There is **no automatic bank matching**. Confirmation is always manual on purpose.

---

## No-shows & bans

If payment is **not** marked `/paid` before the deadline:
- buyer gets a reminder ~1 hour before (default)
- then buyer is **banned from future claims**
- incident is logged in the staff log channel
- their ticket is closed/archived
- stock is returned and the product can go live again

Banned buyers can use `/appeal submit` (or post in `#appeals` if you set that up).  
**Only staff can unban** with `/unban`. The bot never unbans automatically.

Manual `/cancel` does **not** ban the buyer.

---

## Roles & channels you need

| Piece | Purpose |
|-------|---------|
| Claims channel | Where `/stockpost` goes and buyers claim |
| Staff log channel | No-shows, bans, appeals |
| Optional appeals channel | Free-text ban appeals |
| Staff role | Can manage sales / paid / shipped / bans |
| Optional Banned role | Bot can assign this on no-show |

Staff should have **Manage Threads** so they can see private claim tickets.

---

## Environment settings (host machine)

Important `.env` values:

| Variable | Meaning |
|----------|---------|
| `DISCORD_TOKEN` | Bot token |
| `DISCORD_CLIENT_ID` | Application ID |
| `DISCORD_GUILD_ID` | Your server ID |
| `CLAIMS_CHANNEL_ID` | Public claims channel |
| `STAFF_LOG_CHANNEL_ID` | Staff-only log channel |
| `STAFF_ROLE_ID` | Staff role |
| `BANNED_ROLE_ID` | Optional banned role |
| `APPEALS_CHANNEL_ID` | Optional |
| `PAYID` | PayID shown to buyers |
| `PAYMENT_DEADLINE_HOURS` | Default `24` |
| `PAYMENT_REMINDER_HOURS_BEFORE` | Default `1` (ping before ban) |
| `ARCHIVE_DAYS_AFTER_SHIPPED` | Default `7` |

Slash commands register **automatically when the bot starts**. Restart the bot after updates so new commands/options appear.

---

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Typing “Claim sale mega dream $150…” in chat | That’s not a command. Use `/product add` then `/stockpost`. |
| `/stockpost` outside claims channel | Bot will refuse. Run it in the claims channel. |
| Buyer says product unknown | Product wasn’t added, or name doesn’t match. Check `/product list`. |
| Restocked but still sold out | Use `/product stock` (auto-activates) or `/product activate`. |
| Buyer hits “limit reached” | They already claimed up to `/product limit` for that product. Raise or clear with `/product limit`. |
| Stock post looks stale | Run `/stockpost` once; after that it auto-refreshes. |
| Commands / new options missing | Restart the bot so commands re-register. |
| Staff can’t see tickets | Give staff **Manage Threads** (and the Staff role). |

---

## Suggested staff checklist per sale

- [ ] `/product add` with price, qty, shipping, and optional per-person `limit`  
- [ ] `/stockpost` in claims channel  
- [ ] Watch tickets for payment screenshots  
- [ ] `/paid` when confirmed  
- [ ] Pack & ship → `/shipped`  
- [ ] `/cancel` if a pending claim needs to be voided  
- [ ] `/endsale` if you stop early (otherwise bot ends when sold out)

---

## What the bot does **not** do (v1)

- Automatic PayID / bank verification  
- Holding long-term inventory between sales (treat each sale as its own live stock)  
- Auto-unban  

If something breaks, check the bot host logs and the staff log channel first.

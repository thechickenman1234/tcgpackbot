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
| `/label` | Change what an order's shipping label says (run in its ticket, or pick the order). Opens a box with the current text; clear it to go back to the default. Topping up the order resets it |
| ✏️ Change quantity | Fix how many an order is for (a claim of 20 that meant 10). Tap **Change quantity (staff)** on the ticket, or in an older ticket long-press any message → **Apps → Change quantity**. Type the number: stock, total and label follow, and the buyer is told what they now owe (or what gets refunded if they'd paid). Staff only; pending and paid orders |
| `/banned` | Everyone banned from claims: when, why, by whom, and who has appealed. `lifted: True` adds bans lifted in the last 30 days |
| `/dashboard` | Open the profit dashboard on your phone: type in costs (estimate or real) and other expenses, see profit by week, month and product. The button works once within 15 minutes; the device then stays signed in for 30 days |
| `/cost` | Same as the dashboard's cost box: what one unit cost you, landed. Counts as the real cost unless `estimate: True`. `fix: True` re-prices orders already sold, for a cost typed wrong. `/newsale` takes `cost` too (as the estimate) |
| `/profit` | Sales, stock cost, postage and profit for today, this or last week, this or last month, 30 days or all time. Optional `product` |
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

## Tracking from label PDFs

After a post office run, drop the Label Pro label PDFs (or screenshots or photos of labels) in the shipping channel: the one with the shipping panel, or any channel with "ship" or "label" in its name. Staff only.

For each label the bot reads:
- the **tracking number** from the square barcode (the AusPost article id), and
- the **To: name** and the **Ref:** line from the picture itself (Label Pro labels are pictures, so this is read like a photo).

It matches the label to the waiting order by the `TCG-` reference on the Ref line (a misread letter or two is fine), or by the buyer's name when there's no reference. Then it posts the tracking in the buyer's ticket, marks the order posted and syncs the sheet. One reply lists what it did. Anything it can't be sure of comes back as buttons: two waiting orders for the same name, or a label that matches nothing.

**Part of an order:** if a label's Ref says fewer than the order (e.g. "1x storm" on a 2x order, edited with `/label`), that parcel goes out as part of the order. The buyer is told what's in this parcel and what's still to come, and the rest goes back on **Print labels** with a label reading "(rest)". Forgot to edit the label? Tap **Part only** under the reply and pick how many were in it. When the rest is posted and its label dropped, the buyer gets "the rest of your order is on its way" and the order is marked posted.

Dropping the same label twice does nothing the second time. The old 🔢 Add tracking paste still works.

---

## Money in and out: Wise and wholesale

**Wise:** with a read-only token in `WISE_API_TOKEN` on Railway (Wise: Settings → API tokens → Add new token → Read only), the bot pulls every Wise payment every 3 hours (and on **Sync now** on the dashboard), back to `WISE_SINCE` (default 1 Jul 2026). Payments to or from `WISE_OWN_NAME` (default Lachlan Nguyen) are tagged *not business* on arrival. Everything else waits under **Money in and out → To tag**, once each:

- **Stock**: pick the product and how many units it paid for. The product's real cost per unit becomes this payment (plus any others within 3 days, for a split payment) plus freight tagged to it, over those units.
- **Freight**: the same, for shipping, added on top. Freight that isn't for one product: tag it **Expense**.
- **Expense**: becomes an Other expense on that day.
- **Wholesale sale** (money in): fill in the product and how many; it becomes a wholesale sale.
- **Not business**: left out.

A cancelled or bounced payment never shows. **Undo** puts a payment back on the list (a real cost it set stays). A daily 10am staff-log note says when payments are waiting. `GET /ops/wise` syncs and reports what came back, for checking the token.

**Wholesale sales** made outside the bot: **Add a wholesale sale** on the dashboard (customer, product or a new product name, how many, total paid, date, already sent or not). It becomes a paid order with source *wholesale*, so it's in sales, profit, buyers and channels like any other. Not sent yet: it lands on the Labels list. A new product name is added switched off, never on sale.

**Cash check:** next to profit (what sold, at its cost), the Money section shows money in (sales) against money out of Wise (tagged stock, freight, expenses, plus labels), and how much went out of Wise untagged. Payments made outside Wise (NAB international transfers, cards) aren't in it.

---

## Order sheet

When claims close (midnight, a sell-out, or `/endsale`), the staff log gets the supplier order for that night:

- each product: units claimed, how many paid and how many still to pay (and how many sent a payment screenshot)
- how many to order: claimed plus a few spare, 5% rounded up and at least 1 (`ORDER_SPARE_PERCENT` to change)
- what that costs at the product's landed cost, and the night's rough profit before postage
- a message for each supplier, ready to copy, split by the language at the start of the product's long name (Japanese, Chinese)

Only that night's claim-sale orders count. Cancelled orders, your own test orders and wholesale logged by hand are left out. A product that sold out earlier in the night is still on it.

A **final order sheet** follows about 24 hours later, after the late window has shut and unpaid claims have paid or been cancelled. `/ordersheet` shows the latest night any time, with the numbers as they are right now. Already have some stock in hand or on the way? Take it off before sending.

---

## Profit

Profit is worked out from what the bot already knows, so nothing is typed in per order:

- **Sales**: each paid order's total, including the shipping the buyer paid.
- **Stock cost**: the product's cost per unit x quantity. It starts as the **estimate** from the quote (Claude adds it when it queues a sale, or `cost` on `/newsale`). When the real figure is known (bulk discounts, the actual freight), type it on the dashboard as the **real cost**: it replaces the estimate on every order of that batch. A total works too: `3524/40` is 3524 dollars over 40 boxes.
- **Postage**: the Label Pro label each order took, $4 standard or $6.50 express (`LABEL_COST_STANDARD` / `LABEL_COST_EXPRESS` to change). Orders with no shipping take no label.
- Lachy's own test orders are left out (`PROFIT_EXCLUDE_BUYERS`).

A product with no cost is never guessed: its sales show apart under "Not counted yet" until `/cost` is set.

- **Other expenses** (packaging, fees, tools) go on the dashboard with a date and come off that period's profit. Not stock or labels: those are already counted per order.

**Automatic, in the staff log:** Monday 9am, last week's profit plus anything still on an estimated cost. Daily 10am, a reminder listing anything sold in the last 14 days with no cost yet. Both link to the dashboard.

**The dashboard** lives at the bot's own address, `/dash`, on the ops door's port. It only opens with a `/dashboard` link (one use, 15 minutes), which leaves a 30-day sign-in on that device. Rotating `OPS_SECRET` signs every device out. Every change made on it is posted to the staff log.

A new **estimate** on a product that already has a cost is treated as a new wave: orders already claimed keep the cost they sold at. A **real cost** always applies to the current batch.

---

## Dashboard

`/dashboard` opens it. One period picker at the top (today, this or last week, this or last month, 30 or 90 days, all time) drives every section; the arrows on the key numbers compare with the same stretch one period earlier. Your own test orders are left out everywhere.

- **Needs you now:** products sold with no cost, payment screenshots to check, paid orders not posted (and the oldest), part orders waiting for the rest, unpaid claims, products still on estimated costs.
- **Key numbers:** sales, profit after expenses, average and middle order, buyers and new buyers, units, returning buyers, spend per buyer.
- **Trend:** sales and profit for each of the last 12 weeks (tap a bar), and month by month.
- **Biggest buyers** for the period or all time: what they buy, when they last bought, active or gone quiet. Plus how much your top 10 and 20 make up, the big buyers who've gone quiet (worth a message), who joins the most sale nights, and what people spend in total.
- **What sells:** each product's sales, units, buyers, price each and profit, and the Japanese, Chinese and English split.
- **Sale nights:** each night's sales, units sold of units claimed, no-shows, new buyers and late claims, best night starred, and which nights or channels new buyers came from.
- **Speed and bottlenecks:** time from claim to paid, paid on time, no-shows and what they cost, claimed vs paid, time from paid to posted, posted with tracking, late-claim and express share.
- **Where sales come from:** channel (claims, late, wholesale, Facebook, DM...), state and shipping.
- **The server:** members, how many have bought, how many new members bought, who's chatting, chat by hour, members over time and which invite links bring people who buy. The bot only started counting members each day, chat (how many and when, never what's said, tickets left out) and the invite link each new member used when this was deployed, so those fill in from then.
- **Costs and profit:** the costs to put in, the profit breakdown, every product's cost, and other expenses.

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
3. The bot answers the screenshot with **Paid / Not paid** buttons, in the ticket and in the staff log channel. Check the amount + reference, then press **Paid** (or run **`/paid`** in the thread, same thing).
   - While a screenshot is waiting, the order **can't expire and the buyer can't be banned**, however long it takes you to check.
   - **Not paid** lifts that hold and tells the buyer to send the right screenshot. If their deadline has gone (or is under 2 hours away), they get 2 more hours and a reminder. After that the normal no-show ban applies.
   - If a held order reaches its deadline before anyone has checked it, the bot pings the staff role once in the staff log, with the same buttons.
4. After you ship, run **`/shipped`**.
5. Thread auto-archives **7 days** after shipped.
6. Need to void a pending claim? **`/cancel`** returns stock (no ban).

There is **no automatic bank matching**. Confirmation is always manual on purpose.

---

## No-shows & bans

If payment is **not** marked `/paid` before the deadline, and the buyer hasn't posted a payment screenshot that's waiting on staff:
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

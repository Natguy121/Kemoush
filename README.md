# Stock Manager

A simple inventory tool for someone running a shop: **what's in stock**, **what needs
buying**, and **how much people are buying**.

No installation, no accounts, no internet needed. It's a web page — open it and use it.

## How to open it

1. Download this folder.
2. Double-click **`index.html`**.

That's it. It opens in any browser (Chrome, Edge, Safari, Firefox) on a computer, tablet
or phone. To keep it handy, bookmark the page or add it to the phone's home screen.

The very first time, go to **Settings → Load demo data** to see it filled with an example
shop. When you're ready for real data, **Settings → Erase everything** and start adding
your own products.

## What each page does

| Page | What it answers |
|---|---|
| **Overview** | How much stock do I have, what needs attention, how much is moving |
| **Ask** | Type a question in plain English and get the answer from your own data |
| **Plan** | Stock run down against the monthly demand plan — where the shortfalls land |
| **Orders** | What's on order, when it's due, and what has actually turned up |
| **Products** | The full list — stock level, how fast each one sells, how long it will last |
| **To buy** | The shopping list for suppliers: what to order, how much, and roughly what it costs |
| **Sales** | Every sale recorded, plus today's and this month's totals |
| **Settings** | Shop name, currency, backups, demo data |

## Working with it like a spreadsheet

The **Products** page has two views, switched with the **List / Spreadsheet** toggle:

- **List** — the everyday view, with how fast things sell and what needs attention.
- **Spreadsheet** — every product as an editable grid. Click any cell and type. **Enter**
  or **Tab** saves and moves on, **Esc** undoes, and the **arrow keys** move around, the
  same as Excel. Typing straight over a cell replaces it. Changes save immediately.
  **+ Add a row** puts a new product at the bottom, ready to type into.

### Bringing in an existing product list

**Products → Import from Excel** takes a whole list in one go:

1. In Excel, select your rows **including the header row**, and copy.
2. Click *Import from Excel*, click the box, and paste. (A saved `.csv` file works too.)

It reads the header row to work out which column is which, so the order doesn't matter —
`Code`, `Product`, `Category`, `Supplier`, `Unit`, `In stock`, `Alert at`, `Usual order`,
`Cost` and `Price` are all recognised, along with common alternatives like *SKU*,
*Quantity*, *Buy price* or *Selling price*. Prices written either way round —
`1,234.56` or `1.234,56` — are both understood, and currency symbols are ignored.

Before anything is saved it shows how many products are new, how many it already has, and
a preview of the first few rows. Products already in the list are matched by **code**
first, then by name; leave *Update products that already exist* ticked to refresh them, or
untick it to only add the genuinely new ones.

## Day-to-day use

- **Someone buys something** → *Record a sale*. Stock goes down automatically.
- **A delivery arrives** → *Add stock*. Stock goes up automatically.
- **Time to order** → open **To buy**, then *Print / save as PDF* to send or hand to the
  supplier.
- Made a mistake? Every sale has its own **Undo** button that puts that stock back.

### Undo anything else

There's also an **↺ Undo** button at the top of the page. It appears the moment there's
something to undo, and reverses whatever was just done — an edit, a deleted product, an
import, even *Erase everything*. Click it again to keep walking back through the last
few changes. It remembers even if the page is closed and reopened, so a mistake found
later can still be fixed.

## Asking it questions

The **Ask** page takes a question in plain English and answers it from the products and
plan loaded on that computer:

- *What do I need to order?* — the list, with dates and a rough total
- *What runs short, and when?* — every product heading for a shortfall
- *What is short in November?* — a single month
- *When does AB run out?*, or just name any product for its stock, cover and order date
- *How much will the next order cost?*, *How is my stock overall?*, *Any discontinued?*

It doesn't have to be about stock. Say hello, say you've had a rough day, or say you just
want to talk, and it will answer like a person would rather than like a form — and it
varies how it puts things, so it never repeats itself twice in a row. If someone says
something that sounds like real distress, it stops trying to be clever and points them
towards a person and a crisis line instead.

**What it is, plainly:** this is not a chatbot with a language model behind it, and it
isn't connected to the internet. It recognises what's being asked and then reads the same
figures the rest of the pages use, so anything it tells you can be found on a page. That's
deliberate — for ordering decisions, a confidently invented date would be worse than no
answer, so it only reports what's actually in the data and says so when a question is
outside what it can work out.

The same honesty applies to the company it keeps you: it can listen, respond kindly and
ask something back, but it doesn't understand you the way a person does, and it says so
the first time the conversation turns personal. It's a warm thing to have open at a quiet
hour, not a substitute for someone who can actually sit with you.

## The demand plan

If the spreadsheet has **a column per month** — headings like `Jan-26`, `Jan 2026`,
`2026-01` or `01/2026` are all understood — those columns are read as a **monthly demand
plan** rather than as product fields. A blank month means *nothing planned*, which is not
the same as a planned zero, so blanks are left out rather than stored.

The **Plan** page then runs that plan down against what's in stock and shows what's left at
the end of each month. The first month that goes below zero is the shortfall to solve, and
it's called out in the **Runs short** column; the tab badge counts how many products are
heading for one. Products are sorted by whose shortfall lands first.

A **Status** column is picked up too. Anything reading *Discontinued* (or inactive,
obsolete, delisted) is kept in the records but never suggested for ordering.

Once a plan exists it drives the rest of the maths, because a plan is a deliberate
statement about what is coming and beats extrapolating from the last 30 days:

- **How long stock lasts** is worked out by walking the plan month by month, so a
  ramp-up or a quiet season is accounted for instead of one flat rate.
- **How much to order** covers the demand actually planned across the lead time and the
  cover period.

Without a plan, everything falls back to the recorded sales history as before.

## Purchase orders, including the awkward ones

The **Orders** page tracks an order from the moment it's placed to the moment the last box
turns up — and real deliveries rarely arrive in one tidy piece.

- **One order, several products.** An order goes to a supplier and carries as many lines as
  it needs, each with its own quantity and unit cost.
- **Build from buying list** raises the orders straight from what's due, grouped by
  supplier, with quantities already worked out. They land as drafts to check before sending.
- **Part deliveries.** *Book in delivery* takes what actually arrived, line by line, and can
  be used as many times as it takes. Stock goes up by that amount immediately, the rest stays
  outstanding, and every delivery is kept with its date and note.
- **Short shipments.** If the rest is never coming, tick *close the rest short*. The order
  stops expecting it, and anything still needed reappears on the buying list.
- **Late orders** are flagged the day they pass their expected date, and sorted to the top.
- **Cancelling** an order releases everything it had on the way.

The important part is what this does to the rest of the app: **stock still owed counts as
coming**. It's added to cover, drawn into the Plan projection in the month it's due, and
subtracted from what gets suggested. So a product with an order against it stops appearing
on the buying list instead of being ordered a second time every time she looks — and if a
delivery is closed short, it comes straight back.

## Lead time and the "order by" date

Each product can carry a **lead time** — how many days that supplier takes to deliver.
Set it per product (in the product form, or the **Lead time** column in Spreadsheet mode),
or set one default for everything under **Settings → Default lead time**. Importing a
spreadsheet picks it up automatically from a `Lead time`, `Delivery days` or similar column.

This is what turns a stock list into a supply plan. Stock has to outlast the wait for the
next delivery, so the day the order must be *placed* is earlier than the day the shelf
empties:

```
order-by date = today + (days of stock left − lead time)
```

The **To buy** page shows that date for every product, soonest first, and flags anything
already overdue as *Late by N days*. This catches the case a plain stock level hides: a
product can read **well stocked** and still be late to reorder, simply because its supplier
is slow. Those products appear on the To buy list too, not just the ones below their alert
level.

## How "order this much" is worked out

For each product the app looks at how many went out over the last 30 days and turns that
into a daily rate. Then:

```
order = (daily rate × (days of cover + lead time)) + alert level − what's in stock
```

- **Days of cover** is set in Settings (30 days by default) — how long the new order
  should last once it arrives.
- **Lead time** is added on top, so the order also covers what gets used while waiting for
  the delivery.
- **Alert level** is the per-product "warn me when stock drops to…" figure. It stays in
  the calculation as a safety cushion.
- The result is never smaller than the product's **usual order size**, and it's rounded up
  to whole packs of that size.

A product shows up on the **To buy** page when its stock is at or below its alert level,
**or** when its order-by date has arrived.

## Where the data is kept

Everything is saved **in the browser on that device** — nothing is sent anywhere. That
means:

- The data stays private.
- It does **not** sync between devices.
- Clearing the browser's site data would erase it.

So: **Settings → Download backup** every so often, and keep the file somewhere safe
(email it to yourself, or put it in a cloud folder). *Restore from backup* puts it all
back. Products and sales can also be exported as CSV to open in Excel or Google Sheets.

## Files

```
index.html   the page
styles.css   the look (light and dark themes)
app.js       all the logic — stock, sales, reorder maths, charts
```

Plain HTML, CSS and JavaScript with no libraries and no build step. Edit a file, refresh
the page, done.

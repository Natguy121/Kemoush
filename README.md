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
| **Overview** | How much stock do I have, what needs attention, how much is selling, how many customers |
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

## How "order this much" is worked out

For each product the app looks at how many were sold over the last 30 days and turns that
into a daily selling rate. Then:

```
order = (daily rate × days of cover) + alert level − what's in stock
```

- **Days of cover** is set in Settings (30 days by default) — how long the new order
  should last.
- **Alert level** is the per-product "warn me when stock drops to…" figure. It stays in
  the calculation as a safety cushion.
- The result is never smaller than the product's **usual order size**, and it's rounded up
  to whole packs of that size.

A product shows up on the **To buy** page as soon as its stock is at or below its alert
level.

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

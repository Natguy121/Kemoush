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

## Day-to-day use

- **Someone buys something** → *Record a sale*. Stock goes down automatically.
- **A delivery arrives** → *Add stock*. Stock goes up automatically.
- **Time to order** → open **To buy**, then *Print / save as PDF* to send or hand to the
  supplier.
- Made a mistake? Every sale has an **Undo** button that puts the stock back.

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

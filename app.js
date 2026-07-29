/* ==========================================================================
   Stock Manager
   A small inventory tool: what's in stock, what needs buying, what's selling.
   Plain JavaScript, no dependencies. Data lives in this browser's storage.
   ========================================================================== */

'use strict';

const STORAGE_KEY = 'stockManager.v1';
const THEME_KEY = 'stockManager.theme';

/* ── Small helpers ─────────────────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clampNum = (v, min = 0) => Math.max(min, Number(v) || 0);
const pad2 = (n) => String(n).padStart(2, '0');

const nf = new Intl.NumberFormat();
const num = (n) => nf.format(Math.round((Number(n) || 0) * 100) / 100);

function money(n) {
  const sym = db.settings.currency || '$';
  const v = Number(n) || 0;
  return sym + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Local-time date key, "2026-07-28". Never use toISOString here — it shifts by timezone. */
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = String(k).split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const c = new Date(d); c.setDate(c.getDate() + n); return c; };
const daysBetween = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 86400000);

const shortDate = (k) => parseKey(k).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const longDate = (k) => parseKey(k).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/* ── Storage ───────────────────────────────────────────────────────────── */

const emptyDb = () => ({
  version: 1,
  products: [],
  sales: [],
  restocks: [],
  settings: { shopName: '', currency: '$', coverDays: 30 },
});

let db = emptyDb();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') db = normalise(parsed);
  } catch (err) {
    console.warn('Could not read saved data:', err);
    toast('Saved data could not be read — starting empty.');
  }
}

function normalise(input) {
  const base = emptyDb();
  return {
    version: 1,
    products: Array.isArray(input.products) ? input.products.map(normProduct) : [],
    sales: Array.isArray(input.sales) ? input.sales.map(normSale).filter(Boolean) : [],
    restocks: Array.isArray(input.restocks) ? input.restocks.map(normRestock).filter(Boolean) : [],
    settings: { ...base.settings, ...(input.settings || {}) },
  };
}

const normProduct = (p) => ({
  id: p.id || uid(),
  name: String(p.name || 'Unnamed'),
  sku: String(p.sku || ''),
  category: String(p.category || ''),
  supplier: String(p.supplier || ''),
  unit: String(p.unit || ''),
  stock: clampNum(p.stock),
  reorderPoint: clampNum(p.reorderPoint),
  reorderQty: clampNum(p.reorderQty),
  cost: clampNum(p.cost),
  price: clampNum(p.price),
  createdAt: p.createdAt || dateKey(),
});

const normSale = (s) => (s && s.productId ? {
  id: s.id || uid(),
  productId: s.productId,
  qty: clampNum(s.qty, 1),
  unitPrice: clampNum(s.unitPrice),
  buyer: String(s.buyer || ''),
  date: s.date || dateKey(),
} : null);

const normRestock = (r) => (r && r.productId ? {
  id: r.id || uid(),
  productId: r.productId,
  qty: clampNum(r.qty, 1),
  unitCost: clampNum(r.unitCost),
  date: r.date || dateKey(),
} : null);

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch (err) {
    console.error(err);
    toast('Could not save — the browser storage may be full.');
  }
}

/* ── Derived numbers ───────────────────────────────────────────────────── */

const productById = (id) => db.products.find((p) => p.id === id);

/** Sales rows on or after `fromKey` (and before `toKey` when given). */
function salesInRange(fromKey, toKey) {
  return db.sales.filter((s) => s.date >= fromKey && (!toKey || s.date <= toKey));
}

function unitsSold(productId, fromKey, toKey) {
  return db.sales.reduce((sum, s) => (
    s.productId === productId && s.date >= fromKey && (!toKey || s.date <= toKey) ? sum + s.qty : sum
  ), 0);
}

/** Average units sold per day, measured over the last 30 days the product existed. */
function velocity(p) {
  const window = 30;
  const from = dateKey(addDays(new Date(), -(window - 1)));
  const sold = unitsSold(p.id, from);
  const age = Math.max(1, daysBetween(p.createdAt, dateKey()) + 1);
  return sold / Math.min(window, age);
}

/** How many days the current stock lasts at the recent selling rate. */
function daysOfCover(p) {
  const v = velocity(p);
  return v > 0 ? p.stock / v : Infinity;
}

function status(p) {
  if (p.stock <= 0) return 'out';
  if (p.stock <= p.reorderPoint) return 'low';
  return 'ok';
}

const STATUS_TEXT = { out: 'Out of stock', low: 'Running low', ok: 'Well stocked' };

/**
 * How much to buy: enough to cover the next `coverDays` of selling, plus the
 * alert level as a cushion, minus what's on the shelf — never less than the
 * usual order size, and rounded up to whole packs.
 */
function suggestedOrder(p) {
  const coverDays = clampNum(db.settings.coverDays, 1) || 30;
  let qty = Math.ceil(velocity(p) * coverDays + p.reorderPoint - p.stock);
  if (qty < p.reorderQty) qty = p.reorderQty;
  if (p.reorderQty > 1) qty = Math.ceil(qty / p.reorderQty) * p.reorderQty;
  return Math.max(1, qty);
}

const needsOrder = () => db.products.filter((p) => status(p) !== 'ok');

/* ── Toast & confirm ───────────────────────────────────────────────────── */

let toastTimer;
function toast(msg) {
  const node = $('#toast');
  node.textContent = msg;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}

function confirmAction(title, body, okLabel = 'Yes, do it') {
  return new Promise((resolve) => {
    const modal = $('#confirmModal');
    $('#confirmTitle').textContent = title;
    $('#confirmBody').textContent = body;
    $('#confirmOk').textContent = okLabel;
    let confirmed = false;
    const onSubmit = () => { confirmed = true; };
    const onClose = () => {
      modal.removeEventListener('close', onClose);
      $('#confirmOk').removeEventListener('click', onSubmit);
      resolve(confirmed);
    };
    $('#confirmOk').addEventListener('click', onSubmit);
    modal.addEventListener('close', onClose);
    modal.showModal();
  });
}

/* ── Charts ────────────────────────────────────────────────────────────── */

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

/** "Nice" axis top so gridlines land on round numbers. */
function niceMax(max) {
  if (max <= 0) return 4;
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const norm = max / step;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return mult * step;
}

function attachTooltip(wrap, target, html) {
  target.addEventListener('mouseenter', () => {
    let tip = $('.tooltip', wrap);
    if (!tip) { tip = document.createElement('div'); tip.className = 'tooltip'; wrap.appendChild(tip); }
    tip.innerHTML = html;
    const t = target.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(t.left - w.left + t.width / 2, 60), w.width - 60)}px`;
    tip.style.top = `${t.top - w.top - 6}px`;
    tip.hidden = false;
  });
  target.addEventListener('mouseleave', () => { const tip = $('.tooltip', wrap); if (tip) tip.hidden = true; });
}

/**
 * The SVG is drawn in a fixed 640-unit coordinate system and scaled to the
 * container, so text drawn at "11px" shrinks with it. `unitsPerPx` converts a
 * wanted on-screen size into drawing units, keeping labels readable on a phone.
 */
const chartScale = (wrap, viewW = 640) => Math.max(1, viewW / (wrap.clientWidth || viewW));
const setFont = (node, px) => { node.style.fontSize = `${px}px`; return node; };

/**
 * Vertical bars over time. One series (units sold), so no legend is needed —
 * the card title names it. Values live in the tooltip, not on every bar.
 */
function renderBarChart(wrap, rows, opts = {}) {
  wrap.innerHTML = '';
  if (!rows.length || rows.every((r) => r.value === 0)) {
    wrap.innerHTML = `<p class="chart-empty">${esc(opts.emptyText || 'Nothing sold in this period yet.')}</p>`;
    return;
  }

  const k = chartScale(wrap);
  const font = 11 * k;
  const W = 640, H = (k > 1.3 ? 330 : 240);
  const padL = 30 + 14 * k, padR = 8, padT = 12, padB = 14 + 12 * k;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const top = niceMax(Math.max(...rows.map((r) => r.value)));
  const y = (v) => padT + plotH - (v / top) * plotH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.ariaLabel || 'Units sold over time' });

  for (let i = 0; i <= 4; i++) {
    const v = (top / 4) * i;
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: padL, x2: W - padR, y1: y(v), y2: y(v) }));
    const label = setFont(svgEl('text', { class: 'tick-label', x: padL - 8, y: y(v) + font / 3, 'text-anchor': 'end' }), font);
    label.textContent = num(v);
    svg.appendChild(label);
  }
  svg.appendChild(svgEl('line', { class: 'axis-line', x1: padL, x2: W - padR, y1: y(0), y2: y(0) }));

  const slot = plotW / rows.length;
  const barW = Math.max(3, Math.min(34, slot - 2)); // 2px surface gap between bars
  const radius = Math.min(4, barW / 2);

  rows.forEach((row, i) => {
    const cx = padL + slot * i + slot / 2;
    const x = cx - barW / 2;
    const h = row.value > 0 ? Math.max(radius, y(0) - y(row.value)) : 0;

    if (h > 0) {
      // Rounded top, square foot on the baseline.
      const bar = svgEl('path', {
        class: 'bar',
        d: `M${x} ${y(0)} L${x} ${y(0) - h + radius} Q${x} ${y(0) - h} ${x + radius} ${y(0) - h}
            L${x + barW - radius} ${y(0) - h} Q${x + barW} ${y(0) - h} ${x + barW} ${y(0) - h + radius}
            L${x + barW} ${y(0)} Z`,
      });
      svg.appendChild(bar);
    }
    // A full-height hit area so small bars are still easy to hover.
    const hit = svgEl('rect', { class: 'bar-hit', x: padL + slot * i, y: padT, width: slot, height: plotH });
    svg.appendChild(hit);
    hit.addEventListener('mouseenter', () => { const b = svg.querySelectorAll('.bar')[rows.slice(0, i).filter((r) => r.value > 0).length]; if (b && row.value > 0) b.classList.add('is-hover'); });
    hit.addEventListener('mouseleave', () => $$('.bar', svg).forEach((b) => b.classList.remove('is-hover')));
    attachTooltip(wrap, hit, `<div class="tooltip-title">${esc(row.tipTitle || row.label)}</div>${(row.tipRows || []).map((r) => `<div class="tooltip-row">${esc(r)}</div>`).join('')}`);

    if (row.tick) {
      const t = setFont(svgEl('text', { class: 'tick-label', x: cx, y: H - padB / 3, 'text-anchor': 'middle' }), font);
      t.textContent = row.tick;
      svg.appendChild(t);
    }
  });

  wrap.appendChild(svg);
}

/** Horizontal bars for best sellers — few rows, so every bar is directly labelled. */
function renderTopChart(wrap, rows) {
  wrap.innerHTML = '';
  if (!rows.length) {
    wrap.innerHTML = '<p class="chart-empty">No sales recorded yet — record a sale to see what moves fastest.</p>';
    return;
  }

  const k = chartScale(wrap);
  const font = 11 * k;
  const rowH = 22 * k + 12, W = 640, padR = 30 * k + 20, labelW = 190;
  const H = rows.length * rowH + 6;
  const top = Math.max(...rows.map((r) => r.value)) || 1;
  const maxChars = Math.max(8, Math.floor((labelW - 10) / (font * 0.55)));
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Best selling products' });

  rows.forEach((row, i) => {
    const y = i * rowH + 4;
    const barH = Math.max(14, rowH * 0.5), radius = 4;
    const full = W - labelW - padR;
    const w = Math.max(radius * 2, (row.value / top) * full);

    const name = setFont(svgEl('text', { class: 'tick-label', x: 0, y: y + barH / 2 + font / 3 }), font);
    name.textContent = row.label.length > maxChars ? `${row.label.slice(0, maxChars - 1)}…` : row.label;
    svg.appendChild(name);

    svg.appendChild(svgEl('path', {
      class: 'bar',
      d: `M${labelW} ${y} L${labelW + w - radius} ${y} Q${labelW + w} ${y} ${labelW + w} ${y + radius}
          L${labelW + w} ${y + barH - radius} Q${labelW + w} ${y + barH} ${labelW + w - radius} ${y + barH}
          L${labelW} ${y + barH} Z`,
    }));

    const value = setFont(svgEl('text', { class: 'bar-label', x: labelW + w + 8, y: y + barH / 2 + font / 3 }), font);
    value.textContent = num(row.value);
    svg.appendChild(value);

    const hit = svgEl('rect', { class: 'bar-hit', x: 0, y, width: W, height: barH });
    svg.appendChild(hit);
    attachTooltip(wrap, hit, `<div class="tooltip-title">${esc(row.label)}</div><div class="tooltip-row">${esc(row.tip)}</div>`);
  });

  wrap.appendChild(svg);
}

/* ── Views ─────────────────────────────────────────────────────────────── */

const ui = {
  view: 'dashboard',
  salesRangeDays: 14,
  productSort: { key: 'name', dir: 1 },
  salesLimit: 25,
};

function renderAll() {
  $('#shopName').textContent = db.settings.shopName || 'Stock Manager';
  document.title = db.settings.shopName ? `${db.settings.shopName} — Stock` : 'Stock Manager';
  renderReorderBadge();
  renderDashboard();
  renderProducts();
  renderReorder();
  renderSales();
  renderSettings();
}

function renderReorderBadge() {
  const badge = $('#reorderBadge');
  const n = needsOrder().length;
  badge.textContent = n;
  badge.hidden = n === 0;
}

function statTile({ label, value, sub, subClass = '', alert = false }) {
  return `<div class="stat${alert ? ' is-alert' : ''}">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value">${esc(value)}</div>
    ${sub ? `<div class="stat-sub ${subClass}">${esc(sub)}</div>` : ''}
  </div>`;
}

/* Overview ---------------------------------------------------------------- */

function renderDashboard() {
  const today = dateKey();
  const week0 = dateKey(addDays(new Date(), -6));
  const week1 = dateKey(addDays(new Date(), -13));

  const thisWeek = salesInRange(week0);
  const lastWeek = salesInRange(week1, dateKey(addDays(new Date(), -7)));
  const unitsThis = thisWeek.reduce((s, x) => s + x.qty, 0);
  const unitsLast = lastWeek.reduce((s, x) => s + x.qty, 0);

  const totalUnits = db.products.reduce((s, p) => s + p.stock, 0);
  const stockValue = db.products.reduce((s, p) => s + p.stock * p.cost, 0);
  const toBuy = needsOrder();
  const outCount = db.products.filter((p) => status(p) === 'out').length;

  const delta = (a, b) => {
    if (b === 0) return a > 0 ? 'new activity this week' : 'same as last week';
    const pct = Math.round(((a - b) / b) * 100);
    return `${pct >= 0 ? '+' : ''}${pct}% vs last week`;
  };
  const deltaClass = (a, b) => (a === b ? '' : a > b ? 'is-good' : 'is-bad');

  $('#statRow').innerHTML = [
    statTile({
      label: 'Items in stock',
      value: num(totalUnits),
      sub: `${num(db.products.length)} different products`,
    }),
    statTile({
      label: 'Needs buying',
      value: num(toBuy.length),
      sub: outCount ? `${num(outCount)} completely out` : 'nothing has run out',
      subClass: outCount ? 'is-bad' : '',
      alert: toBuy.length > 0,
    }),
    statTile({
      label: 'Sold this week',
      value: num(unitsThis),
      sub: delta(unitsThis, unitsLast),
      subClass: deltaClass(unitsThis, unitsLast),
    }),
    statTile({
      label: 'Customers this week',
      value: num(thisWeek.length),
      sub: `${num(salesInRange(today).length)} today`,
    }),
    statTile({
      label: 'Stock is worth',
      value: money(stockValue),
      sub: 'at what you paid for it',
    }),
  ].join('');

  renderSalesChart();
  renderTopSellers();
  renderAttention();
}

function renderSalesChart() {
  const days = ui.salesRangeDays;
  const wrap = $('#salesChart');
  const weekly = days > 30;
  const rows = [];

  if (weekly) {
    const buckets = Math.ceil(days / 7);
    for (let b = buckets - 1; b >= 0; b--) {
      const end = addDays(new Date(), -b * 7);
      const start = addDays(end, -6);
      const from = dateKey(start), to = dateKey(end);
      const rowsIn = salesInRange(from, to);
      rows.push({
        label: `${shortDate(from)} – ${shortDate(to)}`,
        value: rowsIn.reduce((s, x) => s + x.qty, 0),
        tick: b % 2 === 0 ? shortDate(from) : '',
        tipTitle: `Week of ${shortDate(from)}`,
        tipRows: [`${num(rowsIn.reduce((s, x) => s + x.qty, 0))} items sold`, `${num(rowsIn.length)} customers`],
      });
    }
  } else {
    const every = days > 20 ? 5 : 2;
    for (let i = days - 1; i >= 0; i--) {
      const key = dateKey(addDays(new Date(), -i));
      const rowsIn = db.sales.filter((s) => s.date === key);
      rows.push({
        label: shortDate(key),
        value: rowsIn.reduce((s, x) => s + x.qty, 0),
        tick: i % every === 0 ? shortDate(key) : '',
        tipTitle: longDate(key),
        tipRows: [`${num(rowsIn.reduce((s, x) => s + x.qty, 0))} items sold`, `${num(rowsIn.length)} customers`],
      });
    }
  }

  renderBarChart(wrap, rows, { ariaLabel: `Items sold over the last ${days} days` });

  const total = rows.reduce((s, r) => s + r.value, 0);
  const customers = salesInRange(dateKey(addDays(new Date(), -(days - 1)))).length;
  $('#salesChartNote').textContent = total
    ? `${num(total)} items sold to ${num(customers)} customers in the last ${days} days` +
      `${weekly ? ' — each bar is one week.' : ' — each bar is one day.'}`
    : 'Record a sale and it will show up here.';
}

function renderTopSellers() {
  const from = dateKey(addDays(new Date(), -29));
  const totals = new Map();
  for (const s of salesInRange(from)) {
    const cur = totals.get(s.productId) || { qty: 0, revenue: 0, customers: 0 };
    cur.qty += s.qty;
    cur.revenue += s.qty * s.unitPrice;
    cur.customers += 1;
    totals.set(s.productId, cur);
  }
  const rows = [...totals.entries()]
    .map(([id, t]) => {
      const p = productById(id);
      return p ? { label: p.name, value: t.qty, tip: `${num(t.qty)} sold · ${num(t.customers)} customers · ${money(t.revenue)}` } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);

  renderTopChart($('#topChart'), rows);
}

function renderAttention() {
  const rows = needsOrder()
    .sort((a, b) => daysOfCover(a) - daysOfCover(b))
    .slice(0, 6);

  if (!rows.length) {
    $('#attentionList').innerHTML = '<p class="empty">Everything is above its alert level. Nothing to buy today. 🎉</p>';
    return;
  }

  $('#attentionList').innerHTML = `<div class="table-scroll"><table class="table">
    <thead><tr><th>Product</th><th class="num">Left</th><th class="num">Lasts about</th><th>Status</th><th class="num">Buy</th></tr></thead>
    <tbody>${rows.map((p) => {
      const st = status(p);
      const cover = daysOfCover(p);
      return `<tr>
        <td><span class="p-name">${esc(p.name)}</span>${p.category ? `<div class="p-meta">${esc(p.category)}</div>` : ''}</td>
        <td class="num">${num(p.stock)}</td>
        <td class="num">${cover === Infinity ? '—' : `${num(Math.floor(cover))} days`}</td>
        <td><span class="pill is-${st}">${STATUS_TEXT[st]}</span></td>
        <td class="num strong">${num(suggestedOrder(p))}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

/* Products ---------------------------------------------------------------- */

function visibleProducts() {
  const q = $('#productSearch').value.trim().toLowerCase();
  const cat = $('#categoryFilter').value;
  const st = $('#statusFilter').value;

  const from30 = dateKey(addDays(new Date(), -29));
  let rows = db.products.map((p) => ({ p, sold30: unitsSold(p.id, from30), st: status(p) }));

  if (q) rows = rows.filter(({ p }) => [p.name, p.sku, p.category, p.supplier].join(' ').toLowerCase().includes(q));
  if (cat) rows = rows.filter(({ p }) => p.category === cat);
  if (st) rows = rows.filter((r) => r.st === st);

  const { key, dir } = ui.productSort;
  rows.sort((a, b) => {
    const va = key === 'name' ? a.p.name.toLowerCase() : key === 'sold30' ? a.sold30 : a.p[key];
    const vb = key === 'name' ? b.p.name.toLowerCase() : key === 'sold30' ? b.sold30 : b.p[key];
    return va < vb ? -dir : va > vb ? dir : 0;
  });
  return rows;
}

function renderProducts() {
  // Category pickers stay in sync with whatever categories exist.
  const cats = [...new Set(db.products.map((p) => p.category).filter(Boolean))].sort();
  const filter = $('#categoryFilter');
  const keep = filter.value;
  filter.innerHTML = `<option value="">All categories</option>${cats.map((c) => `<option>${esc(c)}</option>`).join('')}`;
  filter.value = cats.includes(keep) ? keep : '';
  $('#categoryList').innerHTML = cats.map((c) => `<option value="${esc(c)}"></option>`).join('');

  const rows = visibleProducts();
  const body = $('#productTable tbody');
  body.innerHTML = rows.map(({ p, sold30, st }) => {
    const cover = daysOfCover(p);
    return `<tr data-id="${p.id}">
      <td>
        <span class="p-name">${esc(p.name)}</span>
        <div class="p-meta">${[p.sku, p.category, p.supplier].filter(Boolean).map(esc).join(' · ') || '—'}</div>
      </td>
      <td class="num strong">${num(p.stock)}${p.unit ? ` <span class="p-meta">${esc(p.unit)}</span>` : ''}</td>
      <td class="num">${num(p.reorderPoint)}</td>
      <td class="num">${num(sold30)}</td>
      <td class="num">${cover === Infinity ? '—' : `${num(Math.floor(cover))} days`}</td>
      <td><span class="pill is-${st}">${STATUS_TEXT[st]}</span></td>
      <td class="num">${money(p.price)}</td>
      <td><div class="cell-actions">
        <button class="btn btn-sm" data-act="buy1" data-id="${p.id}" title="Log one sale instantly">Someone bought it</button>
        <button class="btn btn-sm" data-act="sell" data-id="${p.id}">Sell…</button>
        <button class="btn btn-sm" data-act="restock" data-id="${p.id}">+ Stock</button>
        <button class="btn btn-sm" data-act="edit" data-id="${p.id}">Edit</button>
      </div></td>
    </tr>`;
  }).join('');

  $('#productsEmpty').hidden = rows.length > 0;
  $('#productsEmpty').textContent = db.products.length === 0
    ? 'No products yet. Use “+ New product” to add the first one, or load the demo data from Settings.'
    : 'No products match this search.';

  $$('#productTable .sortable').forEach((th) => {
    th.classList.toggle('sort-asc', th.dataset.sort === ui.productSort.key && ui.productSort.dir === 1);
    th.classList.toggle('sort-desc', th.dataset.sort === ui.productSort.key && ui.productSort.dir === -1);
  });
}

/* To buy ------------------------------------------------------------------ */

function renderReorder() {
  $('#coverDaysLabel').textContent = num(db.settings.coverDays || 30);

  const rows = needsOrder().sort((a, b) => daysOfCover(a) - daysOfCover(b));
  const body = $('#reorderTable tbody');
  let total = 0;

  body.innerHTML = rows.map((p) => {
    const qty = suggestedOrder(p);
    const cost = qty * p.cost;
    total += cost;
    return `<tr data-id="${p.id}">
      <td><span class="p-name">${esc(p.name)}</span>
        <div class="p-meta">${esc(p.sku || p.category || '—')} · ${STATUS_TEXT[status(p)].toLowerCase()}</div></td>
      <td>${esc(p.supplier || '—')}</td>
      <td class="num">${num(p.stock)}</td>
      <td class="num">${num(Math.round(velocity(p) * 7 * 10) / 10)}</td>
      <td class="num strong">${num(qty)}${p.unit ? ` <span class="p-meta">${esc(p.unit)}</span>` : ''}</td>
      <td class="num">${money(cost)}</td>
      <td><div class="cell-actions">
        <button class="btn btn-sm" data-act="restock" data-id="${p.id}">Received it</button>
      </div></td>
    </tr>`;
  }).join('');

  $('#reorderTotal').textContent = money(total);
  $('#reorderEmpty').hidden = rows.length > 0;
  $('#reorderTable').hidden = rows.length === 0;
}

/* Sales ------------------------------------------------------------------- */

function renderSales() {
  const today = dateKey();
  const monthStart = `${today.slice(0, 7)}-01`;
  const todaySales = salesInRange(today);
  const monthSales = salesInRange(monthStart);
  const revenue = monthSales.reduce((s, x) => s + x.qty * x.unitPrice, 0);
  const buyers = new Set(monthSales.map((s) => s.buyer.trim().toLowerCase()).filter(Boolean));

  $('#salesStatRow').innerHTML = [
    statTile({ label: 'Sold today', value: num(todaySales.reduce((s, x) => s + x.qty, 0)), sub: `${num(todaySales.length)} customers today` }),
    statTile({ label: 'Sold this month', value: num(monthSales.reduce((s, x) => s + x.qty, 0)), sub: `${num(monthSales.length)} sales` }),
    statTile({ label: 'Money in this month', value: money(revenue), sub: 'from recorded sales' }),
    statTile({ label: 'Named customers', value: num(buyers.size), sub: 'this month' }),
  ].join('');

  const q = $('#salesSearch').value.trim().toLowerCase();
  let rows = [...db.sales].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  if (q) {
    rows = rows.filter((s) => {
      const p = productById(s.productId);
      return `${p ? p.name : ''} ${s.buyer}`.toLowerCase().includes(q);
    });
  }

  const shown = rows.slice(0, ui.salesLimit);
  $('#salesTable tbody').innerHTML = shown.map((s) => {
    const p = productById(s.productId);
    return `<tr data-id="${s.id}">
      <td>${esc(longDate(s.date))}</td>
      <td><span class="p-name">${esc(p ? p.name : 'Deleted product')}</span></td>
      <td class="num">${num(s.qty)}</td>
      <td>${esc(s.buyer || '—')}</td>
      <td class="num">${money(s.qty * s.unitPrice)}</td>
      <td><div class="cell-actions">
        <button class="btn btn-sm" data-act="undo-sale" data-id="${s.id}">Undo</button>
      </div></td>
    </tr>`;
  }).join('');

  $('#salesEmpty').hidden = rows.length > 0;
  $('#salesEmpty').textContent = db.sales.length === 0 ? 'No sales recorded yet.' : 'No sales match this search.';
  $('#salesMore').hidden = rows.length <= shown.length;
  $('#salesMore').textContent = `Show more (${num(rows.length - shown.length)} older)`;
}

/* Settings ---------------------------------------------------------------- */

function renderSettings() {
  $('#setShopName').value = db.settings.shopName || '';
  $('#setCurrency').value = db.settings.currency || '$';
  $('#setCoverDays').value = db.settings.coverDays || 30;
  $('#storageNote').textContent =
    `Saved on this device: ${num(db.products.length)} products, ${num(db.sales.length)} sales, ${num(db.restocks.length)} stock deliveries.`;
}

/* ── Dialogs ───────────────────────────────────────────────────────────── */

function openProductModal(id) {
  const p = id ? productById(id) : null;
  $('#productModalTitle').textContent = p ? 'Edit product' : 'New product';
  $('#productError').hidden = true;
  $('#p_id').value = p ? p.id : '';
  $('#p_name').value = p ? p.name : '';
  $('#p_sku').value = p ? p.sku : '';
  $('#p_category').value = p ? p.category : '';
  $('#p_supplier').value = p ? p.supplier : '';
  $('#p_unit').value = p ? p.unit : '';
  $('#p_stock').value = p ? p.stock : 0;
  $('#p_reorderPoint').value = p ? p.reorderPoint : 5;
  $('#p_reorderQty').value = p ? p.reorderQty : 10;
  $('#p_cost').value = p ? p.cost : 0;
  $('#p_price').value = p ? p.price : 0;
  $('#deleteProduct').hidden = !p;
  $('#productModal').showModal();
  $('#p_name').focus();
}

function productOptions(selectedId) {
  if (!db.products.length) return '<option value="">Add a product first</option>';
  return [...db.products]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `<option value="${p.id}"${p.id === selectedId ? ' selected' : ''}>${esc(p.name)} — ${num(p.stock)} in stock</option>`)
    .join('');
}

function openSaleModal(productId) {
  $('#s_product').innerHTML = productOptions(productId);
  $('#s_qty').value = 1;
  $('#s_date').value = dateKey();
  $('#s_buyer').value = '';
  $('#saleError').hidden = true;
  updateSaleNote();
  $('#saleModal').showModal();
  $('#s_qty').focus();
  $('#s_qty').select();
}

function updateSaleNote() {
  const p = productById($('#s_product').value);
  if (!p) { $('#saleNote').textContent = ''; $('#s_price').value = ''; return; }
  if (document.activeElement !== $('#s_price')) $('#s_price').value = p.price;
  const qty = clampNum($('#s_qty').value, 0);
  const left = p.stock - qty;
  $('#saleNote').textContent =
    `${p.name}: ${num(p.stock)} in stock now → ${num(Math.max(0, left))} after this sale.` +
    (left <= p.reorderPoint ? '  ⚠️ That drops it to the alert level — it will appear on the buying list.' : '');
}

function openRestockModal(productId) {
  $('#r_product').innerHTML = productOptions(productId);
  $('#r_qty').value = productId ? suggestedOrder(productById(productId)) : 1;
  $('#r_date').value = dateKey();
  updateRestockNote();
  $('#restockModal').showModal();
  $('#r_qty').focus();
  $('#r_qty').select();
}

function updateRestockNote() {
  const p = productById($('#r_product').value);
  if (!p) { $('#restockNote').textContent = ''; return; }
  if (document.activeElement !== $('#r_cost')) $('#r_cost').value = p.cost;
  const qty = clampNum($('#r_qty').value, 0);
  $('#restockNote').textContent = `${p.name}: ${num(p.stock)} in stock now → ${num(p.stock + qty)} after this delivery.`;
}

/* ── Actions ───────────────────────────────────────────────────────────── */

function saveProduct(e) {
  const name = $('#p_name').value.trim();
  if (!name) { e.preventDefault(); $('#productError').textContent = 'Please give the product a name.'; $('#productError').hidden = false; return; }

  const id = $('#p_id').value;
  const fields = {
    name,
    sku: $('#p_sku').value.trim(),
    category: $('#p_category').value.trim(),
    supplier: $('#p_supplier').value.trim(),
    unit: $('#p_unit').value.trim(),
    stock: clampNum($('#p_stock').value),
    reorderPoint: clampNum($('#p_reorderPoint').value),
    reorderQty: clampNum($('#p_reorderQty').value),
    cost: clampNum($('#p_cost').value),
    price: clampNum($('#p_price').value),
  };

  if (id) {
    Object.assign(productById(id), fields);
    toast(`“${name}” updated.`);
  } else {
    db.products.push(normProduct({ ...fields, id: uid(), createdAt: dateKey() }));
    toast(`“${name}” added.`);
  }
  save();
  renderAll();
}

function recordSale(e) {
  const p = productById($('#s_product').value);
  const qty = clampNum($('#s_qty').value, 0);
  const err = $('#saleError');

  if (!p) { e.preventDefault(); err.textContent = 'Pick a product first.'; err.hidden = false; return; }
  if (qty < 1) { e.preventDefault(); err.textContent = 'Enter how many were sold.'; err.hidden = false; return; }
  if (qty > p.stock) {
    e.preventDefault();
    err.textContent = `Only ${num(p.stock)} in stock. Add the delivery first, or lower the quantity.`;
    err.hidden = false;
    return;
  }

  db.sales.push(normSale({
    id: uid(), productId: p.id, qty,
    unitPrice: clampNum($('#s_price').value),
    buyer: $('#s_buyer').value.trim(),
    date: $('#s_date').value || dateKey(),
  }));
  p.stock -= qty;
  save();
  renderAll();
  toast(`Sale recorded — ${num(p.stock)} ${p.name} left.` + (status(p) !== 'ok' ? ' Time to reorder.' : ''));
}

function buyOne(id) {
  const p = productById(id);
  if (!p) return;
  if (p.stock < 1) { toast(`${p.name} is out of stock.`); return; }
  db.sales.push(normSale({ id: uid(), productId: p.id, qty: 1, unitPrice: p.price, buyer: '', date: dateKey() }));
  p.stock -= 1;
  save();
  renderAll();
  toast(`Sold 1 ${p.name} — ${num(p.stock)} left.` + (status(p) !== 'ok' ? ' Time to reorder.' : ''));
}

function recordRestock(e) {
  const p = productById($('#r_product').value);
  const qty = clampNum($('#r_qty').value, 0);
  if (!p || qty < 1) { e.preventDefault(); return; }

  db.restocks.push(normRestock({
    id: uid(), productId: p.id, qty,
    unitCost: clampNum($('#r_cost').value),
    date: $('#r_date').value || dateKey(),
  }));
  p.stock += qty;
  const cost = clampNum($('#r_cost').value);
  if (cost > 0) p.cost = cost;
  save();
  renderAll();
  toast(`Added ${num(qty)} — ${p.name} is now at ${num(p.stock)}.`);
}

async function deleteProduct() {
  const p = productById($('#p_id').value);
  if (!p) return;
  const salesCount = db.sales.filter((s) => s.productId === p.id).length;
  const ok = await confirmAction(
    `Delete “${p.name}”?`,
    salesCount
      ? `This also removes its ${salesCount} recorded sale(s). This cannot be undone.`
      : 'This cannot be undone.',
    'Delete it',
  );
  if (!ok) return;
  db.products = db.products.filter((x) => x.id !== p.id);
  db.sales = db.sales.filter((s) => s.productId !== p.id);
  db.restocks = db.restocks.filter((r) => r.productId !== p.id);
  save();
  renderAll();
  toast(`“${p.name}” deleted.`);
}

async function undoSale(id) {
  const sale = db.sales.find((s) => s.id === id);
  if (!sale) return;
  const p = productById(sale.productId);
  const ok = await confirmAction(
    'Undo this sale?',
    `${num(sale.qty)} × ${p ? p.name : 'product'} will go back into stock.`,
    'Undo the sale',
  );
  if (!ok) return;
  if (p) p.stock += sale.qty;
  db.sales = db.sales.filter((s) => s.id !== id);
  save();
  renderAll();
  toast('Sale removed and stock put back.');
}

/* ── Import / export ───────────────────────────────────────────────────── */

function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');

function exportProductsCsv() {
  const from30 = dateKey(addDays(new Date(), -29));
  const rows = db.products.map((p) => [
    p.name, p.sku, p.category, p.supplier, p.unit, p.stock, p.reorderPoint, p.reorderQty,
    p.cost, p.price, unitsSold(p.id, from30), STATUS_TEXT[status(p)],
    status(p) === 'ok' ? 0 : suggestedOrder(p),
  ]);
  download(`products-${dateKey()}.csv`, toCsv(
    ['Product', 'Code', 'Category', 'Supplier', 'Unit', 'In stock', 'Alert at', 'Usual order',
      'Cost', 'Price', 'Sold last 30 days', 'Status', 'Order this much'], rows), 'text/csv');
  toast('Products exported.');
}

function exportSalesCsv() {
  const rows = [...db.sales]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((s) => {
      const p = productById(s.productId);
      return [s.date, p ? p.name : 'Deleted product', s.qty, s.unitPrice, s.qty * s.unitPrice, s.buyer];
    });
  download(`sales-${dateKey()}.csv`, toCsv(['Date', 'Product', 'Quantity', 'Unit price', 'Total', 'Customer'], rows), 'text/csv');
  toast('Sales exported.');
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let parsed;
    try {
      parsed = JSON.parse(String(reader.result));
    } catch {
      toast('That file is not a valid backup.');
      return;
    }
    if (!parsed || !Array.isArray(parsed.products)) { toast('That file is not a Stock Manager backup.'); return; }
    const ok = await confirmAction(
      'Restore this backup?',
      `It contains ${parsed.products.length} products and ${(parsed.sales || []).length} sales. Everything currently saved will be replaced.`,
      'Restore it',
    );
    if (!ok) return;
    db = normalise(parsed);
    save();
    renderAll();
    toast('Backup restored.');
  };
  reader.readAsText(file);
}

function printPurchaseOrder() {
  const rows = needsOrder().sort((a, b) => daysOfCover(a) - daysOfCover(b));
  if (!rows.length) { toast('Nothing to order right now.'); return; }
  let total = 0;
  const body = rows.map((p) => {
    const qty = suggestedOrder(p);
    total += qty * p.cost;
    return `<tr><td>${esc(p.name)}</td><td>${esc(p.sku || '')}</td><td>${esc(p.supplier || '')}</td>
      <td class="num">${num(p.stock)}</td><td class="num">${num(qty)}</td><td class="num">${esc(money(qty * p.cost))}</td></tr>`;
  }).join('');

  $('#printArea').innerHTML = `
    <h1>Purchase order — ${esc(db.settings.shopName || 'Stock Manager')}</h1>
    <p class="po-meta">Prepared ${esc(longDate(dateKey()))} · ${num(rows.length)} products · stock to cover about ${num(db.settings.coverDays || 30)} days</p>
    <table>
      <thead><tr><th>Product</th><th>Code</th><th>Supplier</th><th class="num">In stock</th><th class="num">Order</th><th class="num">Est. cost</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td colspan="5" class="num"><strong>Total</strong></td><td class="num"><strong>${esc(money(total))}</strong></td></tr></tfoot>
    </table>`;
  window.print();
}

/* ── Demo data ─────────────────────────────────────────────────────────── */

function demoData() {
  const seed = [
    ['Olive oil 1L', 'OIL-1L', 'Groceries', 'Sunfield Foods', 'bottles', 24, 10, 24, 4.20, 8.50, 2.2],
    ['Basmati rice 5kg', 'RIC-5K', 'Groceries', 'Sunfield Foods', 'bags', 6, 8, 20, 6.80, 12.00, 1.4],
    ['Hand soap', 'SOA-250', 'Household', 'CleanCo', 'bottles', 41, 15, 30, 1.10, 2.90, 3.1],
    ['Paper towels 6-pack', 'PAP-6', 'Household', 'CleanCo', 'packs', 0, 6, 18, 3.40, 6.75, 1.1],
    ['Ground coffee 500g', 'COF-500', 'Drinks', 'Bean Route', 'bags', 12, 10, 24, 5.60, 11.00, 2.6],
    ['Green tea 50 bags', 'TEA-50', 'Drinks', 'Bean Route', 'boxes', 33, 8, 16, 2.30, 5.50, 0.9],
    ['Dish sponges 10-pack', 'SPO-10', 'Household', 'CleanCo', 'packs', 4, 6, 24, 1.80, 4.25, 1.3],
    ['Dark chocolate 100g', 'CHO-100', 'Snacks', 'Cacao Lane', 'bars', 58, 20, 40, 1.40, 3.20, 4.0],
    ['Almonds 250g', 'ALM-250', 'Snacks', 'Cacao Lane', 'bags', 19, 12, 24, 3.10, 6.40, 1.7],
    ['Laundry detergent 2L', 'DET-2L', 'Household', 'CleanCo', 'bottles', 9, 8, 12, 5.90, 11.50, 0.8],
  ];
  const names = ['Maria', 'Jonas', 'Amina', 'Peter', 'Lena', 'Sofia', 'Omar', 'Grace', 'Tom', 'Yara', '', '', ''];

  const products = seed.map(([name, sku, category, supplier, unit, stock, rp, rq, cost, price]) =>
    normProduct({ name, sku, category, supplier, unit, stock, reorderPoint: rp, reorderQty: rq, cost, price, createdAt: dateKey(addDays(new Date(), -75)) }));

  const sales = [];
  for (let d = 59; d >= 0; d--) {
    const day = addDays(new Date(), -d);
    const key = dateKey(day);
    const weekend = [0, 6].includes(day.getDay());
    const customers = Math.round((weekend ? 7 : 4) + Math.random() * 5);
    for (let c = 0; c < customers; c++) {
      const idx = Math.floor(Math.pow(Math.random(), 1.6) * products.length); // a few favourites dominate
      const p = products[Math.min(idx, products.length - 1)];
      const rate = seed[products.indexOf(p)][10];
      const qty = Math.max(1, Math.round(rate * (0.4 + Math.random())));
      sales.push(normSale({ id: uid(), productId: p.id, qty, unitPrice: p.price, buyer: names[Math.floor(Math.random() * names.length)], date: key }));
    }
  }

  return {
    version: 1,
    products,
    sales,
    restocks: [],
    settings: { shopName: 'Corner Shop', currency: '$', coverDays: 30 },
  };
}

/* ── Wiring ────────────────────────────────────────────────────────────── */

function showView(name) {
  ui.view = name;
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${name}`));
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === name));
  // Charts measure their container, so they must be drawn while the view is visible.
  if (name === 'dashboard') { renderSalesChart(); renderTopSellers(); }
  window.scrollTo({ top: 0 });
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function init() {
  load();
  applyTheme(localStorage.getItem(THEME_KEY));
  renderAll();

  /* Navigation */
  $$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-view-link]');
    if (link) showView(link.dataset.viewLink);
  });

  /* Theme */
  $('#themeToggle').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem(THEME_KEY, next);
  });

  /* Dialog open buttons + generic close */
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.open === 'product') openProductModal();
    if (b.dataset.open === 'sale') {
      if (!db.products.length) { toast('Add a product first.'); showView('products'); return; }
      openSaleModal();
    }
    if (b.dataset.open === 'restock') {
      if (!db.products.length) { toast('Add a product first.'); showView('products'); return; }
      openRestockModal();
    }
  }));
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  /* Forms */
  $('#productForm').addEventListener('submit', saveProduct);
  $('#saleForm').addEventListener('submit', recordSale);
  $('#restockForm').addEventListener('submit', recordRestock);
  $('#deleteProduct').addEventListener('click', () => { $('#productModal').close(); deleteProduct(); });

  ['#s_product', '#s_qty', '#s_price'].forEach((sel) => $(sel).addEventListener('input', updateSaleNote));
  ['#r_product', '#r_qty', '#r_cost'].forEach((sel) => $(sel).addEventListener('input', updateRestockNote));

  /* Row actions (products, reorder, sales) */
  $('#main').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const { act, id } = btn.dataset;
    if (act === 'edit') openProductModal(id);
    if (act === 'sell') openSaleModal(id);
    if (act === 'buy1') buyOne(id);
    if (act === 'restock') openRestockModal(id);
    if (act === 'undo-sale') undoSale(id);
  });

  /* Filters & sorting */
  $('#productSearch').addEventListener('input', renderProducts);
  $('#categoryFilter').addEventListener('change', renderProducts);
  $('#statusFilter').addEventListener('change', renderProducts);
  $$('#productTable .sortable').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.sort;
    ui.productSort = { key, dir: ui.productSort.key === key ? -ui.productSort.dir : 1 };
    renderProducts();
  }));
  $('#salesSearch').addEventListener('input', () => { ui.salesLimit = 25; renderSales(); });
  $('#salesMore').addEventListener('click', () => { ui.salesLimit += 50; renderSales(); });
  $$('#salesRange .seg-btn').forEach((b) => b.addEventListener('click', () => {
    $$('#salesRange .seg-btn').forEach((x) => x.classList.toggle('is-active', x === b));
    ui.salesRangeDays = Number(b.dataset.days);
    renderSalesChart();
  }));

  /* Reorder */
  $('#printOrder').addEventListener('click', printPurchaseOrder);

  /* Settings */
  $('#saveSettings').addEventListener('click', () => {
    db.settings.shopName = $('#setShopName').value.trim();
    db.settings.currency = $('#setCurrency').value.trim() || '$';
    db.settings.coverDays = Math.min(365, Math.max(1, clampNum($('#setCoverDays').value, 1) || 30));
    save();
    renderAll();
    toast('Settings saved.');
  });

  $('#exportJson').addEventListener('click', () => {
    download(`stock-backup-${dateKey()}.json`, JSON.stringify(db, null, 2));
    toast('Backup downloaded.');
  });
  $('#importJson').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importBackup(file);
    e.target.value = '';
  });
  $('#exportProductsCsv').addEventListener('click', exportProductsCsv);
  $('#exportSalesCsv').addEventListener('click', exportSalesCsv);

  $('#loadDemo').addEventListener('click', async () => {
    const ok = await confirmAction('Load the demo shop?',
      'This replaces anything currently saved with example products and two months of sales.', 'Load demo data');
    if (!ok) return;
    db = demoData();
    save();
    renderAll();
    showView('dashboard');
    toast('Demo data loaded.');
  });

  $('#clearAll').addEventListener('click', async () => {
    const ok = await confirmAction('Erase everything?',
      'All products, sales and settings on this device will be deleted. Download a backup first if you might need it.', 'Erase everything');
    if (!ok) return;
    db = emptyDb();
    save();
    renderAll();
    toast('Everything erased.');
  });

  /* Redraw charts on resize so tooltips stay aligned */
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (ui.view === 'dashboard') { renderSalesChart(); renderTopSellers(); } }, 150);
  });

  /* First run: offer the demo so the app isn't a blank page */
  if (!localStorage.getItem(STORAGE_KEY)) {
    showView('products');
    toast('Welcome! Add your first product, or load the demo data from Settings.');
  }
}

document.addEventListener('DOMContentLoaded', init);

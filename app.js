/* ==========================================================================
   Stock Manager
   A small inventory tool: what's in stock, what needs buying, what's selling.
   Plain JavaScript, no dependencies. Data lives in this browser's storage.
   ========================================================================== */

'use strict';

const STORAGE_KEY = 'stockManager.v1';
const THEME_KEY = 'stockManager.theme';
const UNDO_KEY = 'stockManager.undo.v1';
const UNDO_LIMIT = 10;

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

/* ── Months, for the demand plan ───────────────────────────────────────── */

const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "2026-08" for a Date. */
const monthKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const isMonthKey = (k) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(k));
const addMonths = (key, n) => {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return monthKey(d);
};
const daysInMonth = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};
const monthLabel = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
};

/**
 * Reads a spreadsheet column heading as a month. Copes with what Excel
 * actually puts on the clipboard — "Jan-26", "Jan 2026", "2026-01",
 * "01/2026" — and with a raw date if the cell was never formatted.
 */
function parseMonthHeader(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const fullYear = (y) => (y < 100 ? 2000 + y : y);
  const build = (y, m) => (m >= 1 && m <= 12 ? `${y}-${pad2(m)}` : null);

  let m = s.match(/^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?(?:[T ].*)?$/);
  if (m) return build(+m[1], +m[2]);

  m = s.match(/^([A-Za-z]{3,})[\s\-/.]*(\d{2,4})$/);
  if (m) {
    const idx = MONTH_ABBR.indexOf(m[1].slice(0, 3).toLowerCase());
    if (idx > -1) return build(fullYear(+m[2]), idx + 1);
  }

  m = s.match(/^(\d{1,2})[-/](\d{4})$/);
  if (m) return build(+m[2], +m[1]);

  return null;
}

/* ── Storage ───────────────────────────────────────────────────────────── */

const emptyDb = () => ({
  version: 1,
  products: [],
  sales: [],
  restocks: [],
  orders: [],
  settings: { shopName: '', currency: '$', coverDays: 30, defaultLeadTimeDays: 0 },
});

let db = emptyDb();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // A packaged copy can define window.STARTER_DATA (see build-archive.js)
      // to open pre-loaded instead of blank — untouched, this is a no-op.
      if (window.STARTER_DATA) { db = normalise(window.STARTER_DATA); save(); }
      return;
    }
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
    orders: Array.isArray(input.orders) ? input.orders.map(normOrder).filter(Boolean) : [],
    settings: { ...base.settings, ...(input.settings || {}) },
  };
}

/* A purchase order is several lines to one supplier, received over one or
   more deliveries — so a line tracks what was ordered and what has actually
   turned up, which are very often not the same number. */

const normOrderLine = (l) => (l && l.productId ? {
  productId: String(l.productId),
  qty: clampNum(l.qty),
  received: clampNum(l.received),
  unitCost: clampNum(l.unitCost),
} : null);

const normReceipt = (r) => (r && Array.isArray(r.lines) ? {
  id: r.id || uid(),
  date: r.date || dateKey(),
  note: String(r.note || ''),
  lines: r.lines
    .map((l) => (l && l.productId ? { productId: String(l.productId), qty: clampNum(l.qty) } : null))
    .filter(Boolean),
} : null);

const normOrder = (o) => (o && Array.isArray(o.lines) ? {
  id: o.id || uid(),
  ref: String(o.ref || ''),
  supplier: String(o.supplier || ''),
  orderedOn: o.orderedOn || dateKey(),
  expectedOn: o.expectedOn || '',
  cancelled: !!o.cancelled,
  closed: !!o.closed,
  notes: String(o.notes || ''),
  lines: o.lines.map(normOrderLine).filter(Boolean),
  receipts: Array.isArray(o.receipts) ? o.receipts.map(normReceipt).filter(Boolean) : [],
} : null);

/** Monthly demand plan: { "2026-08": 120, … }, junk keys dropped. */
function normDemand(input) {
  const out = {};
  if (input && typeof input === 'object') {
    Object.entries(input).forEach(([k, v]) => {
      if (isMonthKey(k) && Number.isFinite(Number(v))) out[k] = clampNum(v);
    });
  }
  return out;
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
  leadTimeDays: clampNum(p.leadTimeDays),
  discontinued: !!p.discontinued,
  demand: normDemand(p.demand),
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

/* ── Undo ──────────────────────────────────────────────────────────────── *
 * Every save() keeps a copy of whatever was there just before it, so one
 * button reverses the last change — a wrong edit, an accidental delete, a
 * bad import, even "Erase everything". Kept in localStorage (not just
 * memory) so it survives closing the browser, capped to the last few
 * changes to keep it small.                                                */

let undoStack = [];
try { undoStack = JSON.parse(localStorage.getItem(UNDO_KEY) || '[]'); } catch { undoStack = []; }
if (!Array.isArray(undoStack)) undoStack = [];

function persistUndoStack() {
  try { localStorage.setItem(UNDO_KEY, JSON.stringify(undoStack)); } catch { /* best effort */ }
}

function updateUndoButton() {
  const btn = $('#undoBtn');
  if (btn) btn.hidden = undoStack.length === 0;
}

function save() {
  try {
    const prev = localStorage.getItem(STORAGE_KEY);
    if (prev !== null) {
      undoStack.push(prev);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      persistUndoStack();
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    updateUndoButton();
  } catch (err) {
    console.error(err);
    toast('Could not save — the browser storage may be full.');
  }
}

function undoLast() {
  if (!undoStack.length) return;
  const prevRaw = undoStack.pop();
  persistUndoStack();
  try {
    db = normalise(JSON.parse(prevRaw));
  } catch (err) {
    console.error(err);
    toast('Could not undo — that change could not be read back.');
    return;
  }
  // Written directly (not via save()) so undoing doesn't push a new step
  // onto its own stack — repeated clicks keep walking further back.
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); } catch { /* best effort */ }
  updateUndoButton();
  renderAll();
  toast('Last change undone.');
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

/** Average units actually sold per day, over the last 30 days the product existed. */
function salesRate(p) {
  const window = 30;
  const from = dateKey(addDays(new Date(), -(window - 1)));
  const sold = unitsSold(p.id, from);
  const age = Math.max(1, daysBetween(p.createdAt, dateKey()) + 1);
  return sold / Math.min(window, age);
}

const hasPlan = (p) => p.demand && Object.keys(p.demand).length > 0;

/** Planned units per day for the current month, or null with no plan for it. */
function plannedRate(p) {
  if (!hasPlan(p)) return null;
  const key = monthKey();
  const planned = p.demand[key];
  if (planned === undefined) return null;
  return planned / daysInMonth(key);
}

/**
 * Expected units used per day. A demand plan is a deliberate statement about
 * what is coming, so it beats extrapolating from the last 30 days; without
 * one, fall back to what actually moved.
 */
function velocity(p) {
  const planned = plannedRate(p);
  return planned === null ? salesRate(p) : planned;
}

/**
 * Total demand the plan asks for over the next `days`, walking month by
 * month and pro-rating the part-months at each end. Null with no plan.
 */
function plannedDemandOverDays(p, days) {
  if (!hasPlan(p)) return null;
  const start = monthKey();
  const dayOfMonth = new Date().getDate();
  let remaining = days;
  let total = 0;
  for (let i = 0; i < 48 && remaining > 0; i++) {
    const key = addMonths(start, i);
    const dim = daysInMonth(key);
    const available = i === 0 ? dim - dayOfMonth + 1 : dim;
    const take = Math.min(available, remaining);
    total += clampNum(p.demand[key]) * (take / dim);
    remaining -= take;
  }
  return total;
}

/**
 * Days until stock runs out. With a plan, walk it month by month rather
 * than projecting one month's rate flat — planned demand rises and falls,
 * and it is the plan that decides when the shelf actually empties.
 */
function daysOfCover(p) {
  if (hasPlan(p)) {
    const start = monthKey();
    const dayOfMonth = new Date().getDate();
    const incoming = incomingByMonth(p.id);
    let running = p.stock;
    let elapsed = 0;
    for (let i = 0; i < 48; i++) {
      const key = addMonths(start, i);
      const dim = daysInMonth(key);
      const available = i === 0 ? dim - dayOfMonth + 1 : dim;
      // Stock already on order lands at the start of the month it's due.
      running += clampNum(incoming[key]);
      const planned = clampNum(p.demand[key]) * (available / dim);
      if (planned > 0 && running - planned < 0) {
        return elapsed + Math.floor((running / planned) * available);
      }
      running -= planned;
      elapsed += available;
    }
    return Infinity;
  }
  const v = salesRate(p);
  return v > 0 ? (p.stock + onOrder(p.id)) / v : Infinity;
}

/**
 * Projected stock at the end of each of the next `months` months, running
 * the demand plan down against what's on hand. `short` is the first month
 * it goes negative — the shortfall she has to solve for.
 */
function projectPlan(p, months = 12) {
  const start = monthKey();
  const incoming = incomingByMonth(p.id);
  let running = p.stock;
  let short = null;
  const row = [];
  for (let i = 0; i < months; i++) {
    const key = addMonths(start, i);
    const arriving = clampNum(incoming[key]);
    const planned = clampNum(p.demand?.[key]);
    running += arriving;
    running -= planned;
    if (short === null && running < 0) short = key;
    row.push({ key, planned, arriving, closing: running });
  }
  return { row, short };
}

function status(p) {
  if (p.stock <= 0) return 'out';
  if (p.stock <= p.reorderPoint) return 'low';
  return 'ok';
}

const STATUS_TEXT = { out: 'Out of stock', low: 'Running low', ok: 'Well stocked' };

/* ── Purchase orders ───────────────────────────────────────────────────── */

const lineOutstanding = (l) => Math.max(0, l.qty - l.received);
const orderOutstanding = (o) => o.lines.reduce((s, l) => s + lineOutstanding(l), 0);
const orderOrdered = (o) => o.lines.reduce((s, l) => s + l.qty, 0);
const orderReceived = (o) => o.lines.reduce((s, l) => s + l.received, 0);
const orderValue = (o) => o.lines.reduce((s, l) => s + l.qty * l.unitCost, 0);

/** An order still owing stock, and not cancelled or closed short. */
const orderIsOpen = (o) => !o.cancelled && !o.closed && orderOutstanding(o) > 0;
const openOrders = () => db.orders.filter(orderIsOpen);

function orderStatus(o) {
  if (o.cancelled) return 'cancelled';
  if (orderOutstanding(o) === 0) return 'received';
  if (o.closed) return 'closed';
  return orderReceived(o) > 0 ? 'part' : 'open';
}

const ORDER_STATUS_TEXT = {
  open: 'Waiting', part: 'Part delivered', received: 'Complete',
  closed: 'Closed short', cancelled: 'Cancelled',
};

/** Overdue: still owed, and the date it was promised for has gone past. */
const orderIsLate = (o) => orderIsOpen(o) && o.expectedOn && o.expectedOn < dateKey();

/** Units of a product already on order and still to come. */
function onOrder(productId) {
  return openOrders().reduce((s, o) => s + o.lines
    .filter((l) => l.productId === productId)
    .reduce((t, l) => t + lineOutstanding(l), 0), 0);
}

/**
 * When outstanding stock is due, keyed by month. Anything already overdue
 * is counted against the current month — it is still coming, just late.
 */
function incomingByMonth(productId) {
  const now = monthKey();
  const map = {};
  openOrders().forEach((o) => {
    const qty = o.lines
      .filter((l) => l.productId === productId)
      .reduce((t, l) => t + lineOutstanding(l), 0);
    if (!qty) return;
    let key = o.expectedOn ? o.expectedOn.slice(0, 7) : now;
    if (key < now) key = now;
    map[key] = (map[key] || 0) + qty;
  });
  return map;
}

/** Days this supplier takes to deliver — the product's own, or the default. */
function leadTime(p) {
  return clampNum(p.leadTimeDays) || clampNum(db.settings.defaultLeadTimeDays);
}

/**
 * Days left before the order has to be placed. Stock has to outlast the
 * supplier's lead time, so the deadline is that much earlier than the day
 * the shelf actually empties. Zero or negative means it is already late.
 */
function daysUntilOrder(p) {
  const cover = daysOfCover(p);
  if (cover === Infinity) return Infinity;
  return Math.floor(cover - leadTime(p));
}

/** The date that order has to go out, or null when nothing is moving. */
function orderByDate(p) {
  const d = daysUntilOrder(p);
  return d === Infinity ? null : dateKey(addDays(new Date(), d));
}

/**
 * How much to buy: enough to cover the wait for delivery *and* the next
 * `coverDays` of use, plus the alert level as a cushion, minus what's in
 * stock — never less than the usual order size, rounded up to whole packs.
 */
function suggestedOrder(p) {
  const coverDays = clampNum(db.settings.coverDays, 1) || 30;
  const horizon = coverDays + leadTime(p);
  // Size against the plan when there is one, so a ramp-up isn't under-ordered.
  const need = plannedDemandOverDays(p, horizon) ?? salesRate(p) * horizon;
  // Whatever is already on its way counts — otherwise the same shortage
  // gets ordered again every time she looks at the list.
  let qty = Math.ceil(need + p.reorderPoint - p.stock - onOrder(p.id));
  if (qty <= 0) return 0;
  if (qty < p.reorderQty) qty = p.reorderQty;
  if (p.reorderQty > 1) qty = Math.ceil(qty / p.reorderQty) * p.reorderQty;
  return Math.max(1, qty);
}

/**
 * Anything low or out — plus anything whose ordering deadline has arrived,
 * which is the case a plain stock level hides: a product can look well
 * stocked and still be late to reorder if the supplier is slow. Products
 * already covered by an open order drop off the list.
 */
const needsOrder = () => db.products.filter((p) => (
  !p.discontinued
  && (status(p) !== 'ok' || daysUntilOrder(p) <= 0)
  && suggestedOrder(p) > 0
));

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
  productMode: 'list',
  planMonths: 12,
};

function renderAll() {
  $('#shopName').textContent = db.settings.shopName || 'Stock Manager';
  document.title = db.settings.shopName ? `${db.settings.shopName} — Stock` : 'Stock Manager';
  renderReorderBadge();
  renderDashboard();
  renderProducts();
  renderPlan();
  renderReorder();
  renderOrders();
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
  renderForecast();
}

/**
 * Next-30-days forecast: a simple linear trend over the last 60 days of
 * sales (last 30 days vs. the 30 before that), extrapolated forward.
 * Runs entirely on-device — no server, no external AI, nothing leaves
 * this computer.
 */
function forecastNextMonth() {
  const now = new Date();
  const recentFrom = dateKey(addDays(now, -29));
  const recentTo = dateKey(now);
  const prevFrom = dateKey(addDays(now, -59));
  const prevTo = dateKey(addDays(now, -30));

  const windowTotals = (from, to) => {
    const sales = salesInRange(from, to);
    return { units: sales.reduce((s, x) => s + x.qty, 0), revenue: sales.reduce((s, x) => s + x.qty * x.unitPrice, 0) };
  };
  const recent = windowTotals(recentFrom, recentTo);
  const previous = windowTotals(prevFrom, prevTo);

  const oldestSale = db.sales.reduce((min, s) => (!min || s.date < min ? s.date : min), null);
  const historyDays = oldestSale ? daysBetween(oldestSale, dateKey(now)) + 1 : 0;

  const dailyRecent = recent.units / 30;
  const dailyPrevious = previous.units / 30;
  const trendPerDay = (dailyRecent - dailyPrevious) / 30;
  let predictedUnits = 0;
  for (let d = 1; d <= 30; d++) predictedUnits += Math.max(0, dailyRecent + trendPerDay * d);
  predictedUnits = Math.round(predictedUnits);

  const avgPrice = recent.units > 0 ? recent.revenue / recent.units
    : previous.units > 0 ? previous.revenue / previous.units : 0;
  const predictedRevenue = predictedUnits * avgPrice;

  const changePct = previous.units === 0
    ? (recent.units === 0 ? 0 : null)
    : ((recent.units - previous.units) / previous.units) * 100;

  const movers = db.products
    .filter((p) => daysBetween(p.createdAt, dateKey(now)) + 1 >= 60)
    .map((p) => {
      const r = unitsSold(p.id, recentFrom, recentTo);
      const prev = unitsSold(p.id, prevFrom, prevTo);
      const pct = prev === 0 ? null : ((r - prev) / prev) * 100;
      return { p, recent: r, previous: prev, pct };
    })
    .filter((m) => m.pct !== null && m.recent + m.previous >= 4);

  const slowingDown = movers.filter((m) => m.pct < -10).sort((a, b) => a.pct - b.pct).slice(0, 3);
  const pickingUp = movers.filter((m) => m.pct > 10).sort((a, b) => b.pct - a.pct).slice(0, 3);

  return { recent, previous, historyDays, predictedUnits, predictedRevenue, changePct, slowingDown, pickingUp };
}

function renderForecast() {
  const wrap = $('#forecastBody');
  const f = forecastNextMonth();

  if (f.historyDays < 45) {
    wrap.innerHTML = `<p class="empty">Once about two months of sales are recorded, this card will forecast next month and flag which products people are buying more or less of.</p>`;
    return;
  }

  const trendClass = f.changePct === null || Math.abs(f.changePct) < 5 ? '' : f.changePct < 0 ? 'is-bad' : 'is-good';
  const trendText = f.changePct === null
    ? 'No sales in the last 30 days to compare yet.'
    : Math.abs(f.changePct) < 5
      ? '→ About the same pace as the previous 30 days.'
      : `${f.changePct < 0 ? '▼' : '▲'} ${Math.abs(Math.round(f.changePct))}% ${f.changePct < 0 ? 'fewer' : 'more'} sales than the previous 30 days.`;

  const moverList = (items) => items.length
    ? items.map((m) => `<div class="trend-item">
        <span class="p-name">${esc(m.p.name)}</span>
        <span class="trend-pct ${m.pct < 0 ? 'is-bad' : 'is-good'}">${m.pct < 0 ? '▼' : '▲'} ${Math.abs(Math.round(m.pct))}%</span>
      </div>`).join('')
    : `<p class="trend-empty">Nothing standing out.</p>`;

  wrap.innerHTML = `
    <div class="forecast-headline">
      <div class="forecast-number">${num(f.predictedUnits)} <span class="forecast-unit">units</span></div>
      <div class="forecast-sub">≈ ${money(f.predictedRevenue)} predicted over the next 30 days</div>
      <div class="trend-badge ${trendClass}">${trendText}</div>
    </div>
    <div class="grid-2 forecast-movers">
      <div>
        <h3 class="forecast-mover-title">People are buying less of</h3>
        ${moverList(f.slowingDown)}
      </div>
      <div>
        <h3 class="forecast-mover-title">People are buying more of</h3>
        ${moverList(f.pickingUp)}
      </div>
    </div>
    <p class="card-note">Based only on this shop's own sales history — runs on this device, no internet needed.</p>
  `;
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
    .sort((a, b) => daysUntilOrder(a) - daysUntilOrder(b))
    .slice(0, 6);

  if (!rows.length) {
    $('#attentionList').innerHTML = '<p class="empty">Nothing needs ordering today — everything is above its alert level and inside its lead time. 🎉</p>';
    return;
  }

  $('#attentionList').innerHTML = `<div class="table-scroll"><table class="table">
    <thead><tr><th>Product</th><th class="num">Left</th><th class="num">Lasts about</th><th>Status</th><th>Order by</th><th class="num">Buy</th></tr></thead>
    <tbody>${rows.map((p) => {
      const st = status(p);
      const cover = daysOfCover(p);
      return `<tr>
        <td><span class="p-name">${esc(p.name)}</span>${p.category ? `<div class="p-meta">${esc(p.category)}</div>` : ''}</td>
        <td class="num">${num(p.stock)}</td>
        <td class="num">${cover === Infinity ? '—' : `${num(Math.floor(cover))} days`}</td>
        <td><span class="pill is-${st}">${STATUS_TEXT[st]}</span></td>
        <td>${orderByCell(p)}</td>
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
        <button class="btn btn-sm btn-danger" data-act="delete" data-id="${p.id}" title="Remove this product completely">Remove</button>
      </div></td>
    </tr>`;
  }).join('');

  $('#productsEmpty').hidden = rows.length > 0;
  $('#productsEmpty').textContent = db.products.length === 0
    ? 'No products yet. Use “+ New product” to add the first one, or load the demo data from Settings.'
    : 'No products match this search.';

  renderProductGrid(rows);

  $$('#productTable .sortable').forEach((th) => {
    th.classList.toggle('sort-asc', th.dataset.sort === ui.productSort.key && ui.productSort.dir === 1);
    th.classList.toggle('sort-desc', th.dataset.sort === ui.productSort.key && ui.productSort.dir === -1);
  });
}

/* Spreadsheet mode -------------------------------------------------------- *
 * The same products, laid out as an editable grid: click a cell, type, then
 * Enter / Tab / arrow keys to move on — the way a spreadsheet behaves.       */

const GRID_COLS = [
  { key: 'sku', label: 'Code', type: 'text' },
  { key: 'name', label: 'Product', type: 'text' },
  { key: 'category', label: 'Category', type: 'text' },
  { key: 'supplier', label: 'Supplier', type: 'text' },
  { key: 'unit', label: 'Unit', type: 'text' },
  { key: 'stock', label: 'In stock', type: 'int' },
  { key: 'reorderPoint', label: 'Alert at', type: 'int' },
  { key: 'reorderQty', label: 'Usual order', type: 'int' },
  { key: 'leadTimeDays', label: 'Lead time (days)', type: 'int' },
  { key: 'cost', label: 'Cost', type: 'money' },
  { key: 'price', label: 'Price', type: 'money' },
];

const gridIsNum = (col) => col.type !== 'text';
const gridDisplay = (p, col) => (col.type === 'money' ? money(p[col.key]) : col.type === 'int' ? num(p[col.key]) : p[col.key] || '');

function renderProductGrid(rows) {
  $('#productGridHead').innerHTML = GRID_COLS
    .map((c) => `<th class="${gridIsNum(c) ? 'num' : ''}">${esc(c.label)}</th>`).join('') + '<th class="col-actions"></th>';

  $('#productGrid tbody').innerHTML = rows.map(({ p }) => `<tr data-id="${p.id}">${
    GRID_COLS.map((c) => {
      const val = gridDisplay(p, c);
      return `<td class="grid-cell${gridIsNum(c) ? ' is-num' : ''}${val === '' ? ' is-empty' : ''}" data-id="${p.id}" data-key="${c.key}"
        ><span class="grid-text" tabindex="0" role="button" aria-label="${esc(c.label)}: ${esc(String(val) || 'empty')}">${esc(val === '' ? '—' : val)}</span></td>`;
    }).join('')
  }<td><div class="cell-actions">
      <button class="btn btn-sm btn-ghost" data-act="delete" data-id="${p.id}" title="Remove this product completely">Remove</button>
    </div></td></tr>`).join('');

  $('#gridEmpty').hidden = rows.length > 0;
  $('#productGrid').hidden = rows.length === 0;
}

/** Repaint one cell in place — avoids rebuilding the grid and losing focus. */
function refreshGridCell(td) {
  const p = productById(td.dataset.id);
  const col = GRID_COLS.find((c) => c.key === td.dataset.key);
  if (!p || !col) return;
  const val = gridDisplay(p, col);
  td.classList.toggle('is-empty', val === '');
  const span = document.createElement('span');
  span.className = 'grid-text';
  span.tabIndex = 0;
  span.setAttribute('role', 'button');
  span.setAttribute('aria-label', `${col.label}: ${String(val) || 'empty'}`);
  span.textContent = val === '' ? '—' : val;
  td.replaceChildren(span);
  return span;
}

function gridCellAt(row, colIndex) {
  const cells = $$('.grid-cell', row);
  return cells[Math.max(0, Math.min(cells.length - 1, colIndex))];
}

function moveGridFocus(td, dRow, dCol) {
  const row = td.closest('tr');
  const cells = $$('.grid-cell', row);
  const colIndex = cells.indexOf(td) + dCol;
  let targetRow = row;

  if (dRow !== 0) {
    targetRow = dRow > 0 ? row.nextElementSibling : row.previousElementSibling;
    if (!targetRow) return false;
  }
  if (colIndex < 0 || colIndex >= cells.length) {
    // Walking off the end wraps to the next / previous row, like Tab in Excel.
    if (dCol === 0) return false;
    targetRow = dCol > 0 ? row.nextElementSibling : row.previousElementSibling;
    if (!targetRow) return false;
    const wrapped = gridCellAt(targetRow, dCol > 0 ? 0 : GRID_COLS.length - 1);
    wrapped.querySelector('.grid-text')?.focus();
    return true;
  }
  gridCellAt(targetRow, colIndex).querySelector('.grid-text')?.focus();
  return true;
}

function beginGridEdit(td, seed) {
  if (td.querySelector('input')) return;
  const p = productById(td.dataset.id);
  const col = GRID_COLS.find((c) => c.key === td.dataset.key);
  if (!p || !col) return;

  const input = document.createElement('input');
  input.className = 'grid-input';
  if (gridIsNum(col)) {
    input.type = 'number';
    input.min = '0';
    input.step = col.type === 'money' ? '0.01' : '1';
  } else {
    input.type = 'text';
    input.maxLength = 80;
  }
  input.value = seed !== undefined ? seed : (gridIsNum(col) ? p[col.key] : p[col.key] || '');
  td.replaceChildren(input);
  input.focus();
  if (seed === undefined) input.select();

  let settled = false;
  const finish = (commit, move) => {
    if (settled) return;
    settled = true;
    if (commit) {
      const value = gridIsNum(col) ? clampNum(input.value) : input.value.trim().slice(0, 80);
      if (col.key === 'name' && !value) {
        toast('A product needs a name.');
      } else if (p[col.key] !== value) {
        p[col.key] = value;
        save();
        // Every other view reads these numbers, so refresh them — but not the
        // grid itself, which would tear the cell out from under the cursor.
        renderReorderBadge();
        renderDashboard();
        renderReorder();
      }
    }
    const span = refreshGridCell(td);
    if (move) moveGridFocus(td, move.row, move.col);
    else span?.focus();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true, { row: 1, col: 0 }); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'Tab') { e.preventDefault(); finish(true, { row: 0, col: e.shiftKey ? -1 : 1 }); }
  });
  input.addEventListener('blur', () => finish(true));
}

function addGridRow() {
  const p = normProduct({ name: 'New product', id: uid(), createdAt: dateKey() });
  db.products.push(p);
  save();
  renderAll();
  showProductMode('grid');
  const cell = $(`#productGrid .grid-cell[data-id="${p.id}"][data-key="name"]`);
  if (cell) { cell.scrollIntoView({ block: 'center' }); beginGridEdit(cell, ''); }
  else toast('Row added — clear the search to see it.');
}

function showProductMode(mode) {
  ui.productMode = mode;
  $('#productGridCard').hidden = mode !== 'grid';
  $('#productListCard').hidden = mode === 'grid';
  $$('#productMode .seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === mode));
  // Cell edits deliberately skip re-rendering the products view, so catch the
  // other mode up when swapping between them.
  renderProducts();
}

/* To buy ------------------------------------------------------------------ */

/* Ask ---------------------------------------------------------------------- *
 * A question box that answers from the data actually loaded. It is not a
 * language model: it recognises what is being asked and then reads the same
 * functions the pages use, so a number it gives can always be found on a
 * page. That matters here — a made-up reorder date would be worse than no
 * answer at all.                                                            */

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const listOf = (items) => `<ul class="msg-list">${items.join('')}</ul>`;
const li = (key, val) => `<li><span class="msg-marker">•</span><span class="msg-key">${key}</span> ${val}</li>`;

/** Pick a phrasing, never the same one twice running, so it doesn't drone. */
const lastPick = {};
function pick(key, options) {
  if (options.length === 1) return options[0];
  let i = Math.floor(Math.random() * options.length);
  if (i === lastPick[key]) i = (i + 1) % options.length;
  lastPick[key] = i;
  return options[i];
}

/* ── Talking, rather than answering ────────────────────────────────────── *
 * Sometimes the person at the keyboard isn't after a number. This is a
 * small scripted thing, not a mind, so it keeps to what it can honestly
 * do: notice, say something kind and varied, and ask something back.      */

const talkState = { comforted: 0, lastTopic: null };

/** Serious distress — never handled with a canned pep-talk. */
const CRISIS_RE = /\b(kill myself|killing myself|end my life|ending my life|take my life|suicid\w*|want to die|wanna die|don'?t want to (be here|live|wake up)|hurt myself|harm myself|self[- ]harm|cut myself|no reason to live|better off without me)\b/;

/** First-person feeling talk, as opposed to "stock is low". */
function looksEmotional(l) {
  const me = /\b(i|i'?m|im|me|my|myself|feeling|feel)\b/.test(l);
  const domain = /\b(stock|order|product|supplier|sku|plan|demand|deliver|lead time|shortfall|units|inventory)\b/.test(l);
  return me && !domain;
}

function crisisReply() {
  return `<p>I'm really glad you told me, and I don't want to hand you a script and leave it there. What you're describing is more than a small program should be trusted with — but you deserve someone who <em>can</em> help, tonight.</p>
    <p>Please reach out to a real person now: someone you trust, or a crisis line. You can find one for your country at <strong>findahelpline.com</strong>. If you're in immediate danger, your local emergency number is the right call.</p>
    <p>You reached out here, which took something. Please point that same instinct at a human who can actually sit with you. I'll still be here for the boring stock questions afterwards.</p>`;
}

function comfortReply(topic) {
  const bodies = {
    lonely: [
      `<p>That's a heavy thing to be carrying, and saying it plainly counts for something. Being on your own and feeling alone aren't the same thing — the second one is much harder, and it doesn't care how many people are technically nearby.</p>`,
      `<p>Loneliness has a way of making itself feel permanent and deserved, and it's neither. It's just what the room feels like right now.</p>`,
      `<p>I'm sorry it's quiet where you are. That kind of quiet gets loud after a while.</p>`,
    ],
    sad: [
      `<p>That sounds genuinely rough. You don't have to justify feeling low, or have a tidy reason ready for it.</p>`,
      `<p>I'm sorry. Some days sit heavier than others and there isn't always a why that makes sense.</p>`,
      `<p>That's a hard place to be in. It's allowed to just be hard, without needing fixing this minute.</p>`,
    ],
    stressed: [
      `<p>That sounds like a lot to be holding at once. Stress like that tends to make everything feel equally urgent, which is exhausting and usually not true.</p>`,
      `<p>Being stretched that thin wears people down. It isn't a sign you're bad at this.</p>`,
      `<p>That's a heavy load. Tired doesn't mean weak — it usually means you've been carrying it a while.</p>`,
    ],
    talk: [
      `<p>I'm happy to be here. I'm not much of a conversationalist, but I don't get bored and I'm not going anywhere.</p>`,
      `<p>Then let's talk. Company is company, even the small kind.</p>`,
      `<p>Glad you came by. Wanting someone around isn't something to apologise for.</p>`,
    ],
  };

  const asks = {
    lonely: ['What does tonight look like for you?', 'Is this a tonight thing, or has it been building for a while?', 'Who\'s someone you\'d message if it were easy to?'],
    sad: ['Do you know what set it off, or did it just arrive?', 'Has today been the whole of it, or has it been a longer stretch?', 'What would make the next hour a little softer?'],
    stressed: ['What\'s the biggest thing on the pile right now?', 'Is any of it actually yours to fix, or has it just landed on you?', 'When did you last properly stop?'],
    talk: ['What\'s on your mind?', 'How\'s your day been, honestly?', 'What have you been up to?'],
  };

  let out = pick(`body-${topic}`, bodies[topic] || bodies.talk);
  out += `<p>${pick(`ask-${topic}`, asks[topic] || asks.talk)}</p>`;

  // Said once, early — honest about what this is, without labouring it.
  if (talkState.comforted === 0) {
    out += `<p class="msg-soft">Fair warning: I'm a small program someone set up, so I can listen and keep you company, but I can't really understand you the way a person would. If it gets heavy, a real human is worth reaching for.</p>`;
  }
  talkState.comforted++;
  return out;
}

function chatReply(l) {
  if (/^(hi|hey|hello|yo|hiya|good (morning|afternoon|evening))\b/.test(l) || /^how are you/.test(l)) {
    return `<p>${pick('greet', [
      'Hello. Good to see you.',
      'Hey there.',
      'Hi. How\'s things?',
      'Hello — glad you dropped in.',
    ])}</p><p>${pick('greet2', [
      'I can go through the stock with you, or we can just talk.',
      'Ask me anything about the stock, or tell me how your day\'s going.',
      'Numbers or conversation, either\'s fine by me.',
    ])}</p>`;
  }
  if (/\b(thank|thanks|cheers|appreciate)\b/.test(l)) {
    return `<p>${pick('thanks', [
      'Any time. That\'s what I\'m here for.',
      'You\'re very welcome.',
      'Glad it helped.',
      'Happy to.',
    ])}</p>`;
  }
  if (/\b(good news|great news|i did it|went well|happy|excited|proud|got the job|finished)\b/.test(l)) {
    return `<p>${pick('glad', [
      'That\'s genuinely good to hear.',
      'Well done — that\'s worth sitting with for a minute.',
      'Ah, that\'s lovely. Good for you.',
    ])}</p><p>${pick('glad2', ['Tell me about it?', 'How did it come about?', 'What happened?'])}</p>`;
  }
  return null;
}

/** Emotional read of the message, or null if it's really a stock question. */
function emotionalReply(raw) {
  const l = raw.toLowerCase();
  if (CRISIS_RE.test(l)) return crisisReply();

  const social = chatReply(l);
  if (social) return social;

  if (!looksEmotional(l)) return null;

  if (/\b(lonely|alone|on my own|by myself|isolated|nobody|no one|no-one)\b/.test(l)) return comfortReply('lonely');
  if (/\b(sad|down|low|unhappy|miserable|depress\w*|crying|cry|upset|hurt|empty|numb|awful|terrible|rough)\b/.test(l)) return comfortReply('sad');
  if (/\b(stress\w*|overwhelm\w*|exhaust\w*|burn\w*out|tired|knackered|anxious|anxiety|worried|panic\w*|can'?t cope|too much)\b/.test(l)) return comfortReply('stressed');
  if (/\b(talk|chat|company|lonely|bored|listen|vent|someone to)\b/.test(l)) return comfortReply('talk');
  return null;
}

/** Products named in the question — longest name first so "ABC" beats "A". */
function productsInText(q) {
  const lower = ` ${q.toLowerCase()} `;
  const hit = (needle) => needle && new RegExp(`(^|[^a-z0-9])${escapeRegex(needle.toLowerCase())}([^a-z0-9]|$)`).test(lower);
  return db.products
    .filter((p) => hit(p.name) || hit(p.sku))
    .sort((a, b) => b.name.length - a.name.length);
}

/** A month named in the question: "November", "Nov 26", "2026-11". */
function monthInText(q) {
  const direct = q.match(/\b(\d{4}-\d{1,2}|[A-Za-z]{3,9}[\s\-/.]*\d{2,4}|\d{1,2}\/\d{4})\b/);
  if (direct) {
    const key = parseMonthHeader(direct[1]);
    if (key) return key;
  }
  const bare = q.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  if (!bare) return null;
  // A bare month name means the next time it comes round.
  const idx = MONTH_ABBR.indexOf(bare[1]);
  const now = new Date();
  const year = idx < now.getMonth() ? now.getFullYear() + 1 : now.getFullYear();
  return `${year}-${pad2(idx + 1)}`;
}

function describeProduct(p) {
  const cover = daysOfCover(p);
  const by = orderByDate(p);
  const d = daysUntilOrder(p);
  const bits = [
    li('In stock:', `${num(p.stock)}${p.unit ? ` ${esc(p.unit)}` : ''}`),
    ...(onOrder(p.id) ? [li('On order:', `${num(onOrder(p.id))} still to come`)] : []),
    li('Status:', STATUS_TEXT[status(p)].toLowerCase()),
    li('Lasts:', cover === Infinity ? 'nothing planned or selling, so it is not running down' : `about ${num(Math.floor(cover))} days`),
  ];
  if (leadTime(p)) bits.push(li('Lead time:', `${num(leadTime(p))} days`));
  if (by) {
    bits.push(li('Order by:', d < 0
      ? `<span class="is-late">${esc(longDate(by))} — ${num(-d)} days late</span>`
      : esc(longDate(by))));
  }
  if (!p.discontinued && (status(p) !== 'ok' || d <= 0)) bits.push(li('Order:', `${num(suggestedOrder(p))} to cover it`));
  if (hasPlan(p)) {
    const { short } = projectPlan(p, 24);
    bits.push(li('Against the plan:', short ? `<span class="is-late">runs short in ${esc(monthLabel(short))}</span>` : 'covered for the next 24 months'));
  }
  if (p.discontinued) bits.push(li('Note:', 'discontinued — no orders are suggested for it'));
  return `<p><strong>${esc(p.name)}</strong>${p.sku ? ` (${esc(p.sku)})` : ''}</p>${listOf(bits)}`;
}

function answerToBuy() {
  const rows = needsOrder().sort((a, b) => daysUntilOrder(a) - daysUntilOrder(b));
  if (!rows.length) {
    return `<p>${pick('nobuy', [
      'Nothing needs ordering right now — everything\'s above its alert level and still inside its lead time.',
      'You\'re clear for the moment. Nothing has hit its alert level or its ordering deadline.',
      'Nothing on the list today. Everything\'s holding up.',
    ])}</p>`;
  }
  const total = rows.reduce((s, p) => s + suggestedOrder(p) * p.cost, 0);
  const items = rows.slice(0, 8).map((p) => {
    const d = daysUntilOrder(p);
    const when = d === Infinity ? 'no date yet'
      : d < 0 ? `<span class="is-late">${num(-d)} days late</span>`
      : d === 0 ? '<span class="is-late">today</span>'
      : `by ${esc(longDate(orderByDate(p)))}`;
    return li(`${esc(p.name)}:`, `order ${num(suggestedOrder(p))}${p.unit ? ` ${esc(p.unit)}` : ''} — ${when}`);
  });
  const lead = pick('buylead', [
    `<strong>${num(rows.length)}</strong> product${rows.length === 1 ? '' : 's'} to order`,
    `I make it <strong>${num(rows.length)}</strong> to order`,
    `There ${rows.length === 1 ? 'is' : 'are'} <strong>${num(rows.length)}</strong> waiting on an order`,
  ]);
  return `<p>${lead}${total > 0 ? `, around <strong>${esc(money(total))}</strong> all in` : ''}.</p>`
    + listOf(items)
    + (rows.length > 8 ? `<p>…and ${num(rows.length - 8)} more on the To buy page.</p>` : '');
}

function answerShortfalls(month) {
  const planned = db.products.filter(hasPlan);
  if (!planned.length) return '<p>No demand plan is loaded yet, so I can\'t project shortfalls. Import a spreadsheet with a column per month and this will fill in.</p>';

  if (month) {
    const hits = planned.map((p) => {
      const { row } = projectPlan(p, 24);
      const cell = row.find((c) => c.key === month);
      return cell ? { p, closing: cell.closing } : null;
    }).filter((x) => x && x.closing < 0);
    if (!hits.length) return `<p>Nothing is projected to be short in <strong>${esc(monthLabel(month))}</strong>.</p>`;
    return `<p><strong>${num(hits.length)}</strong> short in <strong>${esc(monthLabel(month))}</strong>:</p>`
      + listOf(hits.map(({ p, closing }) => li(`${esc(p.name)}:`, `<span class="is-late">${num(closing)}</span> — short by ${num(-closing)}`)));
  }

  const shorts = planned.map((p) => ({ p, short: projectPlan(p, 24).short })).filter((x) => x.short);
  if (!shorts.length) return '<p>Nothing runs short in the next 24 months on the current plan. 🎉</p>';
  shorts.sort((a, b) => (a.short < b.short ? -1 : 1));
  return `<p><strong>${num(shorts.length)}</strong> product${shorts.length === 1 ? '' : 's'} run short on the plan:</p>`
    + listOf(shorts.map(({ p, short }) => li(`${esc(p.name)}:`, `<span class="is-late">${esc(monthLabel(short))}</span>`)));
}

function answerOrders() {
  const open = openOrders();
  if (!open.length) return `<p>${pick('noorders', [
    'Nothing is on order at the moment.',
    'No open orders — nothing due in.',
    'You have nothing outstanding with any supplier right now.',
  ])}</p>`;
  const late = open.filter(orderIsLate);
  const items = open.slice(0, 8).map((o) => {
    const when = !o.expectedOn ? 'no date given'
      : orderIsLate(o) ? `<span class="is-late">${num(daysBetween(o.expectedOn, dateKey()))} days late</span>`
      : `due ${esc(longDate(o.expectedOn))}`;
    return li(`${esc(o.supplier || 'No supplier')}${o.ref ? ` (${esc(o.ref)})` : ''}:`,
      `${num(orderOutstanding(o))} units owed — ${when}`);
  });
  return `<p><strong>${num(open.length)}</strong> open order${open.length === 1 ? '' : 's'}`
    + `${late.length ? `, <strong class="is-late">${num(late.length)} late</strong>` : ', all on schedule'}.</p>`
    + listOf(items)
    + (open.length > 8 ? `<p>…and ${num(open.length - 8)} more on the Orders page.</p>` : '');
}

function answerMovers() {
  const from30 = dateKey(addDays(new Date(), -29));
  const rows = db.products
    .map((p) => ({ p, sold: unitsSold(p.id, from30) }))
    .filter((r) => r.sold > 0)
    .sort((a, b) => b.sold - a.sold)
    .slice(0, 5);
  if (!rows.length) return '<p>No sales recorded in the last 30 days, so there is nothing to rank yet.</p>';
  return '<p>Most movement in the last 30 days:</p>'
    + listOf(rows.map(({ p, sold }) => li(`${esc(p.name)}:`, `${num(sold)} units`)));
}

function answerStockSummary() {
  const total = db.products.reduce((s, p) => s + p.stock, 0);
  const value = db.products.reduce((s, p) => s + p.stock * p.cost, 0);
  const out = db.products.filter((p) => status(p) === 'out').length;
  const low = db.products.filter((p) => status(p) === 'low').length;
  return `<p>You have <strong>${num(total)}</strong> units across <strong>${num(db.products.length)}</strong> products`
    + `${value > 0 ? `, worth about <strong>${esc(money(value))}</strong> at cost` : ''}.</p>`
    + listOf([
      li('Out of stock:', num(out)),
      li('Running low:', num(low)),
      li('Discontinued:', num(db.products.filter((p) => p.discontinued).length)),
    ]);
}

const ASK_SUGGESTIONS = [
  'What do I need to order?',
  'What runs short, and when?',
  'How much will the next order cost?',
  'How is my stock overall?',
];

/** Shown under the box, so it's obvious the talking option is really there. */
const ASK_CHIPS = [...ASK_SUGGESTIONS, 'I just want to talk'];

/** Work out what is being asked, then answer it from the real numbers. */
function answerQuestion(raw) {
  const q = String(raw).trim();
  if (!q) return '<p>Ask me something about your stock.</p>';
  const l = q.toLowerCase();

  // How someone's doing comes before what the stock's doing.
  const feeling = emotionalReply(q);
  if (feeling) return feeling;

  const named = productsInText(q);
  const month = monthInText(q);

  if (!db.products.length) {
    return `<p>${pick('nodata', [
      'There\'s nothing loaded yet, so there\'s nothing for me to look at.',
      'No products in here yet — I\'d only be guessing.',
      'The shelves are empty as far as I can see.',
    ])} Import a spreadsheet from the Products page, or add a product, and ask me again.</p>`;
  }

  if (/^(help|what can|who are you|what are you|how do)/.test(l) || l.includes('what can you')) {
    return '<p>I read the products and demand plan on this computer and answer from them. Things I can tell you:</p>'
      + listOf([
        li('Ordering:', 'what needs ordering, by when, and roughly what it costs'),
        li('Shortfalls:', 'what runs short against the plan, and in which month'),
        li('A product:', 'stock, cover, lead time and order date — just name it'),
        li('Overall:', 'total stock, what is out or low, what is discontinued'),
      ])
      + '<p>I only report what is in your data — I don\'t guess numbers.</p>';
  }

  // A named product answers most things about itself.
  if (named.length && !/\ball\b|everything|overall/.test(l)) {
    if (/short|run out|runs out|last|cover|when/.test(l) && hasPlan(named[0])) {
      const { short } = projectPlan(named[0], 24);
      const p = named[0];
      return short
        ? `<p><strong>${esc(p.name)}</strong> runs short in <strong class="is-late">${esc(monthLabel(short))}</strong> on the current plan, from ${num(p.stock)} in stock today.</p>`
        : `<p><strong>${esc(p.name)}</strong> stays covered for the next 24 months on the current plan.</p>`;
    }
    return named.slice(0, 3).map(describeProduct).join('');
  }

  if (/cost|spend|budget|money|price|worth|value/.test(l)) {
    const rows = needsOrder();
    const total = rows.reduce((s, p) => s + suggestedOrder(p) * p.cost, 0);
    const stockValue = db.products.reduce((s, p) => s + p.stock * p.cost, 0);
    return `<p>The orders due now come to about <strong>${esc(money(total))}</strong> across ${num(rows.length)} product${rows.length === 1 ? '' : 's'}.</p>`
      + `<p>What you are already holding is worth about <strong>${esc(money(stockValue))}</strong> at cost.</p>`;
  }

  if (/\b(on order|open orders|outstanding|deliver\w*|late order|arriv\w*|due in|po\b|purchase order|supplier owe)\b/.test(l)) return answerOrders();
  // "Anything late?" means a late delivery once there are orders to be late.
  if (/\b(late|overdue|chase|behind)\b/.test(l) && openOrders().length) return answerOrders();
  if (/short|shortfall|run out|runs out|negative|gap/.test(l) || (month && /plan/.test(l))) return answerShortfalls(month);
  if (month) return answerShortfalls(month);
  if (/order|buy|purchase|reorder|replenish|urgent|late|overdue|today|this week/.test(l)) return answerToBuy();
  if (/discontinued|inactive|obsolete/.test(l)) {
    const rows = db.products.filter((p) => p.discontinued);
    return rows.length
      ? `<p><strong>${num(rows.length)}</strong> discontinued:</p>` + listOf(rows.map((p) => li(`${esc(p.name)}:`, `${num(p.stock)} left`)))
      : '<p>Nothing is marked discontinued.</p>';
  }
  if (/lead time|delivery|supplier take|how long.*deliver/.test(l)) {
    const rows = db.products.filter((p) => leadTime(p) > 0).sort((a, b) => leadTime(b) - leadTime(a)).slice(0, 8);
    return rows.length
      ? '<p>Lead times, longest first:</p>' + listOf(rows.map((p) => li(`${esc(p.name)}:`, `${num(leadTime(p))} days`)))
      : '<p>No lead times are set yet. Add one per product, or a default under Settings, and I can tell you when each order has to go out.</p>';
  }
  if (/sell|selling|moving|popular|best|most/.test(l)) return answerMovers();
  if (/stock|have|inventory|hold|level|summary|overall|how many|how much/.test(l)) return answerStockSummary();

  return `<p>${pick('lost', [
    'I\'m not sure I followed that one.',
    'That one\'s past me, I\'m afraid.',
    'I didn\'t quite catch what you\'re after there.',
  ])} ${pick('lost2', [
    'Here\'s the sort of thing I\'m good for:',
    'I can help with things like:',
    'Try me on something like:',
  ])}</p>`
    + listOf(ASK_SUGGESTIONS.map((s) => li('', esc(s))))
    + '<p>Naming a product works too — I\'ll give you its stock, cover and order date. And if you\'d rather talk about something other than stock, just say so.</p>';
}

function pushMessage(who, html) {
  const log = $('#chatLog');
  const wrap = document.createElement('div');
  wrap.className = `msg msg-${who}`;
  wrap.innerHTML = `<div class="msg-bubble">${html}</div>`;
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
}

function askQuestion(text) {
  const q = String(text).trim();
  if (!q) return;
  pushMessage('you', esc(q));
  pushMessage('app', answerQuestion(q));
  $('#chatInput').value = '';
}

function renderAskChips() {
  $('#chatChips').innerHTML = ASK_CHIPS
    .map((s) => `<button type="button" class="chip">${esc(s)}</button>`).join('');
}

function greetAsk() {
  if ($('#chatLog').children.length) return;
  const hour = new Date().getHours();
  const timeOfDay = hour < 5 ? 'You\'re up late.' : hour < 12 ? 'Morning.' : hour < 18 ? 'Afternoon.' : 'Evening.';
  pushMessage('app', `<p>${timeOfDay} ${pick('hello', [
    'Good to see you.',
    'Glad you dropped in.',
    'Here whenever you need me.',
  ])}</p><p>${pick('hello2', [
    'Ask me anything about the stock — or if you\'d rather just talk, that\'s fine too.',
    'I can dig through the numbers with you, or we can simply chat. Either way.',
    'Stock questions, or company. Both are on offer.',
  ])}</p>`);
}

/* Plan --------------------------------------------------------------------- */

function renderPlan() {
  const months = ui.planMonths;
  const planned = db.products.filter(hasPlan);

  $('#planEmpty').hidden = planned.length > 0;
  $('#planTable').hidden = planned.length === 0;
  $('#planStatRow').innerHTML = '';
  if (!planned.length) { renderPlanBadge(); return; }

  const start = monthKey();
  const keys = Array.from({ length: months }, (_, i) => addMonths(start, i));

  const projected = planned.map((p) => ({ p, ...projectPlan(p, months) }));
  // Soonest shortfall first — that is what needs solving.
  projected.sort((a, b) => {
    if (a.short === b.short) return a.p.name.localeCompare(b.p.name);
    if (!a.short) return 1;
    if (!b.short) return -1;
    return a.short < b.short ? -1 : 1;
  });

  const shortCount = projected.filter((r) => r.short).length;
  const totalPlanned = projected.reduce((s, r) => s + r.row.reduce((t, c) => t + c.planned, 0), 0);
  $('#planStatRow').innerHTML = [
    statTile({ label: 'Products planned', value: num(planned.length), sub: `over the next ${num(months)} months` }),
    statTile({
      label: 'Run short', value: num(shortCount),
      sub: shortCount ? 'need covering' : 'plan is fully covered',
      subClass: shortCount ? 'is-bad' : 'is-good', alert: shortCount > 0,
    }),
    statTile({ label: 'Total demand', value: num(totalPlanned), sub: 'units across the plan' }),
  ].join('');

  $('#planHead').innerHTML = `<th class="plan-name">Product</th><th>Runs short</th><th class="num">In stock</th>`
    + keys.map((k) => `<th class="plan-month">${esc(monthLabel(k))}</th>`).join('');

  $('#planTable tbody').innerHTML = projected.map(({ p, row, short }) => `<tr data-id="${p.id}">
    <td class="plan-name"><span class="p-name">${esc(p.name)}</span>
      <div class="p-meta">${esc(p.sku || '—')}${p.discontinued ? ' · discontinued' : ''}</div></td>
    <td>${short
      ? `<span class="plan-short-label">▼ ${esc(monthLabel(short))}</span>`
      : `<span class="plan-ok-label">covered</span>`}</td>
    <td class="num strong">${num(p.stock)}</td>
    ${row.map((c) => {
      const isShort = c.closing < 0;
      const idle = c.planned === 0 && c.arriving === 0 && !isShort;
      const moves = [
        c.arriving ? `<span class="plan-in">+${num(c.arriving)}</span>` : '',
        c.planned ? `−${num(c.planned)}` : '',
      ].filter(Boolean).join(' ') || '·';
      return `<td class="plan-cell plan-month${isShort ? ' is-short' : ''}${c.key === short ? ' is-first-short' : ''}${idle ? ' plan-idle' : ''}">
        <span class="plan-closing">${num(c.closing)}</span>
        <span class="plan-demand">${moves}</span>
      </td>`;
    }).join('')}
  </tr>`).join('');

  renderPlanBadge();
}

function renderPlanBadge() {
  const badge = $('#planBadge');
  const n = db.products.filter((p) => hasPlan(p) && projectPlan(p, ui.planMonths).short).length;
  badge.textContent = n;
  badge.hidden = n === 0;
}

/** When the order has to go out, worded by how urgent it is. */
function orderByCell(p) {
  const d = daysUntilOrder(p);
  if (d === Infinity) {
    return `<span class="pill">Nothing used yet</span>`;
  }
  if (d < 0) {
    return `<span class="pill is-out">Late by ${num(-d)} day${d === -1 ? '' : 's'}</span>`;
  }
  if (d === 0) return `<span class="pill is-out">Order today</span>`;
  const date = longDate(orderByDate(p));
  if (d <= 7) return `<span class="pill is-low">${esc(date)}</span><div class="p-meta">in ${num(d)} day${d === 1 ? '' : 's'}</div>`;
  return `<span>${esc(date)}</span><div class="p-meta">in ${num(d)} days</div>`;
}

function renderReorder() {
  $('#coverDaysLabel').textContent = num(db.settings.coverDays || 30);

  // Soonest deadline first — that is the order she has to work through.
  const rows = needsOrder().sort((a, b) => daysUntilOrder(a) - daysUntilOrder(b));
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
      <td class="num">${onOrder(p.id) ? num(onOrder(p.id)) : '<span class="muted">—</span>'}</td>
      <td class="num">${num(Math.round(velocity(p) * 7 * 10) / 10)}</td>
      <td>${orderByCell(p)}</td>
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

/* Orders ------------------------------------------------------------------- */

function renderOrdersBadge() {
  const badge = $('#ordersBadge');
  const n = db.orders.filter(orderIsLate).length || openOrders().length;
  badge.textContent = n;
  badge.hidden = n === 0;
  badge.classList.toggle('is-late', db.orders.filter(orderIsLate).length > 0);
}

function visibleOrders() {
  const f = $('#orderFilter').value;
  const rows = [...db.orders];
  const live = rows.filter(orderIsOpen);
  if (f === 'all') return rows.sort((a, b) => (a.orderedOn < b.orderedOn ? 1 : -1));
  if (f === 'late') return live.filter(orderIsLate);
  if (f === 'done') return rows.filter((o) => !orderIsOpen(o)).sort((a, b) => (a.orderedOn < b.orderedOn ? 1 : -1));
  // Live: soonest due first, undated last.
  return live.sort((a, b) => {
    if (!a.expectedOn && !b.expectedOn) return 0;
    if (!a.expectedOn) return 1;
    if (!b.expectedOn) return -1;
    return a.expectedOn < b.expectedOn ? -1 : 1;
  });
}

function renderOrders() {
  $('#supplierList').innerHTML = [...new Set(db.products.map((p) => p.supplier).filter(Boolean))]
    .sort().map((s) => `<option value="${esc(s)}"></option>`).join('');

  const late = db.orders.filter(orderIsLate);
  const open = openOrders();
  const owed = open.reduce((s, o) => s + o.lines.reduce((t, l) => t + lineOutstanding(l) * l.unitCost, 0), 0);
  $('#orderStatRow').innerHTML = db.orders.length ? [
    statTile({ label: 'Open orders', value: num(open.length), sub: `${num(open.reduce((s, o) => s + orderOutstanding(o), 0))} units still owed` }),
    statTile({
      label: 'Late', value: num(late.length),
      sub: late.length ? 'past their promised date' : 'all on schedule',
      subClass: late.length ? 'is-bad' : 'is-good', alert: late.length > 0,
    }),
    statTile({ label: 'Value outstanding', value: money(owed), sub: 'still to be delivered' }),
  ].join('') : '';

  const rows = visibleOrders();
  $('#ordersEmpty').hidden = db.orders.length > 0;

  $('#orderList').innerHTML = rows.length ? rows.map((o) => {
    const st = orderStatus(o);
    const isLate = orderIsLate(o);
    const ordered = orderOrdered(o);
    const got = orderReceived(o);
    const pct = ordered > 0 ? Math.min(100, Math.round((got / ordered) * 100)) : 0;
    const due = o.expectedOn
      ? `${isLate ? 'was due ' : 'due '}${esc(longDate(o.expectedOn))}${isLate ? ` — ${num(daysBetween(o.expectedOn, dateKey()))} days late` : ''}`
      : 'no date given';

    return `<div class="order-card${isLate ? ' is-late' : ''}" data-id="${o.id}">
      <div class="order-head">
        <div>
          <div class="order-who">${esc(o.supplier || 'No supplier')}${o.ref ? ` <span class="order-meta">· ${esc(o.ref)}</span>` : ''}</div>
          <div class="order-meta">Ordered ${esc(longDate(o.orderedOn))} · ${due}</div>
        </div>
        <span class="pill is-${st}${isLate ? ' is-late-order' : ''}">${isLate ? 'Late' : ORDER_STATUS_TEXT[st]}</span>
        <div class="order-progress" title="${num(got)} of ${num(ordered)} received"><span style="width:${pct}%"></span></div>
        <span class="spacer"></span>
        ${orderIsOpen(o) ? `<button class="btn btn-sm btn-primary" data-act="receive-order" data-id="${o.id}">Book in delivery</button>` : ''}
        <button class="btn btn-sm" data-act="edit-order" data-id="${o.id}">${orderIsOpen(o) ? 'Edit' : 'View'}</button>
        <button class="btn btn-sm" data-act="print-order" data-id="${o.id}">Print</button>
      </div>
      <div class="order-body">
        ${o.lines.map((l) => {
          const p = productById(l.productId);
          const owedQty = lineOutstanding(l);
          return `<div class="order-line">
            <span class="order-line-name">${esc(p ? p.name : 'Deleted product')}</span>
            <span class="order-line-qty">${num(l.received)} of ${num(l.qty)} in
              ${owedQty > 0 ? `· <span class="short">${num(owedQty)} still owed</span>` : '· <span class="done">complete</span>'}</span>
            <span class="order-line-qty">${money(l.qty * l.unitCost)}</span>
          </div>`;
        }).join('')}
        ${o.notes ? `<p class="order-meta" style="margin-top:10px">${esc(o.notes)}</p>` : ''}
        ${o.receipts.length ? `<ul class="order-receipts">${o.receipts.map((r) => `<li>Delivered ${esc(longDate(r.date))} — ${
          r.lines.map((rl) => { const p = productById(rl.productId); return `${num(rl.qty)} ${esc(p ? p.name : '?')}`; }).join(', ')
        }${r.note ? ` (${esc(r.note)})` : ''}</li>`).join('')}</ul>` : ''}
      </div>
    </div>`;
  }).join('') : (db.orders.length ? '<p class="empty">Nothing matches that filter.</p>' : '');

  renderOrdersBadge();
}

/* Building and editing an order ------------------------------------------- */

let orderDraft = [];

function orderLineRow(line, i) {
  const opts = [...db.products].sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `<option value="${p.id}"${p.id === line.productId ? ' selected' : ''}>${esc(p.name)}${p.sku ? ` (${esc(p.sku)})` : ''}</option>`).join('');
  return `<div class="order-line-row" data-i="${i}">
    <label class="field"><span>Product</span>
      <select class="input input-select" data-line="productId">${opts}</select></label>
    <label class="field field-sm"><span>Quantity</span>
      <input class="input" type="number" min="0" step="1" data-line="qty" value="${line.qty}"></label>
    <label class="field field-sm"><span>Unit cost</span>
      <input class="input" type="number" min="0" step="0.01" data-line="unitCost" value="${line.unitCost}"></label>
    <button class="btn btn-sm btn-ghost" type="button" data-act="drop-line" data-i="${i}">Remove</button>
  </div>`;
}

function renderOrderLines() {
  $('#orderLines').innerHTML = orderDraft.map(orderLineRow).join('')
    || '<p class="muted">No products on this order yet.</p>';
  const total = orderDraft.reduce((s, l) => s + clampNum(l.qty) * clampNum(l.unitCost), 0);
  $('#orderFormTotal').textContent = total > 0 ? money(total) : '—';
}

function readOrderLines() {
  orderDraft = $$('#orderLines .order-line-row').map((row) => ({
    productId: $('[data-line="productId"]', row).value,
    qty: clampNum($('[data-line="qty"]', row).value),
    unitCost: clampNum($('[data-line="unitCost"]', row).value),
    received: orderDraft[Number(row.dataset.i)]?.received || 0,
  }));
}

function openOrderModal(id, seedLines) {
  const o = id ? db.orders.find((x) => x.id === id) : null;
  if (!db.products.length) { toast('Add some products first.'); showView('products'); return; }

  $('#orderModalTitle').textContent = o ? 'Purchase order' : 'New purchase order';
  $('#o_id').value = o ? o.id : '';
  $('#o_supplier').value = o ? o.supplier : (seedLines?.supplier || '');
  $('#o_ref').value = o ? o.ref : '';
  $('#o_orderedOn').value = o ? o.orderedOn : dateKey();
  $('#o_expectedOn').value = o ? o.expectedOn : (seedLines?.expectedOn || '');
  $('#o_notes').value = o ? o.notes : '';
  $('#orderError').hidden = true;
  $('#cancelOrder').hidden = !o || !orderIsOpen(o);

  orderDraft = o
    ? o.lines.map((l) => ({ ...l }))
    : (seedLines?.lines || [{ productId: db.products[0].id, qty: 1, unitCost: db.products[0].cost, received: 0 }]);
  renderOrderLines();
  $('#orderModal').showModal();
}

function saveOrder(e) {
  readOrderLines();
  const lines = orderDraft.filter((l) => l.productId && l.qty > 0);
  if (!lines.length) {
    e.preventDefault();
    $('#orderError').textContent = 'Put at least one product with a quantity on the order.';
    $('#orderError').hidden = false;
    return;
  }
  const id = $('#o_id').value;
  const fields = {
    supplier: $('#o_supplier').value.trim(),
    ref: $('#o_ref').value.trim(),
    orderedOn: $('#o_orderedOn').value || dateKey(),
    expectedOn: $('#o_expectedOn').value || '',
    notes: $('#o_notes').value.trim(),
    lines,
  };

  if (id) {
    const o = db.orders.find((x) => x.id === id);
    // Keep what has already been booked in — editing the paperwork must not
    // silently un-receive a delivery that physically arrived.
    fields.lines = lines.map((l) => {
      const was = o.lines.find((x) => x.productId === l.productId);
      return { ...l, received: Math.min(l.qty, was ? was.received : 0) };
    });
    Object.assign(o, fields);
    toast('Order updated.');
  } else {
    db.orders.push(normOrder({ ...fields, id: uid() }));
    toast('Order raised.');
  }
  save();
  renderAll();
}

async function cancelOrder() {
  const o = db.orders.find((x) => x.id === $('#o_id').value);
  if (!o) return;
  const ok = await confirmAction('Cancel this order?',
    `${num(orderOutstanding(o))} units still owed from ${o.supplier || 'this supplier'} will stop counting towards your cover.`, 'Cancel the order');
  if (!ok) return;
  o.cancelled = true;
  save();
  renderAll();
  toast('Order cancelled.');
}

/** Raise draft orders straight from the buying list, one per supplier. */
function ordersFromBuyingList() {
  const rows = needsOrder();
  if (!rows.length) { toast('Nothing on the buying list right now.'); return; }
  const bySupplier = new Map();
  rows.forEach((p) => {
    const key = p.supplier || '';
    if (!bySupplier.has(key)) bySupplier.set(key, []);
    bySupplier.get(key).push(p);
  });
  // Always the same shape of result: drafts on the Orders page, ready to be
  // checked and edited. Behaving differently for one supplier than for
  // several just makes the button unpredictable.
  bySupplier.forEach((items, supplier) => {
    db.orders.push(normOrder({
      id: uid(), supplier,
      orderedOn: dateKey(),
      expectedOn: dateKey(addDays(new Date(), leadTime(items[0]) || 0)),
      lines: items.map((p) => ({ productId: p.id, qty: suggestedOrder(p), unitCost: p.cost, received: 0 })),
    }));
  });
  save();
  renderAll();
  showView('orders');
  toast(`${num(bySupplier.size)} order${bySupplier.size === 1 ? '' : 's'} raised from ${num(rows.length)} product${rows.length === 1 ? '' : 's'} — check them over before sending.`);
}

/* Booking in a delivery ---------------------------------------------------- */

let receivingId = null;

function openReceiveModal(id) {
  const o = db.orders.find((x) => x.id === id);
  if (!o) return;
  receivingId = id;
  $('#receiveHead').textContent = `${o.supplier || 'Order'}${o.ref ? ` · ${o.ref}` : ''} — ${num(orderOutstanding(o))} units still owed.`;
  $('#rc_date').value = dateKey();
  $('#rc_note').value = '';
  $('#rc_closeShort').checked = false;
  $('#receiveError').hidden = true;

  $('#receiveLines').innerHTML = o.lines.map((l, i) => {
    const p = productById(l.productId);
    const owed = lineOutstanding(l);
    return `<div class="receive-line-row" data-i="${i}">
      <div class="receive-line-name">${esc(p ? p.name : 'Deleted product')}
        <div class="receive-line-owed">${owed > 0 ? `${num(owed)} still owed of ${num(l.qty)}` : 'fully delivered'}</div></div>
      <label class="field"><span>Arrived now</span>
        <input class="input" type="number" min="0" max="${owed}" step="1" data-owed="${owed}" value="0"${owed === 0 ? ' disabled' : ''}></label>
    </div>`;
  }).join('');
  $('#receiveModal').showModal();
}

function receiveAllOutstanding() {
  $$('#receiveLines input[type="number"]').forEach((inp) => { inp.value = inp.dataset.owed; });
}

function saveReceipt(e) {
  const o = db.orders.find((x) => x.id === receivingId);
  if (!o) { e.preventDefault(); return; }

  const got = $$('#receiveLines .receive-line-row').map((row) => {
    const i = Number(row.dataset.i);
    const inp = $('input[type="number"]', row);
    return { i, qty: Math.min(clampNum(inp.value), clampNum(inp.dataset.owed)) };
  }).filter((g) => g.qty > 0);

  const closeShort = $('#rc_closeShort').checked;
  if (!got.length && !closeShort) {
    e.preventDefault();
    $('#receiveError').textContent = 'Enter what actually arrived, or tick the box to close the rest short.';
    $('#receiveError').hidden = false;
    return;
  }

  const date = $('#rc_date').value || dateKey();
  const receiptLines = [];
  got.forEach(({ i, qty }) => {
    const line = o.lines[i];
    line.received += qty;
    const p = productById(line.productId);
    if (p) p.stock += qty;
    // A delivery is a restock, so it shows up in the stock history too.
    db.restocks.push(normRestock({ id: uid(), productId: line.productId, qty, unitCost: line.unitCost, date }));
    receiptLines.push({ productId: line.productId, qty });
  });

  if (receiptLines.length) o.receipts.push(normReceipt({ id: uid(), date, note: $('#rc_note').value.trim(), lines: receiptLines }));
  if (closeShort) o.closed = true;

  save();
  renderAll();
  const total = receiptLines.reduce((s, l) => s + l.qty, 0);
  toast(closeShort && !total ? 'Order closed short.'
    : `${num(total)} units booked in${closeShort ? ' — rest closed short' : orderOutstanding(o) ? `, ${num(orderOutstanding(o))} still owed` : ', order complete'}.`);
}

function printOneOrder(id) {
  const o = db.orders.find((x) => x.id === id);
  if (!o) return;
  const body = o.lines.map((l) => {
    const p = productById(l.productId);
    return `<tr><td>${esc(p ? p.name : '—')}</td><td>${esc(p ? p.sku : '')}</td>
      <td class="num">${num(l.qty)}</td><td class="num">${num(l.received)}</td>
      <td class="num">${esc(money(l.qty * l.unitCost))}</td></tr>`;
  }).join('');
  $('#printArea').innerHTML = `
    <h1>Purchase order — ${esc(db.settings.shopName || 'Stock Manager')}</h1>
    <p class="po-meta">${esc(o.supplier || 'Supplier')}${o.ref ? ` · ${esc(o.ref)}` : ''} ·
      ordered ${esc(longDate(o.orderedOn))}${o.expectedOn ? ` · expected ${esc(longDate(o.expectedOn))}` : ''}</p>
    <table>
      <thead><tr><th>Product</th><th>Code</th><th class="num">Ordered</th><th class="num">Received</th><th class="num">Value</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td colspan="4" class="num"><strong>Total</strong></td><td class="num"><strong>${esc(money(orderValue(o)))}</strong></td></tr></tfoot>
    </table>
    ${o.notes ? `<p class="po-meta">${esc(o.notes)}</p>` : ''}`;
  window.print();
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
  $('#setLeadTime').value = clampNum(db.settings.defaultLeadTimeDays);
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
  $('#p_leadTimeDays').value = p ? p.leadTimeDays : clampNum(db.settings.defaultLeadTimeDays);
  $('#p_discontinued').checked = p ? !!p.discontinued : false;
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
    leadTimeDays: clampNum($('#p_leadTimeDays').value),
    discontinued: $('#p_discontinued').checked,
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

async function deleteProduct(id) {
  const p = productById(id || $('#p_id').value);
  if (!p) return;
  const salesCount = db.sales.filter((s) => s.productId === p.id).length;
  const onOpenOrders = openOrders().filter((o) => o.lines.some((l) => l.productId === p.id)).length;
  const consequences = [
    salesCount ? `its ${salesCount} recorded sale(s)` : '',
    onOpenOrders ? `its lines on ${onOpenOrders} open order(s)` : '',
  ].filter(Boolean);
  const ok = await confirmAction(
    `Delete “${p.name}”?`,
    consequences.length
      ? `This also removes ${consequences.join(' and ')}. This cannot be undone.`
      : 'This cannot be undone.',
    'Delete it',
  );
  if (!ok) return;
  db.products = db.products.filter((x) => x.id !== p.id);
  db.sales = db.sales.filter((s) => s.productId !== p.id);
  db.restocks = db.restocks.filter((r) => r.productId !== p.id);
  // Leave no phantom stock "on the way" from a product that no longer exists.
  db.orders.forEach((o) => { o.lines = o.lines.filter((l) => l.productId !== p.id); });
  db.orders = db.orders.filter((o) => o.lines.length > 0);
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
    p.name, p.sku, p.category, p.supplier, p.unit, p.stock, onOrder(p.id), p.reorderPoint, p.reorderQty,
    p.leadTimeDays, p.cost, p.price, unitsSold(p.id, from30), STATUS_TEXT[status(p)],
    orderByDate(p) || '', suggestedOrder(p),
  ]);
  download(`products-${dateKey()}.csv`, toCsv(
    ['Product', 'Code', 'Category', 'Supplier', 'Unit', 'In stock', 'On order', 'Alert at', 'Usual order',
      'Lead time (days)', 'Cost', 'Price', 'Used last 30 days', 'Status', 'Order by',
      'Order this much'], rows), 'text/csv');
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

/* ── Spreadsheet import ────────────────────────────────────────────────── *
 * Accepts whatever Excel puts on the clipboard (tab-separated) as well as
 * comma- or semicolon-separated files, then matches the header row against
 * the names people actually use for these columns.                          */

const IMPORT_ALIASES = {
  sku: ['code', 'sku', 'barcode', 'ref', 'reference', 'productcode', 'itemcode', 'articlecode', 'art', 'codebarre'],
  name: ['product', 'productname', 'name', 'item', 'itemname', 'description', 'designation', 'article', 'nom', 'produit', 'libelle'],
  category: ['category', 'categories', 'type', 'group', 'department', 'categorie', 'famille', 'rayon'],
  supplier: ['supplier', 'vendor', 'brand', 'make', 'manufacturer', 'fournisseur', 'marque'],
  unit: ['unit', 'units', 'uom', 'measure', 'packaging', 'unite'],
  stock: ['instock', 'stock', 'qty', 'quantity', 'onhand', 'stockonhand', 'currentstock', 'stocknow',
    'remainingstock', 'stockremaining', 'remaining', 'available', 'availablestock', 'stockavailable',
    'balance', 'stockbalance', 'currentqty', 'qtyonhand', 'unitsinstock', 'stockunits', 'stockcount',
    'quantite', 'qte', 'stockactuel'],
  reorderPoint: ['alertat', 'alert', 'reorderpoint', 'reorderlevel', 'min', 'minimum', 'minstock', 'seuil', 'stockmin', 'alerte'],
  reorderQty: ['usualorder', 'orderqty', 'reorderqty', 'packsize', 'pack', 'casesize', 'orderquantity', 'moq', 'minimumorderquantity', 'colisage'],
  leadTimeDays: ['leadtime', 'leadtimedays', 'leadtimeindays', 'deliverytime', 'deliverydays', 'supplierleadtime',
    'replenishmentleadtime', 'transittime', 'delaidelivraison', 'delai'],
  lifecycle: ['status', 'itemstatus', 'productstatus', 'lifecycle', 'lifecyclestatus', 'state', 'active', 'etat', 'statut'],
  cost: ['cost', 'costprice', 'buyprice', 'buyingprice', 'purchase', 'purchaseprice', 'wholesale', 'prixachat', 'achat'],
  price: ['price', 'sellprice', 'sellingprice', 'saleprice', 'retail', 'retailprice', 'rrp', 'prixvente', 'vente', 'prix'],
};

const normHeader = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function pickDelimiter(text) {
  const line = text.split('\n')[0] || '';
  const count = (ch) => line.split(ch).length - 1;
  const tabs = count('\t');
  const semis = count(';');
  const commas = count(',');
  if (tabs >= semis && tabs >= commas && tabs > 0) return '\t';
  if (semis >= commas && semis > 0) return ';';
  return ',';
}

/** Split delimited text into rows, honouring "quoted, cells". */
function parseDelimited(text) {
  const clean = String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!clean.trim()) return [];
  const delim = pickDelimiter(clean);
  const rows = [];
  let row = [], cell = '', quoted = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch !== '"') { cell += ch; continue; }
      if (clean[i + 1] === '"') { cell += '"'; i++; continue; }
      quoted = false;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Numbers from a spreadsheet may carry currency symbols, spaces or a comma decimal. */
function parseLooseNumber(raw) {
  const s = String(raw).replace(/[^\d.,-]/g, '').trim();
  if (!s) return 0;
  // "1.234,56" (European) vs "1,234.56" (English) — the last separator wins.
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let normalised = s;
  if (lastComma > -1 && lastComma > lastDot) normalised = s.replace(/\./g, '').replace(',', '.');
  else normalised = s.replace(/,/g, '');
  return clampNum(normalised);
}

function readImportTable(text) {
  const rows = parseDelimited(text);
  if (rows.length < 1) return { error: 'Nothing to read there yet.' };

  const rawHeader = rows[0];
  const header = rawHeader.map(normHeader);
  const mapping = {};
  Object.entries(IMPORT_ALIASES).forEach(([field, aliases]) => {
    const idx = header.findIndex((h) => h && aliases.includes(h));
    if (idx > -1) mapping[field] = idx;
  });

  // Any column headed with a month is a demand-plan period, not a field.
  const monthCols = [];
  rawHeader.forEach((h, i) => {
    if (Object.values(mapping).includes(i)) return;
    const key = parseMonthHeader(h);
    if (key) monthCols.push({ index: i, key });
  });

  if (mapping.name === undefined && mapping.sku === undefined) {
    return { error: 'No “Product” or “Code” column found. Make sure the first row you copied is the header row.' };
  }

  const items = [];
  rows.slice(1).forEach((r) => {
    const text2 = (f) => (mapping[f] === undefined ? '' : String(r[mapping[f]] ?? '').trim());
    const numAt = (f) => (mapping[f] === undefined ? undefined : parseLooseNumber(r[mapping[f]]));
    const sku = text2('sku');
    const name = text2('name') || sku;
    if (!name) return;

    // Blank month cells mean "nothing planned", so they are left out rather
    // than stored as a real zero — that distinction matters for a plan.
    const demand = {};
    monthCols.forEach(({ index, key }) => {
      const cell = String(r[index] ?? '').trim();
      if (cell !== '') demand[key] = parseLooseNumber(cell);
    });

    const lifecycle = text2('lifecycle').toLowerCase();
    items.push({
      sku, name: name.slice(0, 80),
      category: text2('category'), supplier: text2('supplier'), unit: text2('unit'),
      stock: numAt('stock'), reorderPoint: numAt('reorderPoint'), reorderQty: numAt('reorderQty'),
      leadTimeDays: numAt('leadTimeDays'), cost: numAt('cost'), price: numAt('price'),
      discontinued: lifecycle ? /discontinu|inactive|obsolete|delisted|arret/.test(lifecycle) : undefined,
      demand: Object.keys(demand).length ? demand : undefined,
    });
  });

  if (!items.length) return { error: 'Found the header row, but no product rows under it.' };
  return { items, mapping, matched: Object.keys(mapping), monthCols };
}

/** Existing product with the same code, or failing that the same name. */
function findExisting(item) {
  const bySku = item.sku && db.products.find((p) => p.sku && p.sku.toLowerCase() === item.sku.toLowerCase());
  if (bySku) return bySku;
  return db.products.find((p) => p.name.toLowerCase() === item.name.toLowerCase());
}

let importState = { items: null };

function updateImportPreview() {
  const text = $('#importPaste').value;
  const box = $('#importPreview');
  const err = $('#importError');
  const go = $('#importGo');

  importState.items = null;
  go.disabled = true;
  err.hidden = true;

  if (!text.trim()) { box.innerHTML = ''; return; }

  const result = readImportTable(text);
  if (result.error) {
    box.innerHTML = '';
    err.textContent = result.error;
    err.hidden = false;
    return;
  }

  importState.items = result.items;
  go.disabled = false;

  const existing = result.items.filter((i) => findExisting(i)).length;
  const fresh = result.items.length - existing;
  const FIELD_LABELS = { lifecycle: 'Status' };
  const cols = result.matched.map((f) => FIELD_LABELS[f] || GRID_COLS.find((c) => c.key === f)?.label || f);
  const preview = result.items.slice(0, 6);
  const months = result.monthCols || [];
  const dropped = result.items.filter((i) => i.discontinued).length;

  box.innerHTML = `
    <div class="import-summary">
      <div><strong>${num(fresh)}</strong> new product${fresh === 1 ? '' : 's'}</div>
      <div><strong>${num(existing)}</strong> already here</div>
      ${months.length ? `<div><strong>${num(months.length)}</strong> months of demand</div>` : ''}
      ${dropped ? `<div><strong>${num(dropped)}</strong> discontinued</div>` : ''}
    </div>
    <p class="import-cols">Columns picked up: ${cols.map((c) => `<code>${esc(c)}</code>`).join(' ')}</p>
    ${months.length ? `<p class="import-cols">Read as a monthly demand plan:
      <code>${esc(monthLabel(months[0].key))}</code> → <code>${esc(monthLabel(months[months.length - 1].key))}</code></p>` : ''}
    <div class="import-table-wrap"><table class="table">
      <thead><tr><th>Code</th><th>Product</th><th class="num">In stock</th>${months.length ? '<th class="num">Planned total</th>' : ''}<th class="num">Cost</th><th class="num">Price</th></tr></thead>
      <tbody>${preview.map((i) => `<tr>
        <td>${esc(i.sku || '—')}${i.discontinued ? ' <span class="p-meta">discontinued</span>' : ''}</td><td>${esc(i.name)}</td>
        <td class="num">${i.stock === undefined ? '—' : num(i.stock)}</td>
        ${months.length ? `<td class="num">${i.demand ? num(Object.values(i.demand).reduce((s, v) => s + v, 0)) : '—'}</td>` : ''}
        <td class="num">${i.cost === undefined ? '—' : money(i.cost)}</td>
        <td class="num">${i.price === undefined ? '—' : money(i.price)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${result.items.length > preview.length ? `<p class="import-cols">…and ${num(result.items.length - preview.length)} more row(s).</p>` : ''}`;
}

function runImport(e) {
  if (!importState.items) { e.preventDefault(); return; }
  const allowUpdate = $('#importUpdate').checked;
  let added = 0, updated = 0, skipped = 0;

  importState.items.forEach((item) => {
    const existing = findExisting(item);
    if (existing) {
      if (!allowUpdate) { skipped++; return; }
      // Only overwrite the columns the spreadsheet actually supplied.
      Object.entries(item).forEach(([k, v]) => {
        if (v === undefined || v === '') return;
        existing[k] = v;
      });
      updated++;
    } else {
      db.products.push(normProduct({ ...item, id: uid(), createdAt: dateKey() }));
      added++;
    }
  });

  save();
  renderAll();
  $('#importPaste').value = '';
  $('#importPreview').innerHTML = '';
  importState.items = null;
  toast(`Imported — ${num(added)} added, ${num(updated)} updated${skipped ? `, ${num(skipped)} left alone` : ''}.`);
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
  const rows = needsOrder().sort((a, b) => daysUntilOrder(a) - daysUntilOrder(b));
  if (!rows.length) { toast('Nothing to order right now.'); return; }
  let total = 0;
  const body = rows.map((p) => {
    const qty = suggestedOrder(p);
    total += qty * p.cost;
    const by = orderByDate(p);
    return `<tr><td>${esc(p.name)}</td><td>${esc(p.sku || '')}</td><td>${esc(p.supplier || '')}</td>
      <td class="num">${num(p.stock)}</td><td>${esc(by ? longDate(by) : '—')}</td>
      <td class="num">${num(qty)}</td><td class="num">${esc(money(qty * p.cost))}</td></tr>`;
  }).join('');

  $('#printArea').innerHTML = `
    <h1>Purchase order — ${esc(db.settings.shopName || 'Stock Manager')}</h1>
    <p class="po-meta">Prepared ${esc(longDate(dateKey()))} · ${num(rows.length)} products · stock to cover about ${num(db.settings.coverDays || 30)} days</p>
    <table>
      <thead><tr><th>Product</th><th>Code</th><th>Supplier</th><th class="num">In stock</th><th>Order by</th><th class="num">Order</th><th class="num">Est. cost</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td colspan="6" class="num"><strong>Total</strong></td><td class="num"><strong>${esc(money(total))}</strong></td></tr></tfoot>
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
    orders: [],
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
  if (name === 'ask') { greetAsk(); $('#chatInput').focus(); }
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
  updateUndoButton();

  /* Undo */
  $('#undoBtn').addEventListener('click', undoLast);

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
    if (act === 'delete') deleteProduct(id);
    if (act === 'undo-sale') undoSale(id);
    if (act === 'edit-order') openOrderModal(id);
    if (act === 'receive-order') openReceiveModal(id);
    if (act === 'print-order') printOneOrder(id);
  });

  /* Orders */
  $('#newOrder').addEventListener('click', () => openOrderModal());
  $('#ordersFromList').addEventListener('click', ordersFromBuyingList);
  $('#orderFilter').addEventListener('change', renderOrders);
  $('#orderForm').addEventListener('submit', saveOrder);
  $('#cancelOrder').addEventListener('click', () => { $('#orderModal').close(); cancelOrder(); });
  $('#addOrderLine').addEventListener('click', () => {
    readOrderLines();
    orderDraft.push({ productId: db.products[0].id, qty: 1, unitCost: db.products[0].cost, received: 0 });
    renderOrderLines();
  });
  $('#orderLines').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act="drop-line"]');
    if (!btn) return;
    readOrderLines();
    orderDraft.splice(Number(btn.dataset.i), 1);
    renderOrderLines();
  });
  $('#orderLines').addEventListener('input', (e) => {
    if (!e.target.closest('[data-line]')) return;
    readOrderLines();
    const total = orderDraft.reduce((s, l) => s + l.qty * l.unitCost, 0);
    $('#orderFormTotal').textContent = total > 0 ? money(total) : '—';
  });
  $('#receiveForm').addEventListener('submit', saveReceipt);
  $('#receiveAll').addEventListener('click', receiveAllOutstanding);

  /* Spreadsheet mode: cell editing and keyboard navigation */
  $$('#productMode .seg-btn').forEach((b) => b.addEventListener('click', () => showProductMode(b.dataset.mode)));
  $('#gridAddRow').addEventListener('click', addGridRow);

  $('#productGrid').addEventListener('click', (e) => {
    const span = e.target.closest('.grid-text');
    if (span) beginGridEdit(span.closest('.grid-cell'));
  });
  $('#productGrid').addEventListener('keydown', (e) => {
    const span = e.target.closest('.grid-text');
    if (!span) return;
    const td = span.closest('.grid-cell');
    const nav = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];

    if (nav) { if (moveGridFocus(td, nav[0], nav[1])) e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); beginGridEdit(td); }
    else if (e.key === 'Tab') { if (moveGridFocus(td, 0, e.shiftKey ? -1 : 1)) e.preventDefault(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); beginGridEdit(td, ''); }
    // Typing straight over a cell replaces it, exactly like a spreadsheet.
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); beginGridEdit(td, e.key); }
  });

  /* Spreadsheet import */
  $('#importProducts').addEventListener('click', () => {
    $('#importPaste').value = '';
    $('#importPreview').innerHTML = '';
    $('#importError').hidden = true;
    $('#importGo').disabled = true;
    importState.items = null;
    $('#importModal').showModal();
    $('#importPaste').focus();
  });
  $('#importPaste').addEventListener('input', updateImportPreview);
  $('#importPaste').addEventListener('paste', () => setTimeout(updateImportPreview, 0));
  $('#importUpdate').addEventListener('change', updateImportPreview);
  $('#importForm').addEventListener('submit', runImport);
  $('#importPickFile').addEventListener('click', () => $('#importCsvFile').click());
  $('#importCsvFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { $('#importPaste').value = String(reader.result); updateImportPreview(); };
    reader.readAsText(file);
    e.target.value = '';
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
  /* Ask */
  renderAskChips();
  $('#chatForm').addEventListener('submit', (e) => { e.preventDefault(); askQuestion($('#chatInput').value); });
  $('#chatChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) askQuestion(chip.textContent);
  });

  $$('#planRange .seg-btn').forEach((b) => b.addEventListener('click', () => {
    $$('#planRange .seg-btn').forEach((x) => x.classList.toggle('is-active', x === b));
    ui.planMonths = Number(b.dataset.months);
    renderPlan();
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
    db.settings.defaultLeadTimeDays = Math.min(365, clampNum($('#setLeadTime').value));
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
    // Normalised, not assigned raw: that way a field added later can never
    // be missing from the demo and blow up somewhere far from here.
    db = normalise(demoData());
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

  /* First run with nothing loaded — not even starter data — offer the demo. */
  if (!db.products.length) {
    showView('products');
    toast('Welcome! Add your first product, or load the demo data from Settings.');
  }
}

document.addEventListener('DOMContentLoaded', init);

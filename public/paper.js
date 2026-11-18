// StockSense — Paper Trading screens: Holdings / Positions / Orders / P&L report /
// a step-by-step "Learn" guide, and an order window laid out like a broker app
// (Buy/Sell toggle, Delivery or Intraday, Market / Limit / SL-M, margin and charges).
// All money is virtual and stored only in this browser (localStorage).
import * as E from '/lib/paper.js';

let C = null; // helpers injected by app.js (avoids a circular import)
let shown = null; // the Paper Trading page currently on screen
let modal = null; // the order window currently open
let bgTimer = null;
const quoteCache = {}; // symbol -> last quote seen

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const SUBS = ['holdings', 'positions', 'orders', 'pnl', 'learn'];
const KEY = (m) => `ss.paper.${m}`;

// ---------- storage ----------
const loadAcct = (m) => {
  const a = C.store.get(KEY(m), null);
  return E.validAccount(a, m) ? a : E.newAccount(m);
};
const saveAcct = (a) => C.store.set(KEY(a.market), a);

// ---------- formatting ----------
const fmtCache = {};
function money(v, cur) {
  if (!C.isNum(v)) return '—';
  const f = (fmtCache[cur] ??= new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  return f.format(v);
}
function pnl(v, cur) {
  if (!C.isNum(v)) return '—';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${money(Math.abs(v), cur)}`;
}
const pct = (v) => (C.isNum(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%` : '—');
const when = (ms) => new Date(ms).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const short = (s) => String(s).replace(/\.(NS|BO)$/i, '');
const num = (id, root = document) => {
  const el = $(id, root);
  const v = el ? parseFloat(el.value) : NaN;
  return Number.isFinite(v) ? v : NaN;
};
function duration(a, b) {
  const s = Math.max(0, (b - a) / 1000);
  if (s < 90) return `${Math.round(s)} sec`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${Math.round(s / 86400)} days`;
}

// ---------- public API ----------
export function initPaper(ctx) {
  C = ctx;
  clearInterval(bgTimer);
  bgTimer = setInterval(backgroundTick, 20000);
}

export function cleanupPaper() {
  shown = null;
  closeOrder();
}

// ---------- prices & order processing ----------
async function fetchQuotes(symbols, signal) {
  const data = await C.api(`/api/quotes?symbols=${C.enc(symbols.join(','))}`, { signal, timeout: 30000 });
  for (const [sym, q] of Object.entries(data.quotes || {})) quoteCache[sym] = { ...q, at: Date.now() };
  return data;
}

function watchedSymbols(a) {
  return [...new Set([
    ...a.holdings.map((h) => h.symbol),
    ...a.positions.map((p) => p.symbol),
    ...a.orders.filter((o) => o.status === 'OPEN' || o.status === 'WAITING').map((o) => o.symbol),
  ])];
}

function announce(events) {
  const shownEvents = events.filter((e) => e.type === 'filled' || e.type === 'rejected' || e.type === 'cancelled');
  if (!shownEvents.length) return;
  const extra = shownEvents.length > 1 ? ` (+${shownEvents.length - 1} more — see Orders)` : '';
  C.toast(`${shownEvents[0].text}${extra}`);
}

// Fetch prices for everything in the account, then fill any orders that triggered.
async function syncAccount(market, signal) {
  const a0 = loadAcct(market);
  const syms = watchedSymbols(a0);
  const have = Object.fromEntries(syms.filter((s) => quoteCache[s]).map((s) => [s, quoteCache[s]]));
  if (!syms.length) return { quotes: {}, events: [] };
  let error = null;
  try {
    await fetchQuotes(syms, signal);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    error = e.message;
  }
  const quotes = Object.fromEntries(syms.filter((s) => quoteCache[s]).map((s) => [s, quoteCache[s]]));
  const a = loadAcct(market); // re-read: it may have changed while we waited
  const fresh = error ? {} : quotes;
  const events = [...E.squareOffStale(a, fresh), ...E.processOrders(a, fresh)];
  if (events.length) {
    saveAcct(a);
    announce(events);
  }
  return { quotes: Object.keys(quotes).length ? quotes : have, events, error };
}

// Runs for accounts the Paper page is not already refreshing, so a stop-loss
// can still trigger while you are looking at a chart.
async function backgroundTick() {
  if (!C || document.hidden) return;
  for (const market of ['IN', 'US']) {
    if (shown && shown.market === market) continue;
    const a = loadAcct(market);
    const live = a.orders.some((o) => o.status === 'OPEN') || a.positions.length > 0;
    if (!live) continue;
    try {
      await syncAccount(market);
    } catch {
      /* try again next tick */
    }
  }
}

// =====================================================================
// Page
// =====================================================================
export async function viewPaper(param, alive) {
  const market = C.state.market;
  shown = { market, alive, sub: SUBS.includes(param) ? param : null, quotes: {}, updated: null, error: null, busy: true };
  paint();
  const ctrl = C.newController();
  const refresh = async () => {
    if (!alive() || document.hidden) return;
    try {
      const r = await syncAccount(market, ctrl.signal);
      if (!alive() || !shown) return;
      shown.quotes = r.quotes;
      shown.fills = r.events.length > 0;
      shown.error = r.error || null;
      shown.updated = Date.now();
    } catch (e) {
      if (e.name === 'AbortError' || !alive() || !shown) return;
      shown.error = e.message;
    }
    if (!shown) return;
    const first = shown.busy;
    shown.busy = false;
    // The Learn tab has no live numbers, so only redraw it on the first load or when something filled.
    if (first || currentSub(loadAcct(market)) !== 'learn' || shown.fills) paint();
    shown.fills = false;
  };
  await refresh();
  C.state.timers.push(setInterval(refresh, 10000));
}

function currentSub(a) {
  if (shown.sub) return shown.sub;
  if (!a.orders.length) return 'learn';
  return a.holdings.length || !a.positions.length ? 'holdings' : 'positions';
}

function paint() {
  if (!shown || !shown.alive() || modal) return;
  const a = loadAcct(shown.market);
  const sub = currentSub(a);
  const sum = E.summary(a, shown.quotes);
  const body = { holdings: holdingsHtml, positions: positionsHtml, orders: ordersHtml, pnl: pnlHtml, learn: learnHtml }[sub](a, shown.quotes);
  const live = a.orders.filter((o) => o.status === 'OPEN' || o.status === 'WAITING').length;
  const tab = (id, label, n) => `<a href="#/paper/${id}" class="${sub === id ? 'active' : ''}" role="tab" aria-selected="${sub === id}">${label}${n ? ` <span class="pt-count">${n}</span>` : ''}</a>`;
  const status = shown.busy ? '<span class="spinner"></span> Loading prices…'
    : shown.error ? `<span class="down">⚠ ${C.esc(shown.error)}</span>`
    : shown.updated ? `Prices updated ${new Date(shown.updated).toLocaleTimeString()} · refreshes every 10 s` : '';
  C.view.innerHTML = `
    <div class="section-head pt-head">
      <div>
        <h1 class="pt-title">Paper Trading <span class="pill neutral">Virtual money · ${a.market === 'IN' ? 'India ₹' : 'US $'}</span></h1>
        <div class="small muted">Practise buying and selling at live prices — nothing here is real money.</div>
      </div>
      <div class="pt-actions">
        <button class="btn primary" id="ptNew">+ New order</button>
        <button class="btn" id="ptReset" title="Start again with fresh virtual funds">Reset account</button>
      </div>
    </div>

    <div class="grid cols-4 pt-funds">
      <div class="card"><div class="k">Available funds</div><div class="v num">${money(sum.cash, a.currency)}</div><div class="small muted">Margin blocked ${money(sum.marginUsed, a.currency)}</div></div>
      <div class="card"><div class="k">Portfolio value</div><div class="v num">${money(sum.equity, a.currency)}</div><div class="small num ${C.cls(sum.totalPnl)}">${pnl(sum.totalPnl, a.currency)} (${pct(sum.totalPct)}) since start</div></div>
      <div class="card"><div class="k">Unrealised P&amp;L</div><div class="v num ${C.cls(sum.unrealised)}">${pnl(sum.unrealised, a.currency)}</div><div class="small muted">Open holdings &amp; positions</div></div>
      <div class="card"><div class="k">Realised P&amp;L</div><div class="v num ${C.cls(sum.realised)}">${pnl(sum.realised, a.currency)}</div><div class="small muted">Closed trades, after charges</div></div>
    </div>

    <div class="pt-tabs" role="tablist" aria-label="Paper trading sections">
      ${tab('holdings', 'Holdings', a.holdings.length)}${tab('positions', 'Positions', a.positions.length)}${tab('orders', 'Orders', live)}${tab('pnl', 'P&amp;L report', a.trades.length)}${tab('learn', 'Learn · step by step')}
    </div>
    <div id="ptBody" class="section">${body}</div>
    <div class="small muted pt-foot">${status}</div>
    <div class="small muted">Prices come from Yahoo Finance and may be ~15 minutes delayed. Fills are instant at the last price; real markets add slippage, partial fills and rejections. Charges are approximate.</div>`;
  bindPage(a, sub);
}

function bindPage(a, sub) {
  $('#ptNew').addEventListener('click', () => openOrder({}));
  $('#ptReset').addEventListener('click', () => resetAccount(a));
  const body = $('#ptBody');
  body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) {
      e.stopPropagation();
      const { act, sym } = btn.dataset;
      const h = a.holdings.find((x) => x.symbol === sym);
      const p = a.positions.find((x) => x.symbol === sym);
      if (act === 'buy') openOrder({ symbol: sym, name: (h || p)?.name, side: 'BUY', product: p && !h ? 'INTRADAY' : 'DELIVERY' });
      else if (act === 'exit-holding') openOrder({ symbol: sym, name: h?.name, side: 'SELL', product: 'DELIVERY', qty: h?.qty });
      else if (act === 'exit-position') openOrder({ symbol: sym, name: p?.name, side: p.qty > 0 ? 'SELL' : 'BUY', product: 'INTRADAY', qty: Math.abs(p.qty) });
      else if (act === 'add-position') openOrder({ symbol: sym, name: p?.name, side: p.qty > 0 ? 'BUY' : 'SELL', product: 'INTRADAY' });
      else if (act === 'cancel') {
        const acct = loadAcct(a.market);
        const ev = E.cancelOrder(acct, Number(btn.dataset.id));
        saveAcct(acct);
        announce(ev);
        paint();
      } else if (act === 'new') openOrder({ symbol: sym, name: btn.dataset.name, side: 'BUY' });
      else if (act === 'open-new') openOrder({});
      return;
    }
    const row = e.target.closest('tr[data-sym], [data-go]');
    if (row) C.goAnalyze(row.dataset.sym || row.dataset.go);
  });
}

function resetAccount(a) {
  if (!confirm('Reset this paper account? All holdings, orders and trade history in this market will be erased.')) return;
  const def = E.START_FUNDS[a.market];
  const raw = prompt(`Starting virtual funds (${a.currency}):`, String(def));
  if (raw == null) return;
  const v = Number(String(raw).replace(/[, ]/g, ''));
  if (!Number.isFinite(v) || v < 1000) {
    C.toast('Please enter an amount of at least 1,000.');
    return;
  }
  saveAcct(E.newAccount(a.market, v));
  shown.quotes = {};
  C.toast('Paper account reset.');
  paint();
}

// ---------- tables ----------
const empty = (title, text, btn = '') => `<div class="card hero-empty"><h2>${title}</h2><p class="muted">${text}</p>${btn}</div>`;

function ltpCell(q, cur) {
  return q && C.isNum(q.price) ? money(q.price, cur) : '—';
}

function holdingsHtml(a, quotes) {
  if (!a.holdings.length) {
    return empty('No holdings yet', 'Holdings are shares you bought with <b>Delivery</b> and keep. Place a Delivery buy order to see it here.',
      `<div class="chips"><button class="btn primary" data-act="open-new">+ New order</button>${popularChips(a)}</div>`);
  }
  let totInv = 0, totVal = 0;
  const rows = a.holdings.map((h) => {
    const q = quotes[h.symbol];
    const ltp = q?.price;
    const inv = h.avg * h.qty;
    const val = C.isNum(ltp) ? ltp * h.qty : null;
    const pl = val == null ? null : val - inv;
    totInv += inv;
    totVal += val ?? inv;
    const plan = h.plan?.stop || h.plan?.target
      ? `<div class="small muted">SL ${h.plan.stop ? money(h.plan.stop, a.currency) : '—'} · Target ${h.plan.target ? money(h.plan.target, a.currency) : '—'}</div>` : '';
    return `<tr data-sym="${C.esc(h.symbol)}" title="Open the analysis for ${C.esc(h.symbol)}">
      <td><b>${C.esc(short(h.symbol))}</b><div class="small muted">${C.esc(h.name)}</div>${plan}</td>
      <td class="r num">${h.qty}</td><td class="r num">${money(h.avg, a.currency)}</td><td class="r num">${ltpCell(q, a.currency)}</td>
      <td class="r num">${money(inv, a.currency)}</td><td class="r num">${val == null ? '—' : money(val, a.currency)}</td>
      <td class="r num ${C.cls(pl)}"><b>${pnl(pl, a.currency)}</b><div class="small">${pct(pl == null ? null : (pl / inv) * 100)}</div></td>
      <td class="r num ${C.cls(q?.changePct)}">${pct(q?.changePct)}</td>
      <td class="r pt-row-actions"><button class="btn small buy" data-act="buy" data-sym="${C.esc(h.symbol)}">Buy</button> <button class="btn small sell" data-act="exit-holding" data-sym="${C.esc(h.symbol)}">Exit</button></td></tr>`;
  }).join('');
  const total = totVal - totInv;
  return `<div class="card pt-card"><div class="table-wrap"><table class="pt-table">
    <thead><tr><th>Instrument</th><th class="r">Qty</th><th class="r">Avg price</th><th class="r">LTP</th><th class="r">Invested</th><th class="r">Current value</th><th class="r">P&amp;L</th><th class="r">Day chg</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="4"><b>Total</b></td><td class="r num"><b>${money(totInv, a.currency)}</b></td><td class="r num"><b>${money(totVal, a.currency)}</b></td><td class="r num ${C.cls(total)}"><b>${pnl(total, a.currency)}</b><div class="small">${pct(totInv ? (total / totInv) * 100 : null)}</div></td><td colspan="2"></td></tr></tfoot>
    </table></div></div>
    <p class="small muted">P&amp;L here is <b>unrealised</b>: (LTP − average price) × quantity. It only becomes real when you sell. LTP = last traded price.</p>`;
}

function positionsHtml(a, quotes) {
  if (!a.positions.length) {
    return empty('No open positions', '<b>Positions</b> are Intraday trades. Intraday uses margin (a fraction of the value) and you can even sell first. Real brokers close them before the market ends.',
      '<div class="chips"><button class="btn primary" data-act="open-new">+ New order</button></div>');
  }
  const rows = a.positions.map((p) => {
    const q = quotes[p.symbol];
    const ltp = q?.price;
    const pl = C.isNum(ltp) ? (ltp - p.avg) * p.qty : null;
    return `<tr data-sym="${C.esc(p.symbol)}">
      <td><b>${C.esc(short(p.symbol))}</b><div class="small muted">${C.esc(p.name)}</div></td>
      <td><span class="pill neutral">Intraday</span></td>
      <td class="r num">${p.qty > 0 ? '+' : ''}${p.qty} <span class="pill ${p.qty > 0 ? 'bull' : 'bear'}">${p.qty > 0 ? 'Long' : 'Short'}</span></td>
      <td class="r num">${money(p.avg, a.currency)}</td><td class="r num">${ltpCell(q, a.currency)}</td>
      <td class="r num ${C.cls(pl)}"><b>${pnl(pl, a.currency)}</b></td><td class="r num">${money(p.margin, a.currency)}</td>
      <td class="r pt-row-actions"><button class="btn small" data-act="add-position" data-sym="${C.esc(p.symbol)}">Add</button> <button class="btn small sell" data-act="exit-position" data-sym="${C.esc(p.symbol)}">Exit</button></td></tr>`;
  }).join('');
  const tot = a.positions.reduce((s, p) => s + (C.isNum(quotes[p.symbol]?.price) ? (quotes[p.symbol].price - p.avg) * p.qty : 0), 0);
  return `<div class="card pt-card"><div class="table-wrap"><table class="pt-table">
    <thead><tr><th>Instrument</th><th>Product</th><th class="r">Qty</th><th class="r">Avg price</th><th class="r">LTP</th><th class="r">P&amp;L</th><th class="r">Margin used</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="5"><b>Total</b></td><td class="r num ${C.cls(tot)}"><b>${pnl(tot, a.currency)}</b></td><td colspan="2"></td></tr></tfoot></table></div></div>
    <p class="small muted">Intraday positions left open overnight are closed automatically the next time prices load. In real trading, do it yourself before the close.</p>`;
}

const STATUS = {
  OPEN: ['neutral', 'Open'], WAITING: ['warn', 'Waiting for entry'], COMPLETE: ['bull', 'Executed'],
  CANCELLED: ['neutral', 'Cancelled'], REJECTED: ['bear', 'Rejected'],
};
const TYPE = { MARKET: 'Market', LIMIT: 'Limit', SLM: 'SL-M' };

function ordersHtml(a) {
  if (!a.orders.length) {
    return empty('No orders yet', 'Every order you place — executed, waiting or cancelled — is listed here, just like the Orders tab of a broker app.',
      '<div class="chips"><button class="btn primary" data-act="open-new">+ New order</button></div>');
  }
  const rows = a.orders.slice(0, 100).map((o) => {
    const [cl, label] = STATUS[o.status] || ['neutral', o.status];
    const price = o.type === 'LIMIT' ? money(o.price, a.currency) : o.type === 'SLM' ? `Trigger ${money(o.trigger, a.currency)}` : 'At market';
    const act = o.status === 'OPEN' || o.status === 'WAITING' ? `<button class="btn small" data-act="cancel" data-id="${o.id}">Cancel</button>` : '';
    return `<tr data-sym="${C.esc(o.symbol)}">
      <td class="small">${when(o.filledAt && o.status === 'COMPLETE' ? o.filledAt : o.placedAt)}</td>
      <td><b>${C.esc(short(o.symbol))}</b>${o.tag ? `<div class="small muted">${o.tag === 'stop' ? 'Stop-loss' : 'Target'}</div>` : ''}</td>
      <td><span class="pill ${o.side === 'BUY' ? 'bull' : 'bear'}">${o.side}</span></td>
      <td class="small">${o.product === 'DELIVERY' ? 'Delivery' : 'Intraday'}</td><td class="small">${TYPE[o.type]}</td>
      <td class="r num">${o.qty}</td><td class="r num small">${price}</td>
      <td><span class="pill ${cl}">${label}</span></td>
      <td class="r num">${o.fillPrice != null ? money(o.fillPrice, a.currency) : '—'}${o.charges ? `<div class="small muted">charges ${money(o.charges, a.currency)}</div>` : ''}</td>
      <td class="small muted pt-note">${C.esc(o.note)}</td><td class="r">${act}</td></tr>`;
  }).join('');
  return `<div class="card pt-card"><div class="table-wrap"><table class="pt-table">
    <thead><tr><th>Time</th><th>Instrument</th><th>Side</th><th>Product</th><th>Type</th><th class="r">Qty</th><th class="r">Price</th><th>Status</th><th class="r">Fill price</th><th>Note</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>
    <p class="small muted">Pending orders (Limit, stop-loss, target) are checked every few seconds while StockSense is open in your browser. They cannot trigger while it is closed.</p>`;
}

function pnlHtml(a) {
  const st = E.tradeStats(a);
  if (!st.count) {
    return empty('No closed trades yet', 'When you sell something you bought, the trade appears here with its profit or loss after charges — and a plain-English review of how you did.',
      '<div class="chips"><button class="btn primary" data-act="open-new">+ New order</button></div>');
  }
  const cur = a.currency;
  const tile = (k, v, sub = '', c = '') => `<div class="card"><div class="k">${k}</div><div class="v num ${c}">${v}</div><div class="small muted">${sub}</div></div>`;
  const rows = a.trades.slice(0, 50).map((t) => {
    const r = E.rMultiple(t);
    const why = { stop: 'Stop-loss', target: 'Target', manual: 'Manual exit', squareoff: 'Auto square-off' }[t.exitReason] || '';
    return `<tr data-sym="${C.esc(t.symbol)}">
      <td class="small">${when(t.closedAt)}</td><td><b>${C.esc(short(t.symbol))}</b><div class="small muted">${t.product === 'DELIVERY' ? 'Delivery' : 'Intraday'} · ${t.direction === 'LONG' ? 'Long' : 'Short'}</div></td>
      <td class="r num">${t.qty}</td><td class="r num">${money(t.entry, cur)}</td><td class="r num">${money(t.exit, cur)}</td>
      <td class="r num">${pnl(t.gross, cur)}</td><td class="r num muted">−${money(t.charges, cur)}</td>
      <td class="r num ${C.cls(t.net)}"><b>${pnl(t.net, cur)}</b></td><td class="r num">${r == null ? '—' : `${r > 0 ? '+' : '−'}${Math.abs(r)}R`}</td>
      <td class="small">${why}<div class="muted">${duration(t.openedAt, t.closedAt)}</div></td></tr>
      <tr class="pt-review"><td></td><td colspan="9"><ul>${E.reviewTrade(t).map((x) => `<li>${C.esc(x)}</li>`).join('')}</ul></td></tr>`;
  }).join('');
  return `<div class="grid cols-4 pt-tiles">
      ${tile('Net P&amp;L', pnl(st.net, cur), `${st.count} closed trade${st.count === 1 ? '' : 's'}`, C.cls(st.net))}
      ${tile('Win rate', st.winRate == null ? '—' : `${st.winRate.toFixed(0)}%`, `${st.wins} won · ${st.losses} lost`)}
      ${tile('Avg win / avg loss', `${st.avgWin == null ? '—' : pnl(st.avgWin, cur)} / ${st.avgLoss == null ? '—' : pnl(st.avgLoss, cur)}`, st.profitFactor == null ? 'Profit factor: —' : `Profit factor ${st.profitFactor}`)}
      ${tile('Charges paid', money(st.charges, cur), 'Brokerage, taxes and fees', 'down')}
    </div>
    <div class="card pt-card section"><div class="table-wrap"><table class="pt-table pt-trades">
    <thead><tr><th>Closed</th><th>Instrument</th><th class="r">Qty</th><th class="r">Entry</th><th class="r">Exit</th><th class="r">Gross</th><th class="r">Charges</th><th class="r">Net P&amp;L</th><th class="r">R</th><th>Exit / held</th></tr></thead>
    <tbody>${rows}</tbody></table></div></div>
    <p class="small muted"><b>R</b> measures a trade in units of the money you planned to risk (entry − stop-loss). +2R means you earned twice what you risked. Winning traders usually lose often but win bigger than they lose.</p>`;
}

function popularChips(a) {
  const list = (C.popular[a.market] || []).filter((s) => !s.startsWith('^')).slice(0, 6);
  return list.map((s) => `<button class="btn" data-act="new" data-sym="${C.esc(s)}" data-name="${C.esc(short(s))}">${C.esc(short(s))}</button>`).join('');
}

// ---------- learn ----------
function learnHtml(a) {
  const has = (f) => a.orders.some(f);
  const steps = [
    { t: 'Place your first Buy order', done: has((o) => o.side === 'BUY' && o.status === 'COMPLETE'),
      b: 'Pick a stock on <a href="#/analyze">Analyse</a> (look for a <b>Buy</b> signal), then press <b>+ New order</b>. Choose <b>Delivery</b>, order type <b>Market</b> and a small quantity. Use “Suggest a quantity” to learn how many shares fit your risk.', lesson: 'how-to-buy-sell' },
    { t: 'Protect it with a stop-loss', done: has((o) => o.tag === 'stop'),
      b: 'Tick <b>Stop-loss</b> in the order window. It places an <b>SL-M</b> sell order that fires if the price falls to your trigger, so one bad trade cannot hurt you badly.', lesson: 'stoploss' },
    { t: 'Set a target', done: has((o) => o.tag === 'target'),
      b: 'Tick <b>Target</b> as well. It sells automatically when the price reaches your profit goal. The stop-loss and target cancel each other (called OCO) — whichever comes first wins.', lesson: 'exit-targets' },
    { t: 'Watch your profit and loss move', done: a.holdings.length > 0 || a.positions.length > 0 || a.trades.length > 0,
      b: 'Open <a href="#/paper/holdings">Holdings</a>. <b>P&amp;L = (LTP − average price) × quantity.</b> It is “on paper” (unrealised) until you sell. Notice how it changes with every price tick.' },
    { t: 'Exit and book the result', done: a.trades.length > 0,
      b: 'Press <b>Exit</b> on a holding (or let your stop-loss / target do it). The trade is now closed and the profit or loss is <b>realised</b> — after brokerage, taxes and fees.' },
    { t: 'Read your trade review', done: a.trades.length > 0,
      b: 'Open the <a href="#/paper/pnl">P&amp;L report</a>. Each closed trade gets feedback: did you use a stop-loss, how many R did you make, did charges eat your gain?', lesson: 'risk-management' },
    { t: 'Try Intraday (optional)', done: has((o) => o.product === 'INTRADAY' && o.status === 'COMPLETE'),
      b: 'Choose <b>Intraday</b> in the order window. You only block 1/5 of the value as margin (so gains <i>and</i> losses are 5× bigger), and you can sell first. Exit before the market closes.', lesson: 'advanced-topics' },
    { t: 'Do 10 trades before judging yourself', done: a.trades.length >= 10,
      b: 'One trade proves nothing. Aim for 10+ trades following the same rules, then check your win rate and average win vs average loss.', lesson: 'psychology' },
  ];
  const done = steps.filter((s) => s.done).length;
  const card = (s, i) => `<div class="pt-step ${s.done ? 'done' : ''}">
      <div class="n">${s.done ? '✓' : i + 1}</div>
      <div><div class="t">${s.t}</div><div class="small">${s.b}</div>
      ${s.lesson ? `<a class="small" href="#/academy/${s.lesson}">Read the Academy class →</a>` : ''}</div></div>`;
  const map = [
    ['Orders', 'Orders tab', 'Every order and its status: Open, Executed, Cancelled, Rejected.'],
    ['Positions', 'Positions tab', 'Intraday trades (margin product) that are open today.'],
    ['Holdings', 'Holdings tab', 'Delivery shares you own: quantity, average price, LTP, P&amp;L.'],
    ['Funds', 'The four boxes at the top', 'Available funds, margin blocked, portfolio value, P&amp;L.'],
    ['Buy / Sell window', '+ New order', 'Buy/Sell toggle, Delivery or Intraday, Market / Limit / SL-M, quantity, price, trigger, margin and charges.'],
  ];
  return `<div class="card">
      <div class="section-head"><h3>Your first paper trade, step by step</h3><span class="pill ${done === steps.length ? 'bull' : 'neutral'}">${done} of ${steps.length} done</span></div>
      <div class="ac-progress"><span style="width:${(done / steps.length) * 100}%"></span></div>
      <div class="pt-steps">${steps.map(card).join('')}</div>
      <div class="chips" style="justify-content:flex-start;margin-top:14px"><button class="btn primary" data-act="open-new">+ New order</button>${popularChips(a)}</div>
    </div>
    <div class="grid cols-2 section">
      <div class="card"><h3>Same layout as a broker app</h3>
        <p class="small muted" style="margin:0 0 8px">If you have a broker account such as Upstox, these screens work the same way, so the habits carry over:</p>
        <table class="pt-map"><thead><tr><th>Broker app</th><th>Here</th></tr></thead><tbody>
        ${map.map(([x, y, z]) => `<tr><td><b>${x}</b></td><td>${y}<div class="small muted">${z}</div></td></tr>`).join('')}</tbody></table>
        <p class="small muted" style="margin:10px 0 0">StockSense is an independent practice tool and is not connected to, or endorsed by, any broker.</p></div>
      <div class="card"><h3>Order words explained</h3><dl class="pt-dl">
        <dt>Delivery</dt><dd>You pay the full amount and the shares are yours until you sell. Normal investing and swing trading.</dd>
        <dt>Intraday</dt><dd>Margin product: you block only a fraction (here ${E.LEVERAGE[a.market]}× leverage) and must close the same day. Faster profit — and faster loss.</dd>
        <dt>Market order</dt><dd>Buy or sell right now at the current price.</dd>
        <dt>Limit order</dt><dd>Buy at your price or lower / sell at your price or higher. Waits until the market reaches it.</dd>
        <dt>SL-M (stop-loss market)</dt><dd>Sleeps until the price touches your <b>trigger</b>, then sells at market. A sell stop sits <i>below</i> the price.</dd>
        <dt>LTP</dt><dd>Last traded price — the latest price a trade happened at.</dd>
        <dt>Paper vs real</dt><dd>Real orders can fill at a slightly different price (slippage), partly, or be rejected. Real money also makes you nervous — paper does not. Treat practice trades seriously.</dd></dl></div>
    </div>`;
}

// =====================================================================
// Order window
// =====================================================================
export function openOrder(opts = {}) {
  closeOrder();
  const m = {
    symbol: opts.symbol ? String(opts.symbol).toUpperCase() : '',
    name: opts.name || '', side: opts.side === 'SELL' ? 'SELL' : 'BUY',
    product: opts.product === 'INTRADAY' ? 'INTRADAY' : 'DELIVERY', type: 'MARKET',
    qty: Number.isInteger(opts.qty) && opts.qty > 0 ? opts.qty : 1,
    quote: null, plan: null, verdict: null, loadError: null, touched: {}, opener: document.activeElement,
    timer: null, ctrl: new AbortController(),
  };
  modal = m;
  const root = document.createElement('div');
  root.className = 'pt-backdrop';
  root.innerHTML = '<div class="pt-modal" role="dialog" aria-modal="true" aria-labelledby="ptmTitle" tabindex="-1"></div>';
  document.body.appendChild(root);
  m.root = root;
  m.box = $('.pt-modal', root);
  root.addEventListener('mousedown', (e) => { if (e.target === root) closeOrder(); });
  m.onKey = (e) => { if (e.key === 'Escape') closeOrder(); };
  document.addEventListener('keydown', m.onKey);
  if (m.symbol) loadSymbol(m); else renderPicker(m);
}

export function closeOrder() {
  if (!modal) return;
  const m = modal;
  modal = null;
  clearInterval(m.timer);
  m.ctrl.abort();
  document.removeEventListener('keydown', m.onKey);
  m.root.remove();
  try { m.opener?.focus?.(); } catch { /* element may be gone */ }
  if (shown?.alive()) paint();
}

function renderPicker(m) {
  m.box.innerHTML = `<div class="pt-m-head"><h2 id="ptmTitle">New order — choose a stock</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="pt-m-body">
      <label class="pt-f">Search a company or symbol<input id="ptmSearch" type="search" autocomplete="off" spellcheck="false" placeholder="e.g. Reliance, TCS, Apple"></label>
      <ul class="pt-results" id="ptmResults" role="listbox"></ul>
      <p class="small muted">Tip: for Indian shares the symbol ends with .NS (NSE) or .BO (BSE).</p>
    </div>`;
  $('[data-close]', m.box).addEventListener('click', closeOrder);
  const input = $('#ptmSearch', m.box);
  const list = $('#ptmResults', m.box);
  input.focus();
  let timer, ctrl, last = '';
  const show = (items, msg) => {
    list.innerHTML = msg ? `<li class="muted">${C.esc(msg)}</li>` : items.map((r, i) => `<li role="option" data-i="${i}"><span><b>${C.esc(r.symbol)}</b> <span class="muted">${C.esc(r.name)}</span></span><span class="small muted">${C.esc(r.exchange)}</span></li>`).join('');
    list._items = items;
  };
  const pick = (r) => {
    m.symbol = r.symbol;
    m.name = r.name;
    loadSymbol(m);
  };
  const run = async (q) => {
    ctrl?.abort();
    ctrl = new AbortController();
    last = q;
    try {
      const data = await C.api(`/api/search?q=${C.enc(q)}`, { signal: ctrl.signal, timeout: 15000 });
      if (q !== last || !modal) return;
      const items = data.quotes.filter((r) => r.type !== 'INDEX' && !r.symbol.startsWith('^'));
      const mine = (r) => (C.state.market === 'IN' ? /\.(NS|BO)$/.test(r.symbol) : !r.symbol.includes('.'));
      const sorted = [...items.filter(mine), ...items.filter((r) => !mine(r))];
      show(sorted, sorted.length ? '' : 'No matches.');
    } catch (e) {
      if (e.name !== 'AbortError') show([], e.message);
    }
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) return show([], '');
    timer = setTimeout(() => run(q), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && list._items?.length) { e.preventDefault(); pick(list._items[0]); }
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) pick(list._items[Number(li.dataset.i)]);
  });
}

async function loadSymbol(m) {
  m.box.innerHTML = `<div class="pt-m-head"><h2 id="ptmTitle">${C.esc(short(m.symbol))}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div><div class="pt-m-body">${C.loading('Loading price…')}</div>`;
  $('[data-close]', m.box).addEventListener('click', closeOrder);
  try {
    const [qs, sm] = await Promise.all([
      fetchQuotes([m.symbol], m.ctrl.signal),
      C.api(`/api/summary?symbols=${C.enc(m.symbol)}`, { signal: m.ctrl.signal, timeout: 45000 }).catch(() => null),
    ]);
    if (modal !== m) return;
    const q = qs.quotes[m.symbol];
    if (!q) throw new Error(qs.failed?.[0]?.error || 'Price not available for this symbol.');
    m.quote = q;
    m.name = q.name || m.name;
    const s = sm?.items?.[0];
    m.plan = s?.plan || null;
    m.verdict = s?.verdict || null;
    m.score = s?.score;
    const acct = loadAcct(E.marketOfSymbol(m.symbol));
    m.acct = acct;
    if (q.currency !== acct.currency) {
      m.loadError = `${m.symbol} trades in ${q.currency}. Paper trading supports Indian shares (₹, NSE/BSE) and US shares ($).`;
    }
    setDefaults(m);
    render(m);
    m.timer = setInterval(() => pollQuote(m), 8000);
  } catch (e) {
    if (e.name === 'AbortError' || modal !== m) return;
    m.loadError = e.message;
    m.box.innerHTML = `<div class="pt-m-head"><h2 id="ptmTitle">${C.esc(short(m.symbol))}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
      <div class="pt-m-body">${C.errorBox(e.message, 'ptmRetry')}<div class="pt-m-foot"><button class="btn" id="ptmBack">Choose another stock</button></div></div>`;
    $('[data-close]', m.box).addEventListener('click', closeOrder);
    $('#ptmRetry', m.box)?.addEventListener('click', () => loadSymbol(m));
    $('#ptmBack', m.box).addEventListener('click', () => { m.symbol = ''; renderPicker(m); });
  }
}

async function pollQuote(m) {
  if (modal !== m || document.hidden || !m.quote) return;
  try {
    const d = await fetchQuotes([m.symbol], m.ctrl.signal);
    if (modal !== m || !d.quotes[m.symbol]) return;
    m.quote = d.quotes[m.symbol];
    updateLtp(m);
    refresh(m);
  } catch { /* keep the last price */ }
}

// Suggested stop-loss / target: from the analysis plan when it makes sense, else a simple % example.
function setDefaults(m) {
  const ltp = m.quote.price;
  const buy = m.side === 'BUY';
  const r = (v) => Math.round(v * 100) / 100;
  const p = m.plan;
  // The analysis levels only fit a live Buy plan; a "wait for a better entry" plan is built around a lower price.
  const usable = p && p.action === 'buy';
  const goodStop = usable && C.isNum(p.stopLoss) && (buy ? p.stopLoss < ltp : p.stopLoss > ltp);
  const goodTarget = usable && C.isNum(p.target1) && (buy ? p.target1 > ltp : p.target1 < ltp);
  if (!m.touched.stop) {
    m.stop = r(goodStop && buy ? p.stopLoss : ltp * (buy ? 0.97 : 1.03));
    m.stopSource = goodStop && buy ? 'analysis' : 'example';
  }
  if (!m.touched.target) {
    m.target = r(goodTarget && buy ? p.target1 : ltp * (buy ? 1.06 : 0.94));
    m.targetSource = goodTarget && buy ? 'analysis' : 'example';
  }
  if (!('stopOn' in m.touched)) m.stopOn = true;
  if (!('targetOn' in m.touched)) m.targetOn = Boolean(goodTarget && buy);
  if (!m.touched.price) m.price = r(ltp);
  if (!m.touched.trigger) m.trigger = r(ltp * (buy ? 1.02 : 0.98));
}

function render(m) {
  const a = m.acct;
  const q = m.quote;
  const cur = a.currency;
  const holding = a.holdings.find((h) => h.symbol === m.symbol);
  const pos = a.positions.find((p) => p.symbol === m.symbol);
  const v = m.verdict ? `<span class="pill ${C.verdictClass(m.verdict.key)}">${C.esc(m.verdict.label)}</span>` : '';
  m.box.className = `pt-modal ${m.side === 'BUY' ? 'is-buy' : 'is-sell'}`;
  m.box.innerHTML = `
    <div class="pt-m-head">
      <div><h2 id="ptmTitle">${C.esc(short(m.symbol))} <span class="small muted">${C.esc(m.name)}</span></h2>
        <div class="small muted">${q.marketState === 'open' ? '<span class="pill open">● Market open</span>' : '<span class="pill closed">Market closed</span>'} ${v}</div></div>
      <div class="pt-ltp"><div class="num" id="ptmLtp">${money(q.price, cur)}</div><div class="small num ${C.cls(q.changePct)}" id="ptmChg">${pct(q.changePct)} today</div></div>
      <button class="icon-btn" data-close aria-label="Close">✕</button>
    </div>
    <div class="pt-m-body">
      ${m.loadError ? `<div class="pt-err" role="alert">${C.esc(m.loadError)}</div>` : ''}
      <div class="pt-side" role="group" aria-label="Buy or sell">
        <button type="button" data-side="BUY" class="${m.side === 'BUY' ? 'on buy' : ''}">Buy</button>
        <button type="button" data-side="SELL" class="${m.side === 'SELL' ? 'on sell' : ''}">Sell</button>
      </div>
      <div class="small muted pt-have" id="ptmHave">${holding ? `You hold <b>${holding.qty}</b> share${holding.qty === 1 ? '' : 's'} (Delivery) at avg ${money(holding.avg, cur)}. ` : ''}${pos ? `Open Intraday position: <b>${pos.qty > 0 ? '+' : ''}${pos.qty}</b>.` : ''}</div>

      <fieldset class="pt-f pt-radio"><legend>Product <span class="pt-info" title="Delivery: pay in full, keep the shares. Intraday: pay only a margin, must close the same day.">ⓘ</span></legend>
        <label><input type="radio" name="ptmProd" value="DELIVERY" ${m.product === 'DELIVERY' ? 'checked' : ''}> Delivery</label>
        <label><input type="radio" name="ptmProd" value="INTRADAY" ${m.product === 'INTRADAY' ? 'checked' : ''}> Intraday <span class="muted small">(${E.LEVERAGE[a.market]}× margin)</span></label>
      </fieldset>

      <div class="pt-row2">
        <label class="pt-f">Quantity<span class="pt-qty"><button type="button" id="ptmMinus" aria-label="Decrease">−</button><input id="ptmQty" type="number" min="1" step="1" inputmode="numeric" value="${m.qty}"><button type="button" id="ptmPlus" aria-label="Increase">+</button></span></label>
        <label class="pt-f">Order type<select id="ptmType"><option value="MARKET" ${m.type === 'MARKET' ? 'selected' : ''}>Market</option><option value="LIMIT" ${m.type === 'LIMIT' ? 'selected' : ''}>Limit</option><option value="SLM" ${m.type === 'SLM' ? 'selected' : ''}>SL-M (stop-loss)</option></select></label>
      </div>
      <div class="pt-row2">
        <label class="pt-f">Price<input id="ptmPrice" type="number" min="0" step="0.05" inputmode="decimal" ${m.type === 'LIMIT' ? '' : 'disabled'} value="${m.type === 'LIMIT' ? m.price : ''}" placeholder="${m.type === 'LIMIT' ? '' : 'At market'}"></label>
        <label class="pt-f">Trigger price<input id="ptmTrig" type="number" min="0" step="0.05" inputmode="decimal" ${m.type === 'SLM' ? '' : 'disabled'} value="${m.type === 'SLM' ? m.trigger : ''}" placeholder="${m.type === 'SLM' ? '' : '—'}"></label>
      </div>
      <div class="small"><a href="#" id="ptmSuggest">Suggest a quantity (risk ${C.esc(C.state.riskPct)}% of my funds)</a> <span class="muted" id="ptmSuggestOut"></span></div>

      <div class="pt-bracket" id="ptmBracket"></div>
      <div class="pt-summary" id="ptmSummary" aria-live="polite"></div>
      <div class="pt-tip small" id="ptmTip"></div>
      <div class="pt-err" id="ptmErr" role="alert" hidden></div>
    </div>
    <div class="pt-m-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn pt-submit" id="ptmSubmit"></button>
    </div>`;
  bindModal(m);
  refresh(m);
  $('#ptmQty', m.box).focus();
}

function bindModal(m) {
  const box = m.box;
  $$('[data-close]', box).forEach((b) => b.addEventListener('click', closeOrder));
  $$('[data-side]', box).forEach((b) => b.addEventListener('click', () => {
    m.side = b.dataset.side;
    if (!m.touched.stop) m.stop = null;
    if (!m.touched.target) m.target = null;
    if (!m.touched.trigger) delete m.touched.trigger;
    setDefaults(m);
    render(m);
  }));
  $$('input[name=ptmProd]', box).forEach((r) => r.addEventListener('change', () => { m.product = r.value; refresh(m); }));
  $('#ptmQty', box).addEventListener('input', () => { m.qty = Math.floor(num('#ptmQty', box)); refresh(m); });
  $('#ptmMinus', box).addEventListener('click', () => { m.qty = Math.max(1, (m.qty || 1) - 1); $('#ptmQty', box).value = m.qty; refresh(m); });
  $('#ptmPlus', box).addEventListener('click', () => { m.qty = (m.qty || 0) + 1; $('#ptmQty', box).value = m.qty; refresh(m); });
  $('#ptmType', box).addEventListener('change', (e) => {
    m.type = e.target.value;
    const p = $('#ptmPrice', box), t = $('#ptmTrig', box);
    p.disabled = m.type !== 'LIMIT';
    t.disabled = m.type !== 'SLM';
    p.value = m.type === 'LIMIT' ? m.price : '';
    p.placeholder = m.type === 'LIMIT' ? '' : 'At market';
    t.value = m.type === 'SLM' ? m.trigger : '';
    t.placeholder = m.type === 'SLM' ? '' : '—';
    refresh(m);
  });
  $('#ptmPrice', box).addEventListener('input', () => { m.price = num('#ptmPrice', box); m.touched.price = true; refresh(m); });
  $('#ptmTrig', box).addEventListener('input', () => { m.trigger = num('#ptmTrig', box); m.touched.trigger = true; refresh(m); });
  $('#ptmSuggest', box).addEventListener('click', (e) => { e.preventDefault(); suggestQty(m); });
  $('#ptmSubmit', box).addEventListener('click', () => submit(m));
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'radio') { e.preventDefault(); submit(m); }
  });
}

function updateLtp(m) {
  const q = m.quote;
  const el = $('#ptmLtp', m.box);
  if (!el) return;
  const old = Number(el.dataset.v);
  el.textContent = money(q.price, m.acct.currency);
  el.dataset.v = q.price;
  if (C.isNum(old) && old !== q.price) {
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth;
    el.classList.add(q.price > old ? 'flash-up' : 'flash-down');
  }
  const ch = $('#ptmChg', m.box);
  if (ch) { ch.className = `small num ${C.cls(q.changePct)}`; ch.textContent = `${pct(q.changePct)} today`; }
}

function readReq(m) {
  const box = m.box;
  const req = {
    symbol: m.symbol, name: m.name, side: m.side, product: m.product, type: m.type,
    qty: Number.isInteger(m.qty) ? m.qty : NaN,
    price: m.type === 'LIMIT' ? num('#ptmPrice', box) : null,
    trigger: m.type === 'SLM' ? num('#ptmTrig', box) : null,
  };
  if (m.bracketShown) {
    if ($('#ptmStopOn', box)?.checked) req.stop = num('#ptmStop', box);
    if ($('#ptmTargetOn', box)?.checked) req.target = num('#ptmTarget', box);
  }
  return req;
}

// Recalculates everything that depends on the form: bracket box, cost, charges, tips, errors.
function refresh(m) {
  if (modal !== m || !m.box || !m.quote) return;
  const box = m.box;
  const a = loadAcct(m.acct.market);
  m.acct = a;
  const cur = a.currency;
  const ltp = m.quote.price;
  const qty = Number.isInteger(m.qty) && m.qty > 0 ? m.qty : 0;
  const refPrice = m.type === 'LIMIT' && C.isNum(num('#ptmPrice', box)) ? num('#ptmPrice', box) : ltp;
  const est = E.estimate(a, { side: m.side, product: m.product, qty, price: refPrice, symbol: m.symbol });
  const canBracket = qty > 0 && (m.product === 'DELIVERY' ? m.side === 'BUY' : est.opening === qty);
  const buy = m.side === 'BUY';

  // Stop-loss / target box (kept in place if it is already drawn, so typing is not interrupted).
  const br = $('#ptmBracket', box);
  if (canBracket !== m.bracketShown || !br.innerHTML) {
    m.bracketShown = canBracket;
    br.innerHTML = canBracket ? `
      <div class="pt-brk-title">Protect this trade <span class="pt-info" title="These orders wait until your entry fills. When one executes, the other is cancelled automatically.">ⓘ</span></div>
      <div class="pt-row2">
        <label class="pt-f"><span><input type="checkbox" id="ptmStopOn" ${m.stopOn ? 'checked' : ''}> Stop-loss trigger</span><input id="ptmStop" type="number" min="0" step="0.05" inputmode="decimal" value="${m.stop ?? ''}"></label>
        <label class="pt-f"><span><input type="checkbox" id="ptmTargetOn" ${m.targetOn ? 'checked' : ''}> Target price</span><input id="ptmTarget" type="number" min="0" step="0.05" inputmode="decimal" value="${m.target ?? ''}"></label>
      </div>
      <div class="small muted" id="ptmBrkNote"></div>` : '<div class="small muted">Stop-loss and target can be added when an order opens a new position.</div>';
    if (canBracket) {
      $('#ptmStopOn', box).addEventListener('change', (e) => { m.stopOn = e.target.checked; m.touched.stopOn = true; refresh(m); });
      $('#ptmTargetOn', box).addEventListener('change', (e) => { m.targetOn = e.target.checked; m.touched.targetOn = true; refresh(m); });
      $('#ptmStop', box).addEventListener('input', () => { m.stop = num('#ptmStop', box); m.touched.stop = true; refresh(m); });
      $('#ptmTarget', box).addEventListener('input', () => { m.target = num('#ptmTarget', box); m.touched.target = true; refresh(m); });
    }
  }
  if (canBracket) {
    const stop = $('#ptmStopOn', box).checked ? num('#ptmStop', box) : NaN;
    const target = $('#ptmTargetOn', box).checked ? num('#ptmTarget', box) : NaN;
    const note = [];
    if (C.isNum(stop)) {
      const loss = Math.abs(refPrice - stop) * qty;
      note.push(`If the stop-loss hits you lose about <b class="down">${money(loss, cur)}</b> (${((loss / a.cash) * 100).toFixed(loss / a.cash < 0.001 ? 2 : 1)}% of your funds)`);
    }
    if (C.isNum(target)) note.push(`at the target you gain about <b class="up">${money(Math.abs(target - refPrice) * qty, cur)}</b>`);
    if (C.isNum(stop) && C.isNum(target) && stop !== refPrice) note.push(`risk : reward = 1 : ${(Math.abs(target - refPrice) / Math.abs(refPrice - stop)).toFixed(1)}`);
    const src = m.stopSource === 'analysis' && !m.touched.stop ? ' (levels suggested by the StockSense analysis)' : !m.touched.stop ? ' (example levels — place yours where the trade idea is proven wrong)' : '';
    $('#ptmBrkNote', box).innerHTML = (note.length ? `${note.join(' · ')}.` : 'Tick a box to add it. A stop-loss is strongly recommended.') + src;
  }

  // Cost box
  const label = est.opening === 0 ? 'Funds needed' : m.product === 'DELIVERY' ? 'Amount required' : 'Margin required';
  $('#ptmSummary', box).innerHTML = `
    <div><span>${label}</span><b class="num">${est.required > 0 ? money(est.required, cur) : 'None (closing)'}</b></div>
    <div><span>Available funds</span><b class="num">${money(a.cash, cur)}</b></div>
    <div><span>Order value</span><b class="num">${money(est.value, cur)}</b></div>
    <div><span title="Brokerage + taxes + exchange fees (approximate)">Charges (approx.)</span><b class="num">${money(est.charges, cur)}</b></div>`;

  // Teaching tip
  const tips = [];
  if (m.type === 'MARKET') tips.push(m.quote.marketState === 'closed' ? '<b>Market order</b>: the market is closed, so this fills at the last price. A real broker would queue it as an After-Market Order.' : '<b>Market order</b>: executes immediately at the current price. Fast, but you accept whatever price you get.');
  if (m.type === 'LIMIT') tips.push(`<b>Limit order</b>: ${buy ? 'buys only at your price or lower' : 'sells only at your price or higher'}. If the price is not there yet, the order waits in Orders until it is.`);
  if (m.type === 'SLM') tips.push(`<b>SL-M</b>: waits quietly until the price ${buy ? 'rises to' : 'falls to'} your trigger, then ${buy ? 'buys' : 'sells'} at market. Used to <b>cap a loss</b> ${buy ? 'on a short sale' : 'on a share you own'}. The trigger must be ${buy ? 'above' : 'below'} the current price.`);
  if (m.product === 'INTRADAY') tips.push(`<b>Intraday</b>: you block only 1/${E.LEVERAGE[a.market]} of the value, so profit and loss are ${E.LEVERAGE[a.market]}× bigger. Close it before the market ends.`);
  $('#ptmTip', box).innerHTML = tips.join('<br>');

  // Validation
  const req = readReq(m);
  let err = m.loadError || null;
  if (!err) err = E.checkOrder(a, { ...req, qty: Number.isInteger(req.qty) ? req.qty : 0 }, ltp);
  if (!err && m.bracketShown) {
    const stop = req.stop, target = req.target;
    if (req.stop !== undefined && !(C.isNum(stop) && stop > 0)) err = 'Enter a stop-loss price, or untick it.';
    else if (req.target !== undefined && !(C.isNum(target) && target > 0)) err = 'Enter a target price, or untick it.';
    else if (C.isNum(stop) && (buy ? stop >= refPrice : stop <= refPrice)) err = buy ? 'Your stop-loss must be BELOW your buy price.' : 'Your stop-loss must be ABOVE your sell price.';
    else if (C.isNum(target) && (buy ? target <= refPrice : target >= refPrice)) err = buy ? 'Your target must be ABOVE your buy price.' : 'Your target must be BELOW your sell price.';
  }
  const errEl = $('#ptmErr', box);
  errEl.hidden = !err;
  errEl.textContent = err || '';
  m.error = err;

  const submit = $('#ptmSubmit', box);
  submit.textContent = `${buy ? 'Buy' : 'Sell'} ${qty > 0 ? qty : ''} ${short(m.symbol)}`.replace(/\s+/g, ' ');
  submit.className = `btn pt-submit ${buy ? 'buy' : 'sell'}`;
  submit.disabled = Boolean(err);
}

function suggestQty(m) {
  const a = loadAcct(m.acct.market);
  const out = $('#ptmSuggestOut', m.box);
  const ltp = m.quote.price;
  const entry = m.type === 'LIMIT' && C.isNum(num('#ptmPrice', m.box)) ? num('#ptmPrice', m.box) : ltp;
  const stop = m.bracketShown && $('#ptmStopOn', m.box)?.checked ? num('#ptmStop', m.box) : (m.stop ?? NaN);
  if (!C.isNum(stop) || stop <= 0 || stop === entry) { out.textContent = '— enter a stop-loss first (the risk per share comes from it).'; return; }
  const riskPct = C.isNum(C.state.riskPct) ? C.state.riskPct : 1;
  const budget = (a.cash * riskPct) / 100;
  const perShare = Math.abs(entry - stop);
  const lev = m.product === 'INTRADAY' ? E.LEVERAGE[a.market] : 1;
  const qty = Math.max(0, Math.min(Math.floor(budget / perShare), Math.floor((a.cash * lev) / entry)));
  if (qty < 1) { out.textContent = '— your risk budget is smaller than the risk on one share.'; return; }
  m.qty = qty;
  $('#ptmQty', m.box).value = qty;
  out.textContent = `→ ${qty} shares: if the stop-loss hits you lose about ${money(qty * perShare, a.currency)} (${riskPct}% of funds).`;
  refresh(m);
}

function submit(m) {
  if (modal !== m || m.error) return;
  const acct = loadAcct(m.acct.market);
  const req = readReq(m);
  const res = E.placeOrder(acct, req, { price: m.quote.price, marketState: m.quote.marketState }, Date.now());
  if (!res.ok) {
    m.error = res.error;
    const el = $('#ptmErr', m.box);
    el.hidden = false;
    el.textContent = res.error;
    return;
  }
  saveAcct(acct);
  const o = res.order;
  if (o.status === 'COMPLETE') C.toast(`${o.side} ${o.qty} ${short(o.symbol)} executed @ ${money(o.fillPrice, acct.currency)}${o.charges ? ` · charges ${money(o.charges, acct.currency)}` : ''}`);
  else if (o.status === 'OPEN') C.toast(`Order placed: ${o.side} ${o.qty} ${short(o.symbol)} — waiting for ${o.type === 'LIMIT' ? 'your price' : 'the trigger'}. See Orders.`);
  else C.toast(`Order ${o.status.toLowerCase()}: ${o.note}`);
  closeOrder();
  if (!shown?.alive() || !location.hash.startsWith('#/paper')) return;
  if (shown.market !== acct.market) {
    C.toast(`Order saved in your ${acct.market === 'IN' ? 'India' : 'US'} paper account. Switch the market to see it.`);
    return;
  }
  shown.quotes = cachedQuotes(acct);
  if (currentSub(acct) === 'learn') {
    // Jump from the guide to where the new order lives.
    location.hash = `#/paper/${o.status === 'COMPLETE' ? (o.product === 'INTRADAY' ? 'positions' : 'holdings') : 'orders'}`;
  } else {
    paint();
  }
}

function cachedQuotes(a) {
  return Object.fromEntries(watchedSymbols(a).filter((s) => quoteCache[s]).map((s) => [s, quoteCache[s]]));
}

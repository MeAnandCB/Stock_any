// Paper-trading engine: virtual money, orders, holdings, positions and a trade
// journal. Pure logic (no network, no DOM) so it can be unit-tested and shared
// with the browser. Functions mutate the account object they are given; the UI
// loads it from localStorage, calls these, and saves it again.
//
// Concepts mirror a real broker (Upstox, Zerodha ...):
//   DELIVERY  = you pay the full amount, shares go to your Holdings, keep them as long as you like.
//   INTRADAY  = margin product: you only block a fraction (value / leverage), can sell first (short),
//               and the broker squares it off the same day.
//   MARKET    = fill now at the last price.   LIMIT = fill only at your price or better.
//   SL-M      = stop-loss market: becomes a market order once the trigger price is touched.

export const START_FUNDS = { IN: 1000000, US: 100000 };
export const LEVERAGE = { IN: 5, US: 4 };
export const CURRENCY = { IN: 'INR', US: 'USD' };
export const PRODUCTS = ['DELIVERY', 'INTRADAY'];
export const ORDER_TYPES = ['MARKET', 'LIMIT', 'SLM'];
const MAX_ORDERS = 200;
const MAX_TRADES = 500;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

export function marketOfSymbol(symbol) {
  return /\.(NS|BO)$/i.test(String(symbol || '')) ? 'IN' : 'US';
}

export function newAccount(market, funds, now = Date.now()) {
  const m = market === 'US' ? 'US' : 'IN';
  const start = isNum(funds) && funds > 0 ? round2(funds) : START_FUNDS[m];
  return {
    v: 1, market: m, currency: CURRENCY[m],
    startFunds: start, cash: start,
    holdings: [], positions: [], orders: [], trades: [],
    seq: 0, createdAt: now,
  };
}

// Basic shape check for data coming out of localStorage.
export function validAccount(a, market) {
  return Boolean(a) && typeof a === 'object' && a.v === 1 && a.market === market &&
    isNum(a.cash) && isNum(a.startFunds) && a.startFunds > 0 && isNum(a.seq) &&
    ['holdings', 'positions', 'orders', 'trades'].every((k) => Array.isArray(a[k]));
}

// ---------- charges (approximate, for learning) ----------
// India follows the usual discount-broker structure: flat brokerage, STT,
// exchange fee, SEBI fee, stamp duty and 18% GST on (brokerage + fees).
// US is treated as commission-free.
export function chargesFor({ market, product, side, qty, price }) {
  const turnover = qty * price;
  const zero = { brokerage: 0, stt: 0, exchange: 0, gst: 0, sebi: 0, stamp: 0, total: 0, turnover: round2(turnover) };
  if (!isNum(turnover) || turnover <= 0 || market !== 'IN') return zero;
  const intraday = product === 'INTRADAY';
  const brokerage = round2(Math.min(20, turnover * 0.025));
  const stt = round2(intraday ? (side === 'SELL' ? turnover * 0.00025 : 0) : turnover * 0.001);
  const exchange = round2(turnover * 0.0000297);
  const sebi = round2(turnover * 0.000001);
  const stamp = round2(side === 'BUY' ? turnover * (intraday ? 0.00003 : 0.00015) : 0);
  const gst = round2((brokerage + exchange + sebi) * 0.18);
  const total = round2(brokerage + stt + exchange + sebi + stamp + gst);
  return { brokerage, stt, exchange, gst, sebi, stamp, total, turnover: round2(turnover) };
}

// ---------- lookups ----------
const holdingOf = (a, symbol) => a.holdings.find((h) => h.symbol === symbol);
const positionOf = (a, symbol) => a.positions.find((p) => p.symbol === symbol);
export const openOrders = (a) => a.orders.filter((o) => o.status === 'OPEN' || o.status === 'WAITING');

// How many shares a SELL (delivery) or a closing order could still act on.
export function sellableQty(a, symbol, product) {
  if (product === 'DELIVERY') return holdingOf(a, symbol)?.qty ?? 0;
  return Math.max(0, positionOf(a, symbol)?.qty ?? 0);
}
export function coverableQty(a, symbol) {
  return Math.max(0, -(positionOf(a, symbol)?.qty ?? 0));
}

// Money a new order needs. `closing` = shares of this order that only reduce an existing position.
export function estimate(a, { side, product, qty, price, symbol }) {
  const value = round2(qty * price);
  const charges = chargesFor({ market: a.market, product, side, qty, price }).total;
  let opening = qty;
  if (product === 'INTRADAY') {
    const pos = positionOf(a, symbol)?.qty ?? 0;
    if (side === 'BUY' && pos < 0) opening = Math.max(0, qty + pos);
    if (side === 'SELL' && pos > 0) opening = Math.max(0, qty - pos);
  } else if (side === 'SELL') {
    opening = 0;
  }
  const required = product === 'DELIVERY'
    ? (side === 'BUY' ? value : 0)
    : round2((opening * price) / LEVERAGE[a.market]);
  return { value, charges, required, opening };
}

// ---------- validation ----------
// Returns an error message or null. `ltp` is the last traded price.
export function checkOrder(a, req, ltp) {
  const { symbol, side, product, type, qty, price, trigger } = req;
  if (!symbol || String(symbol).startsWith('^')) return 'Indexes cannot be traded — pick a company share.';
  if (marketOfSymbol(symbol) !== a.market) return 'This share belongs to the other market account.';
  if (side !== 'BUY' && side !== 'SELL') return 'Choose Buy or Sell.';
  if (!PRODUCTS.includes(product)) return 'Choose Delivery or Intraday.';
  if (!ORDER_TYPES.includes(type)) return 'Choose an order type.';
  if (!Number.isInteger(qty) || qty < 1) return 'Quantity must be a whole number of at least 1.';
  if (!isNum(ltp) || ltp <= 0) return 'No live price is available for this stock right now.';
  if (type === 'LIMIT' && !(isNum(price) && price > 0)) return 'Enter a limit price greater than zero.';
  if (type === 'SLM') {
    if (!(isNum(trigger) && trigger > 0)) return 'Enter a trigger price greater than zero.';
    if (side === 'SELL' && trigger >= ltp) return `A sell stop-loss trigger must be BELOW the current price (${ltp}). A trigger at or above it would fire immediately.`;
    if (side === 'BUY' && trigger <= ltp) return `A buy stop trigger must be ABOVE the current price (${ltp}).`;
  }
  if (product === 'DELIVERY' && side === 'SELL') {
    const have = sellableQty(a, symbol, 'DELIVERY');
    if (have < 1) return 'You do not own this share in Holdings, so you cannot sell it in Delivery. (Selling first is only allowed in Intraday.)';
    if (qty > have) return `You only hold ${have} share${have === 1 ? '' : 's'} of this stock.`;
  }
  const refPrice = type === 'LIMIT' ? price : type === 'SLM' ? trigger : ltp;
  const est = estimate(a, { side, product, qty, price: Math.max(refPrice, ltp), symbol });
  if (est.required > 0 && est.required + est.charges > a.cash + 1e-9) {
    return `Not enough virtual funds: this order needs about ${round2(est.required + est.charges)} but you have ${round2(a.cash)} available.`;
  }
  return null;
}

// ---------- order placement ----------
function nextId(a) {
  a.seq += 1;
  return a.seq;
}

function pushOrder(a, order) {
  a.orders.unshift(order);
  if (a.orders.length > MAX_ORDERS) {
    // Drop the oldest finished orders first; never drop live ones.
    for (let i = a.orders.length - 1; i >= 0 && a.orders.length > MAX_ORDERS; i--) {
      if (a.orders[i].status !== 'OPEN' && a.orders[i].status !== 'WAITING') a.orders.splice(i, 1);
    }
  }
}

// req: { symbol, name, side, product, type, qty, price?, trigger?, stop?, target? }
// quote: { price, marketState }
// Returns { ok, error?, order, events }.
export function placeOrder(a, req, quote, now = Date.now()) {
  const qty = Number(req.qty);
  const clean = {
    symbol: String(req.symbol || '').toUpperCase(),
    name: req.name || req.symbol,
    side: req.side, product: req.product, type: req.type,
    qty,
    price: req.type === 'LIMIT' ? round2(Number(req.price)) : null,
    trigger: req.type === 'SLM' ? round2(Number(req.trigger)) : null,
  };
  const err = checkOrder(a, { ...clean, price: clean.price, trigger: clean.trigger }, quote?.price);
  if (err) return { ok: false, error: err, events: [] };

  const stop = isNum(req.stop) && req.stop > 0 ? round2(req.stop) : null;
  const target = isNum(req.target) && req.target > 0 ? round2(req.target) : null;
  const opensLong = clean.side === 'BUY';
  const canBracket = clean.product === 'DELIVERY'
    ? clean.side === 'BUY'
    : estimate(a, { ...clean, price: quote.price }).opening === clean.qty;
  if (canBracket) {
    const ref = clean.type === 'LIMIT' ? clean.price : quote.price;
    if (stop && (opensLong ? stop >= ref : stop <= ref)) {
      return { ok: false, error: opensLong ? 'Your stop-loss must be BELOW your buy price.' : 'Your stop-loss must be ABOVE your sell price.', events: [] };
    }
    if (target && (opensLong ? target <= ref : target >= ref)) {
      return { ok: false, error: opensLong ? 'Your target must be ABOVE your buy price.' : 'Your target must be BELOW your sell price.', events: [] };
    }
  }

  const order = {
    id: nextId(a), ...clean,
    status: 'OPEN', placedAt: now, filledAt: null, fillPrice: null, charges: 0,
    note: '', reduceOnly: false, group: null, parent: null, tag: null,
    plan: canBracket && (stop || target) ? { stop, target } : null,
  };
  pushOrder(a, order);
  const events = [];

  // Protective orders wait until the entry fills, and cancel each other (OCO).
  if (canBracket && (stop || target)) {
    const exitSide = clean.side === 'BUY' ? 'SELL' : 'BUY';
    const group = `g${order.id}`;
    const make = (tag, trigger, type, price) => ({
      id: nextId(a), symbol: clean.symbol, name: clean.name, side: exitSide, product: clean.product,
      type, qty, price: price ?? null, trigger: trigger ?? null,
      status: 'WAITING', placedAt: now, filledAt: null, fillPrice: null, charges: 0,
      note: tag === 'stop' ? 'Stop-loss' : 'Target', reduceOnly: true, group, parent: order.id, tag, plan: null,
    });
    if (stop) pushOrder(a, make('stop', stop, 'SLM'));
    if (target) pushOrder(a, make('target', null, 'LIMIT', target));
  }

  // Market orders (and limit orders that are already marketable) fill right away.
  const marketable = clean.type === 'MARKET' ||
    (clean.type === 'LIMIT' && (clean.side === 'BUY' ? quote.price <= clean.price : quote.price >= clean.price));
  if (marketable) {
    const closedNote = quote.marketState === 'closed'
      ? 'Market is closed — filled at the last traded price (a real broker would queue this as an After-Market Order).'
      : '';
    events.push(...fillOrder(a, order, quote.price, now, closedNote));
  }
  return { ok: true, order, events };
}

export function cancelOrder(a, id, reason = 'Cancelled by you', now = Date.now()) {
  const o = a.orders.find((x) => x.id === id);
  if (!o || (o.status !== 'OPEN' && o.status !== 'WAITING')) return [];
  o.status = 'CANCELLED';
  o.note = reason;
  o.filledAt = now;
  const events = [{ type: 'cancelled', order: o, text: `${o.side} ${o.qty} ${shortSym(o.symbol)} cancelled — ${reason}` }];
  // Cancelling an entry also cancels its waiting stop-loss / target.
  for (const c of a.orders) {
    if (c.parent === o.id && c.status === 'WAITING') {
      c.status = 'CANCELLED';
      c.note = 'Entry order was cancelled';
      c.filledAt = now;
    }
  }
  return events;
}

const shortSym = (s) => String(s).replace(/\.(NS|BO)$/i, '');

function reject(a, order, reason, now) {
  order.status = 'REJECTED';
  order.note = reason;
  order.filledAt = now;
  for (const c of a.orders) {
    if (c.parent === order.id && c.status === 'WAITING') {
      c.status = 'CANCELLED';
      c.note = 'Entry order was rejected';
      c.filledAt = now;
    }
  }
  return [{ type: 'rejected', order, text: `${order.side} ${order.qty} ${shortSym(order.symbol)} rejected — ${reason}` }];
}

// ---------- fills ----------
function recordTrade(a, t) {
  a.trades.unshift({ id: nextId(a), ...t });
  if (a.trades.length > MAX_TRADES) a.trades.length = MAX_TRADES;
}

// Applies a fill at `price`. Handles holdings (delivery) and positions (intraday).
export function fillOrder(a, order, price, now, extraNote = '') {
  const events = [];
  let qty = order.qty;

  // Protective / closing orders can only reduce what is actually open.
  if (order.reduceOnly) {
    const avail = order.product === 'DELIVERY'
      ? sellableQty(a, order.symbol, 'DELIVERY')
      : order.side === 'SELL' ? sellableQty(a, order.symbol, 'INTRADAY') : coverableQty(a, order.symbol);
    if (avail < 1) {
      order.status = 'CANCELLED';
      order.note = 'Position was already closed';
      order.filledAt = now;
      return [{ type: 'cancelled', order, text: `${order.tag === 'stop' ? 'Stop-loss' : order.tag === 'target' ? 'Target' : 'Exit'} order for ${shortSym(order.symbol)} cancelled — position was already closed` }];
    }
    qty = Math.min(qty, avail);
  }
  if (order.product === 'DELIVERY' && order.side === 'SELL') {
    const have = sellableQty(a, order.symbol, 'DELIVERY');
    if (have < qty) return reject(a, order, `You hold only ${have} share(s)`, now);
  }

  price = round2(price);
  const ch = chargesFor({ market: a.market, product: order.product, side: order.side, qty, price }).total;
  const est = estimate(a, { side: order.side, product: order.product, qty, price, symbol: order.symbol });
  if (est.required + (order.side === 'BUY' || order.product === 'INTRADAY' ? ch : 0) > a.cash + 1e-9 && est.required > 0) {
    return reject(a, order, 'Not enough virtual funds when the order triggered', now);
  }

  if (order.product === 'DELIVERY') applyDelivery(a, order, qty, price, ch, now);
  else applyIntraday(a, order, qty, price, ch, now);

  order.status = 'COMPLETE';
  order.qty = qty;
  order.fillPrice = price;
  order.filledAt = now;
  order.charges = ch;
  order.note = [order.note, extraNote].filter(Boolean).join(' · ');
  events.push({ type: 'filled', order, text: `${order.side} ${qty} ${shortSym(order.symbol)} filled @ ${price}` });

  // Entry filled: switch its waiting stop-loss / target on.
  for (const c of a.orders) {
    if (c.parent === order.id && c.status === 'WAITING') {
      c.status = 'OPEN';
      c.qty = qty;
    }
  }
  // Exit leg filled: cancel its sibling (OCO).
  if (order.group) {
    for (const c of a.orders) {
      if (c !== order && c.group === order.group && (c.status === 'OPEN' || c.status === 'WAITING')) {
        c.status = 'CANCELLED';
        c.note = order.tag === 'stop' ? 'Stop-loss was hit' : order.tag === 'target' ? 'Target was hit' : 'Linked order filled';
        c.filledAt = now;
      }
    }
  }
  // Fully closed → cancel leftover protective orders for that symbol.
  const left = order.product === 'DELIVERY' ? holdingOf(a, order.symbol)?.qty ?? 0 : positionOf(a, order.symbol)?.qty ?? 0;
  if (left === 0) {
    for (const c of a.orders) {
      if (c.reduceOnly && c.symbol === order.symbol && c.product === order.product && (c.status === 'OPEN' || c.status === 'WAITING') && c !== order) {
        c.status = 'CANCELLED';
        c.note = 'Position was closed';
        c.filledAt = now;
      }
    }
  }
  return events;
}

function applyDelivery(a, order, qty, price, ch, now) {
  let h = holdingOf(a, order.symbol);
  if (order.side === 'BUY') {
    a.cash = round2(a.cash - qty * price - ch);
    if (!h) {
      h = { symbol: order.symbol, name: order.name, qty: 0, avg: 0, since: now, buyCharges: 0, plan: order.plan || null };
      a.holdings.push(h);
    }
    h.avg = round2((h.avg * h.qty + price * qty) / (h.qty + qty));
    h.qty += qty;
    h.buyCharges = round2(h.buyCharges + ch);
    if (order.plan) h.plan = order.plan;
    return;
  }
  // SELL from holdings
  const share = qty / h.qty;
  const buyChargeShare = round2(h.buyCharges * share);
  const gross = round2((price - h.avg) * qty);
  const reason = order.tag === 'stop' ? 'stop' : order.tag === 'target' ? 'target' : order.autoSquareOff ? 'squareoff' : 'manual';
  recordTrade(a, {
    symbol: h.symbol, name: h.name, product: 'DELIVERY', direction: 'LONG', qty,
    entry: h.avg, exit: price, gross, charges: round2(buyChargeShare + ch), net: round2(gross - buyChargeShare - ch),
    openedAt: h.since, closedAt: now, plan: h.plan || null, exitReason: reason,
  });
  a.cash = round2(a.cash + qty * price - ch);
  h.buyCharges = round2(h.buyCharges - buyChargeShare);
  h.qty -= qty;
  if (h.qty === 0) a.holdings.splice(a.holdings.indexOf(h), 1);
}

function applyIntraday(a, order, qty, price, ch, now) {
  const lev = LEVERAGE[a.market];
  const dir = order.side === 'BUY' ? 1 : -1;
  let p = positionOf(a, order.symbol);
  const reason = order.tag === 'stop' ? 'stop' : order.tag === 'target' ? 'target' : order.autoSquareOff ? 'squareoff' : 'manual';
  let remaining = qty;
  let chargeLeft = ch;

  // 1) Close (part of) an opposite position.
  if (p && sign(p.qty) === -dir) {
    const closeQty = Math.min(remaining, Math.abs(p.qty));
    const share = closeQty / Math.abs(p.qty);
    const chShare = round2(ch * (closeQty / qty));
    const openChShare = round2(p.openCharges * share);
    const marginShare = round2(p.margin * share);
    const gross = round2((price - p.avg) * closeQty * sign(p.qty));
    recordTrade(a, {
      symbol: p.symbol, name: p.name, product: 'INTRADAY', direction: p.qty > 0 ? 'LONG' : 'SHORT', qty: closeQty,
      entry: p.avg, exit: price, gross, charges: round2(openChShare + chShare), net: round2(gross - openChShare - chShare),
      openedAt: p.openedAt, closedAt: now, plan: p.plan || null, exitReason: reason,
    });
    a.cash = round2(a.cash + marginShare + gross - chShare);
    chargeLeft = round2(chargeLeft - chShare);
    p.margin = round2(p.margin - marginShare);
    p.openCharges = round2(p.openCharges - openChShare);
    p.qty -= sign(p.qty) * closeQty;
    remaining -= closeQty;
    if (p.qty === 0) {
      a.positions.splice(a.positions.indexOf(p), 1);
      p = null;
    }
  }
  // 2) Open / add to a position in the order's direction with whatever is left.
  if (remaining > 0) {
    const margin = round2((remaining * price) / lev);
    a.cash = round2(a.cash - margin - chargeLeft);
    if (!p) {
      p = { symbol: order.symbol, name: order.name, qty: 0, avg: 0, margin: 0, openCharges: 0, openedAt: now, plan: order.plan || null };
      a.positions.push(p);
    }
    const total = Math.abs(p.qty) + remaining;
    p.avg = round2((p.avg * Math.abs(p.qty) + price * remaining) / total);
    p.qty += dir * remaining;
    p.margin = round2(p.margin + margin);
    p.openCharges = round2(p.openCharges + chargeLeft);
    if (order.plan) p.plan = order.plan;
  }
}

// ---------- background processing ----------
// quotes: { [symbol]: { price, marketState } }. Checks every live order and
// returns the events (fills / cancellations) so the UI can announce them.
export function processOrders(a, quotes, now = Date.now()) {
  const events = [];
  const live = a.orders.filter((o) => o.status === 'OPEN').sort((x, y) => x.id - y.id);
  for (const o of live) {
    if (o.status !== 'OPEN') continue; // may have been cancelled by an earlier fill in this loop
    const q = quotes?.[o.symbol];
    if (!q || !isNum(q.price) || q.price <= 0) continue;
    const p = q.price;
    if (o.type === 'LIMIT') {
      const hit = o.side === 'BUY' ? p <= o.price : p >= o.price;
      if (hit) events.push(...fillOrder(a, o, o.price, now, 'Limit price reached'));
    } else if (o.type === 'SLM') {
      const hit = o.side === 'SELL' ? p <= o.trigger : p >= o.trigger;
      if (hit) events.push(...fillOrder(a, o, p, now, 'Trigger price reached'));
    } else if (o.type === 'MARKET') {
      events.push(...fillOrder(a, o, p, now));
    }
  }
  return events;
}

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

// Intraday positions left over from an earlier day are closed at the latest
// price, like a broker's end-of-day auto square-off.
export function squareOffStale(a, quotes, now = Date.now()) {
  const events = [];
  for (const p of [...a.positions]) {
    if (dayKey(p.openedAt) === dayKey(now)) continue;
    const q = quotes?.[p.symbol];
    if (!q || !isNum(q.price)) continue;
    const order = {
      id: nextId(a), symbol: p.symbol, name: p.name, side: p.qty > 0 ? 'SELL' : 'BUY', product: 'INTRADAY', type: 'MARKET',
      qty: Math.abs(p.qty), price: null, trigger: null, status: 'OPEN', placedAt: now, filledAt: null, fillPrice: null,
      charges: 0, note: 'Auto square-off (intraday positions are closed by the broker before the market ends)',
      reduceOnly: true, group: null, parent: null, tag: null, plan: null, autoSquareOff: true,
    };
    pushOrder(a, order);
    events.push(...fillOrder(a, order, q.price, now));
  }
  return events;
}

// ---------- reporting ----------
// quotes: { [symbol]: { price, prevClose } }; missing quotes fall back to cost.
export function summary(a, quotes = {}) {
  const px = (h) => (isNum(quotes[h.symbol]?.price) ? quotes[h.symbol].price : h.avg);
  let invested = 0, holdingsValue = 0, positionsPnl = 0, marginUsed = 0;
  for (const h of a.holdings) {
    invested += h.avg * h.qty;
    holdingsValue += px(h) * h.qty;
  }
  for (const p of a.positions) {
    positionsPnl += (px(p) - p.avg) * p.qty;
    marginUsed += p.margin;
  }
  const unrealised = holdingsValue - invested + positionsPnl;
  const equity = a.cash + holdingsValue + marginUsed + positionsPnl;
  const realised = a.trades.reduce((s, t) => s + t.net, 0);
  return {
    cash: round2(a.cash), invested: round2(invested), holdingsValue: round2(holdingsValue),
    positionsPnl: round2(positionsPnl), marginUsed: round2(marginUsed),
    unrealised: round2(unrealised), realised: round2(realised),
    equity: round2(equity), totalPnl: round2(equity - a.startFunds),
    totalPct: round2(((equity - a.startFunds) / a.startFunds) * 100),
  };
}

export function tradeStats(a) {
  const t = a.trades;
  const wins = t.filter((x) => x.net > 0);
  const losses = t.filter((x) => x.net < 0);
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const net = round2(sum(t, (x) => x.net));
  const grossProfit = sum(wins, (x) => x.net);
  const grossLoss = Math.abs(sum(losses, (x) => x.net));
  return {
    count: t.length, wins: wins.length, losses: losses.length,
    winRate: t.length ? (wins.length / t.length) * 100 : null,
    net, charges: round2(sum(t, (x) => x.charges)),
    avgWin: wins.length ? round2(grossProfit / wins.length) : null,
    avgLoss: losses.length ? round2(-grossLoss / losses.length) : null,
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : null,
    best: t.length ? t.reduce((m, x) => (x.net > m.net ? x : m)) : null,
    worst: t.length ? t.reduce((m, x) => (x.net < m.net ? x : m)) : null,
  };
}

// R-multiple: result measured in units of the money you planned to risk.
export function rMultiple(t) {
  const stop = t.plan?.stop;
  if (!isNum(stop) || !isNum(t.entry)) return null;
  const risk = Math.abs(t.entry - stop) * t.qty;
  return risk > 0 ? round2(t.net / risk) : null;
}

// Plain-English feedback on one closed trade.
export function reviewTrade(t) {
  const out = [];
  const r = rMultiple(t);
  if (t.exitReason === 'stop') out.push('Your stop-loss did its job: the loss was cut at the level you chose instead of growing.');
  else if (t.exitReason === 'target') out.push('Target reached — you followed your plan and booked the profit.');
  else if (t.exitReason === 'squareoff') out.push('This intraday position was auto-squared-off. In real trading you should exit it yourself before the close.');
  else if (!t.plan?.stop) out.push('You had no stop-loss on this trade. Decide your exit before you enter — it is the single best habit to build.');
  if (r != null) {
    if (r >= 1) out.push(`You made ${r}R — ${r}× the amount you risked. Aim for trades that pay at least 2R.`);
    else if (r > -0.9) out.push(`Result: ${r}R (R = the money you were prepared to lose on the trade).`);
    else if (r < -1.2) out.push(`You lost ${Math.abs(r)}R — more than you planned to risk. Check that your stop-loss was in place and not moved.`);
    else out.push(`You lost about 1R — exactly the risk you planned. That is a "good loss": it is part of the plan.`);
  }
  if (t.gross > 0 && t.charges / t.gross > 0.25) {
    out.push(`Charges and taxes took ${Math.round((t.charges / t.gross) * 100)}% of your gross profit. Very small trades often cost more than they earn.`);
  } else if (t.gross > 0 && t.net < 0) {
    out.push('You were right on direction but charges turned a small gain into a loss. Aim for bigger moves per trade.');
  }
  if (t.gross === 0 && t.charges > 0) {
    out.push(`Entry and exit were at the same price, yet you still paid ${t.charges} in charges. Every trade has to earn more than its charges before it makes any money.`);
  }
  if (!out.length) out.push(t.net >= 0 ? 'A profitable trade. Note why you entered, so you can repeat the good decisions.' : 'A losing trade. Write down what you would do differently — that is how paper trading pays off.');
  return out;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newAccount, validAccount, chargesFor, estimate, checkOrder, placeOrder, cancelOrder, processOrders,
  squareOffStale, summary, tradeStats, rMultiple, reviewTrade, marketOfSymbol, START_FUNDS,
} from '../lib/paper.js';

const close = (a, b, eps = 0.011) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const T0 = new Date(2026, 5, 10, 11, 0).getTime();
const open = (price) => ({ price, marketState: 'open' });
const order = (o) => ({ symbol: 'TCS.NS', name: 'TCS', side: 'BUY', product: 'DELIVERY', type: 'MARKET', qty: 10, ...o });

test('market detection and fresh account', () => {
  assert.equal(marketOfSymbol('TCS.NS'), 'IN');
  assert.equal(marketOfSymbol('abc.bo'), 'IN');
  assert.equal(marketOfSymbol('AAPL'), 'US');
  const a = newAccount('IN', undefined, T0);
  assert.equal(a.cash, START_FUNDS.IN);
  assert.ok(validAccount(a, 'IN'));
  assert.ok(!validAccount(a, 'US'));
  assert.ok(!validAccount({ ...a, cash: 'x' }, 'IN'));
  assert.ok(!validAccount(null, 'IN'));
  assert.equal(newAccount('US', 50000).cash, 50000);
  assert.equal(newAccount('US', -5).cash, START_FUNDS.US);
});

test('india delivery charges: STT both sides, stamp on buy, GST on brokerage+fees', () => {
  const buy = chargesFor({ market: 'IN', product: 'DELIVERY', side: 'BUY', qty: 100, price: 1000 }); // ₹1,00,000
  assert.equal(buy.brokerage, 20);
  assert.equal(buy.stt, 100); // 0.1%
  assert.equal(buy.stamp, 15); // 0.015%
  close(buy.exchange, 2.97);
  close(buy.gst, (20 + 2.97 + 0.1) * 0.18);
  const sell = chargesFor({ market: 'IN', product: 'DELIVERY', side: 'SELL', qty: 100, price: 1000 });
  assert.equal(sell.stamp, 0);
  assert.equal(sell.stt, 100);
});

test('intraday charges: STT only on sell, lower stamp; brokerage capped at 2.5% for tiny orders', () => {
  const buy = chargesFor({ market: 'IN', product: 'INTRADAY', side: 'BUY', qty: 100, price: 1000 });
  const sell = chargesFor({ market: 'IN', product: 'INTRADAY', side: 'SELL', qty: 100, price: 1000 });
  assert.equal(buy.stt, 0);
  assert.equal(sell.stt, 25);
  assert.equal(buy.stamp, 3);
  const tiny = chargesFor({ market: 'IN', product: 'DELIVERY', side: 'BUY', qty: 1, price: 100 });
  assert.equal(tiny.brokerage, 2.5);
  assert.equal(chargesFor({ market: 'US', product: 'DELIVERY', side: 'BUY', qty: 10, price: 100 }).total, 0);
});

test('delivery buy then sell: cash, holdings, trade P&L after charges', () => {
  const a = newAccount('IN', 1000000, T0);
  const buy = placeOrder(a, order({ qty: 100 }), open(1000), T0);
  assert.ok(buy.ok);
  assert.equal(buy.order.status, 'COMPLETE');
  assert.equal(a.holdings.length, 1);
  assert.equal(a.holdings[0].qty, 100);
  assert.equal(a.holdings[0].avg, 1000);
  const buyCh = chargesFor({ market: 'IN', product: 'DELIVERY', side: 'BUY', qty: 100, price: 1000 }).total;
  close(a.cash, 1000000 - 100000 - buyCh);

  const sell = placeOrder(a, order({ side: 'SELL', qty: 100 }), open(1050), T0 + 1000);
  assert.ok(sell.ok, sell.error);
  assert.equal(a.holdings.length, 0);
  assert.equal(a.trades.length, 1);
  const t = a.trades[0];
  assert.equal(t.gross, 5000);
  const sellCh = chargesFor({ market: 'IN', product: 'DELIVERY', side: 'SELL', qty: 100, price: 1050 }).total;
  close(t.charges, buyCh + sellCh);
  close(t.net, 5000 - buyCh - sellCh);
  // Money is conserved: ending cash = start + net P&L.
  close(a.cash, 1000000 + t.net);
  close(summary(a).totalPnl, t.net);
});

test('averaging up and partial sell keeps weighted average and splits buy charges', () => {
  const a = newAccount('US', 100000, T0);
  placeOrder(a, order({ symbol: 'AAPL', name: 'Apple', qty: 10 }), open(100), T0);
  placeOrder(a, order({ symbol: 'AAPL', name: 'Apple', qty: 30 }), open(120), T0);
  assert.equal(a.holdings[0].avg, 115);
  placeOrder(a, order({ symbol: 'AAPL', name: 'Apple', side: 'SELL', qty: 10 }), open(130), T0);
  assert.equal(a.holdings[0].qty, 30);
  assert.equal(a.trades[0].gross, 150);
  close(a.cash, 100000 - 10 * 100 - 30 * 120 + 10 * 130);
});

test('cannot sell what you do not own in delivery, or more than you hold', () => {
  const a = newAccount('IN', 100000, T0);
  const r = placeOrder(a, order({ side: 'SELL', qty: 5 }), open(100), T0);
  assert.ok(!r.ok);
  assert.match(r.error, /do not own/);
  placeOrder(a, order({ qty: 5 }), open(100), T0);
  assert.match(placeOrder(a, order({ side: 'SELL', qty: 6 }), open(100), T0).error, /only hold 5/);
});

test('validation: quantity, funds, indexes, wrong market, limit/trigger prices', () => {
  const a = newAccount('IN', 10000, T0);
  assert.match(checkOrder(a, order({ qty: 0 }), 100), /whole number/);
  assert.match(checkOrder(a, order({ qty: 1.5 }), 100), /whole number/);
  assert.match(checkOrder(a, order({ symbol: '^NSEI' }), 100), /Indexes/);
  assert.match(checkOrder(a, order({ symbol: 'AAPL' }), 100), /other market/);
  assert.match(checkOrder(a, order({ qty: 1000 }), 100), /Not enough virtual funds/);
  assert.match(checkOrder(a, order({ type: 'LIMIT' }), 100), /limit price/);
  assert.match(checkOrder(a, order({ type: 'SLM' }), 100), /trigger/);
  assert.match(checkOrder(a, order({}), NaN), /live price/);
  assert.equal(checkOrder(a, order({ qty: 10 }), 100), null);
});

test('stop-loss order trigger must be on the correct side of the price', () => {
  const a = newAccount('IN', 100000, T0);
  placeOrder(a, order({ qty: 5 }), open(100), T0);
  assert.match(checkOrder(a, order({ side: 'SELL', type: 'SLM', trigger: 105, qty: 5 }), 100), /BELOW/);
  assert.equal(checkOrder(a, order({ side: 'SELL', type: 'SLM', trigger: 95, qty: 5 }), 100), null);
  assert.match(checkOrder(a, order({ type: 'SLM', trigger: 95 }), 100), /ABOVE/);
});

test('limit buy below market waits, then fills at the limit price when reached', () => {
  const a = newAccount('IN', 100000, T0);
  const r = placeOrder(a, order({ type: 'LIMIT', price: 95, qty: 10 }), open(100), T0);
  assert.ok(r.ok);
  assert.equal(r.order.status, 'OPEN');
  assert.equal(a.holdings.length, 0);
  assert.equal(processOrders(a, { 'TCS.NS': { price: 98 } }, T0 + 1).length, 0);
  const ev = processOrders(a, { 'TCS.NS': { price: 94 } }, T0 + 2);
  assert.equal(ev[0].type, 'filled');
  assert.equal(a.holdings[0].avg, 95);
});

test('marketable limit order fills at the current price (price improvement)', () => {
  const a = newAccount('IN', 100000, T0);
  const r = placeOrder(a, order({ type: 'LIMIT', price: 105, qty: 10 }), open(100), T0);
  assert.equal(r.order.status, 'COMPLETE');
  assert.equal(r.order.fillPrice, 100);
});

test('market order while the market is closed fills at last price with an explanatory note', () => {
  const a = newAccount('IN', 100000, T0);
  const r = placeOrder(a, order({ qty: 1 }), { price: 100, marketState: 'closed' }, T0);
  assert.equal(r.order.status, 'COMPLETE');
  assert.match(r.order.note, /Market is closed/);
});

test('bracket: stop-loss and target wait for the entry, then cancel each other (OCO)', () => {
  const a = newAccount('IN', 100000, T0);
  const r = placeOrder(a, order({ type: 'LIMIT', price: 95, qty: 10, stop: 90, target: 110 }), open(100), T0);
  assert.ok(r.ok, r.error);
  const children = a.orders.filter((o) => o.parent === r.order.id);
  assert.equal(children.length, 2);
  assert.ok(children.every((c) => c.status === 'WAITING' && c.reduceOnly));

  processOrders(a, { 'TCS.NS': { price: 94 } }, T0 + 1); // entry fills
  assert.ok(children.every((c) => c.status === 'OPEN'));
  assert.equal(a.holdings[0].plan.stop, 90);

  // price falls to the stop → stop fills at market, target is cancelled
  const ev = processOrders(a, { 'TCS.NS': { price: 89 } }, T0 + 2);
  assert.equal(ev.filter((e) => e.type === 'filled').length, 1);
  const stop = children.find((c) => c.tag === 'stop');
  const target = children.find((c) => c.tag === 'target');
  assert.equal(stop.status, 'COMPLETE');
  assert.equal(stop.fillPrice, 89);
  assert.equal(target.status, 'CANCELLED');
  assert.equal(a.holdings.length, 0);
  assert.equal(a.trades[0].exitReason, 'stop');
  assert.ok(a.trades[0].net < 0);
});

test('bracket target fills at the target price', () => {
  const a = newAccount('IN', 100000, T0);
  placeOrder(a, order({ qty: 10, stop: 90, target: 110 }), open(100), T0);
  processOrders(a, { 'TCS.NS': { price: 112 } }, T0 + 1);
  assert.equal(a.trades[0].exit, 110);
  assert.equal(a.trades[0].exitReason, 'target');
  assert.equal(a.orders.filter((o) => o.tag === 'stop')[0].status, 'CANCELLED');
});

test('bracket levels on the wrong side are rejected', () => {
  const a = newAccount('IN', 100000, T0);
  assert.match(placeOrder(a, order({ stop: 105 }), open(100), T0).error, /BELOW/);
  assert.match(placeOrder(a, order({ target: 95 }), open(100), T0).error, /ABOVE/);
  assert.equal(a.orders.length, 0);
});

test('selling manually cancels leftover protective orders', () => {
  const a = newAccount('IN', 100000, T0);
  placeOrder(a, order({ qty: 10, stop: 90, target: 110 }), open(100), T0);
  placeOrder(a, order({ side: 'SELL', qty: 10 }), open(101), T0 + 1);
  assert.equal(openOrders(a).length, 0);
  assert.equal(a.trades[0].exitReason, 'manual');
});
function openOrders(a) { return a.orders.filter((o) => o.status === 'OPEN' || o.status === 'WAITING'); }

test('cancelling an entry cancels its waiting stop-loss', () => {
  const a = newAccount('IN', 100000, T0);
  const r = placeOrder(a, order({ type: 'LIMIT', price: 90, stop: 85 }), open(100), T0);
  cancelOrder(a, r.order.id, 'Cancelled by you', T0 + 1);
  assert.equal(openOrders(a).length, 0);
  assert.equal(r.order.status, 'CANCELLED');
});

test('intraday uses margin: blocks value/leverage and returns it with P&L on exit', () => {
  const a = newAccount('IN', 100000, T0);
  const r = placeOrder(a, order({ product: 'INTRADAY', qty: 100 }), open(1000), T0); // value 1,00,000, margin 20,000
  assert.ok(r.ok, r.error);
  const p = a.positions[0];
  assert.equal(p.margin, 20000);
  assert.equal(a.holdings.length, 0);
  close(summary(a, { 'TCS.NS': { price: 1000 } }).equity, 100000 - p.openCharges);
  placeOrder(a, order({ product: 'INTRADAY', side: 'SELL', qty: 100 }), open(1010), T0 + 1);
  assert.equal(a.positions.length, 0);
  assert.equal(a.trades[0].gross, 1000);
  close(a.cash, 100000 + a.trades[0].net);
});

test('intraday short selling: profit when price falls; reversal in one order closes then opens', () => {
  const a = newAccount('IN', 100000, T0);
  placeOrder(a, order({ product: 'INTRADAY', side: 'SELL', qty: 50 }), open(200), T0);
  assert.equal(a.positions[0].qty, -50);
  placeOrder(a, order({ product: 'INTRADAY', side: 'BUY', qty: 50 }), open(190), T0 + 1);
  assert.equal(a.positions.length, 0);
  assert.equal(a.trades[0].direction, 'SHORT');
  assert.equal(a.trades[0].gross, 500);
  // reversal: long 10 then sell 25 → close 10, open short 15
  placeOrder(a, order({ product: 'INTRADAY', side: 'BUY', qty: 10 }), open(100), T0 + 2);
  placeOrder(a, order({ product: 'INTRADAY', side: 'SELL', qty: 25 }), open(101), T0 + 3);
  assert.equal(a.positions[0].qty, -15);
  assert.equal(a.trades[0].qty, 10);
  assert.equal(a.trades[0].gross, 10);
});

test('intraday: delivery SELL is not allowed without holdings, but intraday sell-first is', () => {
  const a = newAccount('IN', 100000, T0);
  assert.ok(!placeOrder(a, order({ side: 'SELL', qty: 1 }), open(100), T0).ok);
  assert.ok(placeOrder(a, order({ side: 'SELL', product: 'INTRADAY', qty: 1 }), open(100), T0).ok);
});

test('stale intraday positions are auto-squared-off at the latest price', () => {
  const a = newAccount('IN', 100000, T0);
  placeOrder(a, order({ product: 'INTRADAY', qty: 10 }), open(100), T0);
  assert.equal(squareOffStale(a, { 'TCS.NS': { price: 101 } }, T0 + 60_000).length, 0); // same day
  const ev = squareOffStale(a, { 'TCS.NS': { price: 102 } }, T0 + 26 * 3600 * 1000);
  assert.equal(ev.length, 1);
  assert.equal(a.positions.length, 0);
  assert.equal(a.trades[0].exitReason, 'squareoff');
  assert.equal(a.trades[0].gross, 20);
});

test('summary: equity = cash + holdings at market; invested vs unrealised', () => {
  const a = newAccount('IN', 100000, T0);
  placeOrder(a, order({ qty: 10 }), open(100), T0);
  const s = summary(a, { 'TCS.NS': { price: 110 } });
  assert.equal(s.invested, 1000);
  assert.equal(s.holdingsValue, 1100);
  assert.equal(s.unrealised, 100);
  close(s.equity, a.cash + 1100);
});

test('estimate: delivery needs full value; intraday only margin; closing needs nothing', () => {
  const a = newAccount('IN', 100000, T0);
  assert.equal(estimate(a, { side: 'BUY', product: 'DELIVERY', qty: 10, price: 100, symbol: 'X.NS' }).required, 1000);
  assert.equal(estimate(a, { side: 'BUY', product: 'INTRADAY', qty: 10, price: 100, symbol: 'X.NS' }).required, 200);
  placeOrder(a, order({ symbol: 'X.NS', product: 'INTRADAY', qty: 10 }), open(100), T0);
  assert.equal(estimate(a, { side: 'SELL', product: 'INTRADAY', qty: 10, price: 100, symbol: 'X.NS' }).required, 0);
});

test('trade stats, R-multiple and review feedback', () => {
  const a = newAccount('IN', 1000000, T0);
  placeOrder(a, order({ qty: 100, stop: 95, target: 110 }), open(100), T0);
  processOrders(a, { 'TCS.NS': { price: 111 } }, T0 + 1); // target → +1000 gross (2R)
  placeOrder(a, order({ qty: 100, stop: 95 }), open(100), T0 + 2);
  processOrders(a, { 'TCS.NS': { price: 94 } }, T0 + 3); // stop → about −600 (≈ −1.2R)
  const st = tradeStats(a);
  assert.equal(st.count, 2);
  assert.equal(st.wins, 1);
  assert.equal(st.losses, 1);
  assert.equal(st.winRate, 50);
  assert.ok(st.charges > 0);
  const win = a.trades.find((t) => t.exitReason === 'target');
  const loss = a.trades.find((t) => t.exitReason === 'stop');
  assert.ok(rMultiple(win) > 1.5);
  assert.ok(rMultiple(loss) < -1);
  assert.ok(reviewTrade(win).some((x) => /Target reached/.test(x)));
  assert.ok(reviewTrade(loss).some((x) => /stop-loss did its job/.test(x)));
  assert.ok(reviewTrade({ ...win, plan: null, exitReason: 'manual' }).some((x) => /no stop-loss/.test(x)));
  assert.equal(tradeStats(newAccount('IN')).winRate, null);
});

test('a tiny gain wiped out by charges is called out', () => {
  const a = newAccount('IN', 100000, T0);
  placeOrder(a, order({ qty: 10 }), open(100), T0);
  placeOrder(a, order({ side: 'SELL', qty: 10 }), open(101), T0 + 1);
  const t = a.trades[0];
  assert.equal(t.gross, 10);
  assert.ok(t.net < 0);
  assert.ok(reviewTrade(t).some((x) => /charges turned a small gain/.test(x) || /Charges and taxes/.test(x)));
});

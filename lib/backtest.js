// Replays the app's own signals on past data, to measure how they would really have done.
//
// Honesty rules built in:
//   * a signal only sees data that existed at that moment (no look-ahead)
//   * you buy at the NEXT candle's open, not at the price that produced the signal
//   * if stop and target are both touched inside one candle, the stop is assumed to come first
//   * trading costs are taken off every trade
//   * every result is compared with buying ANY stock at the same moment with the same stop and target,
//     so a rising market cannot make weak picking look skilful
import { analyze, summarize } from './analysis.js';
import { analyzeIntraday, evaluateBest, indexBias, splitDays } from './intraday.js';

export const COST_PCT = { intraday: 0.1, swing: 0.25 }; // round trip: brokerage, taxes (STT), fees, slippage
const DAILY_WINDOW = 500; // the app analyses about two years of daily candles
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// Buy at bars[i0].open; leave at the stop, the target or the close of the last allowed bar.
// Returns null when the trade could not sensibly be taken (it opened beyond the stop or the target).
export function simulateTrade(bars, i0, { stop, target = Infinity, maxBars = Infinity }) {
  const first = bars[i0];
  if (!first) return null;
  const entry = first.open;
  if (!(entry > stop) || !(entry < target)) return null;
  const end = Math.min(bars.length - 1, i0 + maxBars - 1);
  const out = (exit, how, i) => ({ entry, exit, how, held: i - i0 + 1, grossPct: ((exit - entry) / entry) * 100, riskPct: ((entry - stop) / entry) * 100 });
  for (let i = i0; i <= end; i++) {
    const b = bars[i];
    if (i > i0 && b.open <= stop) return out(b.open, 'stop', i); // gapped through the stop
    if (b.low <= stop) return out(stop, 'stop', i);
    if (i > i0 && b.open >= target) return out(b.open, 'target', i);
    if (b.high >= target) return out(target, 'target', i);
  }
  return out(bars[end].close, 'time', end);
}

// Summary of a list of trades. `day` groups trades taken the same day: they move together, so the
// reliability score (t) is computed from daily averages, not from individual trades.
export function stats(trades, costPct) {
  const n = trades.length;
  if (!n) return { trades: 0 };
  const net = trades.map((t) => t.grossPct - costPct);
  const wins = net.filter((v) => v > 0);
  const losses = net.filter((v) => v <= 0);
  const byDay = new Map();
  trades.forEach((t, i) => byDay.set(t.day, [...(byDay.get(t.day) ?? []), net[i]]));
  const daily = [...byDay.values()].map(mean);
  const dm = mean(daily);
  const sd = daily.length > 1 ? Math.sqrt(daily.reduce((a, v) => a + (v - dm) ** 2, 0) / (daily.length - 1)) : null;
  const edge = trades.filter((t) => typeof t.baselinePct === 'number').map((t) => t.grossPct - t.baselinePct);
  const round = (v, d = 3) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
  const lossSum = Math.abs(losses.reduce((a, b) => a + b, 0));
  return {
    trades: n,
    days: byDay.size,
    winRate: round((wins.length / n) * 100, 1),
    avgNetPct: round(mean(net)),
    avgWinPct: round(mean(wins)),
    avgLossPct: round(mean(losses)),
    avgR: round(mean(trades.map((t, i) => net[i] / t.riskPct))),
    profitFactor: lossSum > 0 ? round(wins.reduce((a, b) => a + b, 0) / lossSum, 2) : null,
    stopRate: round((trades.filter((t) => t.how === 'stop').length / n) * 100, 1),
    targetRate: round((trades.filter((t) => t.how === 'target').length / n) * 100, 1),
    // how much better than buying any stock at the same moment with the same stop/target (before costs)
    edgeVsAnyStockPct: round(mean(edge)),
    // |t| below ~2 means the average cannot be told apart from luck
    t: sd ? round(dm / (sd / Math.sqrt(daily.length)), 2) : null,
  };
}

// ---------- intraday ----------
// exit: 'close' = wide stop, held to the close (what the app now shows) · 'target' = wide stop with the
// 2x target · 'tight' = the app's earlier rule (tight stop and nearby target)
export const INTRADAY_RULES = [
  { id: 'all_checks', label: 'Passes every check: wide stop, hold to close (what the app shows)', pick: (x) => x.best.passed, exit: 'close', current: true },
  { id: 'all_checks_target', label: 'Passes every check: wide stop, sell at Target 1', pick: (x) => x.best.passed, exit: 'target' },
  { id: 'all_checks_tight', label: 'Passes every check: tight stop + near target (old rule)', pick: (x) => x.best.passed, exit: 'tight' },
  { id: 'all_checks_early', label: 'Passes every check, signals before 11:30 only', pick: (x) => x.best.passed && x.k <= 27, exit: 'close' },
  { id: 'all_checks_bull', label: 'Passes every check, only when the index is bullish', pick: (x) => x.best.passed && x.market?.bias === 'bullish', exit: 'close' },
  { id: 'any_buy', label: 'Any buy signal: wide stop, hold to close', pick: (x) => x.a.plan.action === 'buy', exit: 'close' },
  { id: 'any_buy_tight', label: 'Any buy signal: tight stop (what the old digest sent)', pick: (x) => x.a.plan.action === 'buy', exit: 'tight' },
];
const SESSION_BARS = 75;
const CHECK_BARS = Array.from({ length: 19 }, (_, i) => 6 + i * 3); // every 15 minutes from 9:45 to 14:15

const levels = (rule, plan, entry) => {
  if (rule.exit === 'tight') return { stop: entry - (plan.entry - plan.baseStop), target: entry + (plan.baseTarget1 - plan.entry) };
  const risk = plan.entry - plan.stopLoss; // already the wide stop
  return { stop: entry - risk, target: rule.exit === 'target' ? entry + (plan.target1 - plan.entry) : Infinity };
};

// data: [{ symbol, daily: [...], m5: [...] }]; index: same shape for the market index.
export function backtestIntraday(data, index, { rules = INTRADAY_RULES, onDay } = {}) {
  const prep = (d) => {
    const days = splitDays(d.m5);
    return { symbol: d.symbol, days, byDate: new Map(days.map((x, i) => [x.date, i])), daily: d.daily };
  };
  const stocks = data.map(prep);
  const idx = prep(index);
  const dates = idx.days.map((d) => d.date);
  const trades = Object.fromEntries(rules.map((r) => [r.id, []]));
  const dailyCache = new Map();
  const dailyAt = (s, date) => {
    const key = `${s.symbol}|${date}`;
    if (!dailyCache.has(key)) {
      const upto = s.daily.filter((c) => c.time < date).slice(-DAILY_WINDOW); // yesterday and before only
      const sum = upto.length ? summarize({ symbol: s.symbol, candles: upto, price: upto.at(-1).close, marketState: 'closed' }) : null;
      dailyCache.set(key, sum && !sum.insufficient ? { score: sum.score, verdict: sum.verdict } : null);
    }
    return dailyCache.get(key);
  };
  const windowFor = (s, di, k) => [...s.days.slice(Math.max(0, di - 4), di).flatMap((d) => d.bars), ...s.days[di].bars.slice(0, k)];

  for (let di = 5; di < dates.length; di++) {
    const date = dates[di];
    onDay?.(date, di - 4, dates.length - 5);
    const taken = new Map(rules.map((r) => [r.id, new Set()])); // one trade per stock per day per rule
    for (const k of CHECK_BARS) {
      const idxWin = windowFor(idx, di, k);
      const market = indexBias({ candles: idxWin, price: idxWin.at(-1).close, marketState: 'open' }, 'NIFTY 50');
      const baselineCache = new Map();
      for (const s of stocks) {
        const si = s.byDate.get(date);
        if (si === undefined || si < 4) continue;
        const bars = s.days[si].bars;
        if (bars.length < k + 2) continue;
        if (rules.every((r) => taken.get(r.id).has(s.symbol))) continue;
        const win = windowFor(s, si, k);
        const a = analyzeIntraday({ symbol: s.symbol, candles: win, price: win.at(-1).close, marketState: 'open' }, { minutesLeft: (SESSION_BARS - k) * 5 });
        if (a.insufficient || a.plan.action !== 'buy') continue; // every rule starts from a buy signal
        const daily = dailyAt(s, date);
        const best = evaluateBest({ intraday: a, daily }, { marketBias: market, marketOpen: true, minutesLeft: (SESSION_BARS - k) * 5 });
        const ctx = { a, best, daily, market, k };
        for (const rule of rules) {
          if (taken.get(rule.id).has(s.symbol) || !rule.pick(ctx)) continue;
          const entryBar = bars[k];
          const { stop, target } = levels(rule, a.plan, entryBar.open);
          const t = simulateTrade(bars, k, { stop, target });
          if (!t) continue;
          taken.get(rule.id).add(s.symbol);
          // The same stop/target distances applied to every stock at the same moment.
          const rk = (t.entry - stop) / t.entry;
          const rw = Number.isFinite(target) ? (target - t.entry) / t.entry : Infinity;
          const bk = `${k}|${rk.toFixed(4)}|${Number.isFinite(rw) ? rw.toFixed(4) : 'inf'}`;
          if (!baselineCache.has(bk)) {
            const all = stocks.map((o) => {
              const b = o.days[o.byDate.get(date)]?.bars;
              const r = b?.[k] ? simulateTrade(b, k, { stop: b[k].open * (1 - rk), target: Number.isFinite(rw) ? b[k].open * (1 + rw) : Infinity }) : null;
              return r?.grossPct;
            }).filter((v) => typeof v === 'number');
            baselineCache.set(bk, mean(all));
          }
          trades[rule.id].push({ ...t, symbol: s.symbol, day: date, k, baselinePct: baselineCache.get(bk) });
        }
      }
    }
  }
  return { dates: dates.slice(5), trades };
}

// ---------- short term (swing, days to weeks) ----------
const above = (candles, n) => {
  if (candles.length < n) return null;
  return candles.at(-1).close > mean(candles.slice(-n).map((c) => c.close));
};
export const SWING_RULES = [
  // Must stay the same rule as pickSwing() in select.js, so the label next to the picks measures what is shown.
  { id: 'shown', label: 'Strong Buy, above 200-day average, RSI under 70 (what the app shows)', current: true,
    pick: (x) => x.a.verdict.key === 'strong_buy' && x.a.stats.sma200 != null && x.a.stats.price > x.a.stats.sma200 && !(x.a.stats.rsi >= 70) },
  { id: 'buy', label: 'Daily signal Buy or Strong Buy (the Analyse page signal)', pick: (x) => x.buy },
  { id: 'strong', label: 'Strong Buy only', pick: (x) => x.a.verdict.key === 'strong_buy' },
  { id: 'buy_filtered', label: 'Buy, NIFTY above its 50-day average, RSI under 70', pick: (x) => x.buy && x.niftyUp && x.a.stats.rsi < 70 },
  { id: 'buy_wide', label: 'Buy, wider stop (3 x daily range), target 2x the risk', pick: (x) => x.buy, atrStop: 3, rr: 2 },
  { id: 'buy_not_stretched', label: 'Buy, price within 1 daily range of the 20-day average', pick: (x) => x.buy && x.a.stats.price - x.a.stats.sma20 <= x.a.stats.atr },
  { id: 'filtered_wide', label: 'NIFTY up, RSI under 70, wider stop, hold up to 40 days', pick: (x) => x.buy && x.niftyUp && x.a.stats.rsi < 70, atrStop: 3, rr: 2, hold: 40 },
];

export function backtestSwing(data, index, { rules = SWING_RULES, from = 252, step = 1, hold = 20, onStock } = {}) {
  const trades = Object.fromEntries(rules.map((r) => [r.id, []]));
  const idxByDate = new Map(index.daily.map((c, i) => [c.time, i]));
  const niftyUpCache = new Map();
  const niftyUp = (date) => {
    if (!niftyUpCache.has(date)) {
      const i = idxByDate.get(date);
      niftyUpCache.set(date, i === undefined ? false : above(index.daily.slice(0, i + 1), 50) === true);
    }
    return niftyUpCache.get(date);
  };
  const byDate = data.map((s) => new Map(s.daily.map((c, i) => [c.time, i])));
  const baseline = new Map();
  const baselineFor = (date, rk, rw, maxBars) => {
    const key = `${date}|${rk.toFixed(3)}|${rw.toFixed(3)}|${maxBars}`;
    if (!baseline.has(key)) {
      const all = data.map((o, j) => {
        const i = byDate[j].get(date);
        const b = i === undefined ? null : o.daily[i + 1];
        return b ? simulateTrade(o.daily, i + 1, { stop: b.open * (1 - rk), target: b.open * (1 + rw), maxBars })?.grossPct : null;
      }).filter((v) => typeof v === 'number');
      baseline.set(key, mean(all));
    }
    return baseline.get(key);
  };
  data.forEach((s, n) => {
    onStock?.(s.symbol, n + 1, data.length);
    const busyUntil = Object.fromEntries(rules.map((r) => [r.id, -1])); // one open position per stock per rule
    for (let i = from; i < s.daily.length - 1; i += step) {
      const window = s.daily.slice(Math.max(0, i + 1 - DAILY_WINDOW), i + 1);
      const a = analyze({ candles: window, marketState: 'closed' });
      if (a.insufficient) continue;
      const buy = a.verdict.key === 'buy' || a.verdict.key === 'strong_buy';
      if (!buy) continue;
      const ctx = { a, buy, niftyUp: niftyUp(s.daily[i].time) };
      for (const rule of rules) {
        if (i <= busyUntil[rule.id] || !rule.pick(ctx)) continue;
        const entry = s.daily[i + 1].open;
        const signal = a.stats.price;
        const risk = rule.atrStop ? rule.atrStop * a.stats.atr : signal - a.plan.stopLoss;
        const stop = entry - risk;
        const target = rule.rr ? entry + rule.rr * risk : entry + (a.plan.target1 - signal);
        const maxBars = rule.hold ?? hold;
        const t = simulateTrade(s.daily, i + 1, { stop, target, maxBars });
        if (!t) continue;
        // Skip trades that are still open when the data ends: their result is not known yet.
        if (t.how === 'time' && i + maxBars >= s.daily.length) continue;
        busyUntil[rule.id] = i + t.held;
        trades[rule.id].push({ ...t, symbol: s.symbol, day: s.daily[i].time, baselinePct: baselineFor(s.daily[i].time, risk / entry, (target - entry) / entry, maxBars) });
      }
    }
  });
  return { trades };
}

// ---------- long term ----------
export const LONG_RULES = [
  { id: 'trend_score', label: 'Top 5 by long-term trend score (current)', current: true,
    rank: (x) => (x.a.stats.sma200 != null && x.a.stats.price > x.a.stats.sma200 && ['strong_buy', 'buy', 'hold'].includes(x.a.verdict.key) && x.a.longTermScore >= 20 ? x.a.longTermScore + x.a.score / 1000 : null) },
  { id: 'momentum_12_1', label: 'Top 5 by 12-month return (skipping the last month), above 200-day average',
    rank: (x) => (x.a.stats.sma200 != null && x.a.stats.price > x.a.stats.sma200 && x.mom != null ? x.mom : null) },
  { id: 'low_volatility', label: 'Top 5 calmest stocks that are above their 200-day average',
    rank: (x) => (x.a.stats.sma200 != null && x.a.stats.price > x.a.stats.sma200 && x.a.stats.volatility != null ? -x.a.stats.volatility : null) },
];

// Once a month: pick five, hold them for `horizon` trading days, compare with holding all stocks equally.
export function backtestLongTerm(data, index, { rules = LONG_RULES, horizons = [63, 252], from = 300, every = 21, top = 5, cost = COST_PCT.swing } = {}) {
  const byDate = data.map((s) => new Map(s.daily.map((c, i) => [c.time, i])));
  const dates = index.daily.map((c) => c.time);
  const results = Object.fromEntries(rules.map((r) => [r.id, Object.fromEntries(horizons.map((h) => [h, []]))]));
  const maxH = Math.max(...horizons);
  for (let di = from; di < dates.length - Math.min(...horizons) - 1; di += every) {
    const date = dates[di];
    const scored = [];
    data.forEach((s, j) => {
      const i = byDate[j].get(date);
      if (i === undefined || i < 260) return;
      const a = analyze({ candles: s.daily.slice(Math.max(0, i + 1 - DAILY_WINDOW), i + 1), marketState: 'closed' });
      if (a.insufficient) return;
      const mom = (s.daily[i - 21].close / s.daily[i - 252].close - 1) * 100;
      scored.push({ s, i, a, mom });
    });
    for (const h of horizons) {
      if (di + h + 1 >= dates.length) continue;
      const ret = (x) => {
        const entry = x.s.daily[x.i + 1];
        const exit = x.s.daily[x.i + h];
        return entry && exit ? (exit.close / entry.open - 1) * 100 : null;
      };
      const everyone = mean(scored.map(ret).filter((v) => v != null));
      for (const rule of rules) {
        const picks = scored.map((x) => ({ x, v: rule.rank(x) })).filter((p) => p.v != null).sort((p, q) => q.v - p.v).slice(0, top);
        const rs = picks.map((p) => ret(p.x)).filter((v) => v != null);
        if (!rs.length) continue;
        results[rule.id][h].push({ date, pickedPct: mean(rs) - cost, allStocksPct: everyone - cost, worstPickPct: Math.min(...rs) });
      }
    }
    if (di + maxH >= dates.length && di + Math.min(...horizons) >= dates.length) break;
  }
  return results;
}

export function longStats(rows) {
  if (!rows.length) return { periods: 0 };
  const diff = rows.map((r) => r.pickedPct - r.allStocksPct);
  const round = (v) => Math.round(v * 100) / 100;
  return {
    periods: rows.length,
    from: rows[0].date,
    to: rows.at(-1).date,
    avgPickedPct: round(mean(rows.map((r) => r.pickedPct))),
    avgAllStocksPct: round(mean(rows.map((r) => r.allStocksPct))),
    excessPct: round(mean(diff)),
    beatAllStocksRate: round((diff.filter((d) => d > 0).length / diff.length) * 100),
    lostMoneyRate: round((rows.filter((r) => r.pickedPct < 0).length / rows.length) * 100),
    worstPeriodPct: round(Math.min(...rows.map((r) => r.pickedPct))),
    avgWorstSinglePickPct: round(mean(rows.map((r) => r.worstPickPct))),
  };
}

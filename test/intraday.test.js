import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeIntraday, classifyScenario, vwapSeries, relativeVolume, floorPivots, structure, splitDays,
  evaluateBest, buildBoard, indexBias, compactIntraday, intradayPlan, SCENARIOS, MIN_BARS_TODAY,
} from '../lib/intraday.js';
import { normalizeChart } from '../lib/yahoo.js';

// ---------- synthetic 5-minute sessions ----------
// Times are unix seconds already in "exchange-local" terms, like yahoo.js produces.
const SESSION_BARS = 75; // 9:15 – 15:30 on NSE
const dayStart = (n) => Date.UTC(2026, 10, 2 + n) / 1000 + (9 * 60 + 15) * 60; // n = 0 is Mon 2 Nov 2026 (skipping weekends is irrelevant here)

// `path(i, n)` returns the close of bar i as a fraction of the session open price.
function session(dayIndex, { open, path, vol = 100000, volAt = null, range = 0.0012 }) {
  const bars = [];
  let prev = open;
  for (let i = 0; i < SESSION_BARS; i++) {
    const close = open * path(i);
    const o = i === 0 ? open : prev;
    bars.push({
      time: dayStart(dayIndex) + i * 300,
      open: o,
      high: Math.max(o, close) * (1 + range),
      low: Math.min(o, close) * (1 - range),
      close,
      volume: volAt ? volAt(i) : vol,
    });
    prev = close;
  }
  return bars;
}

// Four ordinary, gently rising sessions that end at ~1000.
function history(endPrice = 1000, vol = 100000) {
  const out = [];
  for (let d = 0; d < 4; d++) {
    const open = endPrice * (0.985 + d * 0.004);
    const target = d === 3 ? endPrice : open * 1.002;
    out.push(...session(d, { open, path: (i) => 1 + ((target / open - 1) * i) / (SESSION_BARS - 1) + Math.sin(i / 4) * 0.0015, vol }));
  }
  return out;
}

// Today's session, cut to `n` bars.
function withToday(todayBars, n = todayBars.length, hist = history()) {
  return [...hist, ...todayBars.slice(0, n)];
}
const chartOf = (candles, extra = {}) => ({
  symbol: 'TEST.NS', name: 'Test Co', currency: 'INR', price: candles[candles.length - 1].close, marketState: 'closed', candles, ...extra,
});

// Real price action is choppy, so the paths below add a small oscillation on top of the trend
// (a perfectly smooth climb would give an RSI of 100 and rightly be called "overextended").
const wiggle = (i) => 0.0012 * Math.sin(i * 1.7);

// A tidy morning: flat for 15 minutes, then a choppy climb on rising volume.
const breakoutDay = () => session(4, {
  open: 1001,
  path: (i) => (i < 3 ? 1 + i * 0.0002 : 1.0006 + (i - 3) * 0.0005 + wiggle(i)),
  volAt: (i) => 160000 + i * 2000,
});
const breakdownDay = () => session(4, {
  open: 999,
  path: (i) => (i < 3 ? 1 - i * 0.0002 : 0.9994 - (i - 3) * 0.0005 + wiggle(i)),
  volAt: (i) => 160000 + i * 2000,
});

// ---------- tests ----------
test('splitDays groups 5-minute candles by trading date and ignores daily candles', () => {
  const days = splitDays(withToday(breakoutDay(), 20));
  assert.equal(days.length, 5);
  assert.equal(days[4].bars.length, 20);
  assert.equal(days[0].bars.length, SESSION_BARS);
  assert.deepEqual(splitDays([{ time: '2026-01-01', open: 1, high: 1, low: 1, close: 1, volume: 1 }]), []);
});

test('vwapSeries is the volume-weighted average of typical prices', () => {
  const bars = [
    { high: 10, low: 8, close: 9, volume: 100 }, // typical 9
    { high: 13, low: 11, close: 12, volume: 300 }, // typical 12
  ];
  const v = vwapSeries(bars);
  assert.equal(v[0], 9);
  assert.ok(Math.abs(v[1] - (9 * 100 + 12 * 300) / 400) < 1e-9);
});

test('vwapSeries falls back to a plain average when there is no volume (indices)', () => {
  const v = vwapSeries([
    { high: 10, low: 8, close: 9, volume: 0 },
    { high: 13, low: 11, close: 12, volume: 0 },
  ]);
  assert.equal(v[1], 10.5);
});

test('relativeVolume compares cumulative volume with the same clock time on earlier days', () => {
  // `n` five-minute bars from 09:15, `missing` of them dropped from the end of the first n.
  const mk = (n, vol, day = 0) => Array.from({ length: n }, (_, i) => ({ time: day * 86400 + (9 * 60 + 15) * 60 + i * 300, volume: vol }));
  const prior = [{ bars: mk(75, 100, 1) }, { bars: mk(75, 100, 2) }];
  assert.ok(Math.abs(relativeVolume(mk(20, 200, 3), prior) - 2) < 1e-9);
  assert.ok(Math.abs(relativeVolume(mk(20, 50, 3), prior) - 0.5) < 1e-9);
  assert.equal(relativeVolume(mk(2, 200, 3), prior), null, 'too little data');
  assert.equal(relativeVolume(mk(20, 200, 3), []), null, 'no history');
  // The in-progress bar is ignored while the market is open.
  const today = [...mk(19, 200, 3), { time: 3 * 86400 + (9 * 60 + 15) * 60 + 19 * 300, volume: 1 }];
  assert.ok(Math.abs(relativeVolume(today, prior, true) - 2) < 1e-9);
  // Real feeds are sometimes a bar short (73 vs 74 bars) — still comparable.
  const shortPrior = [{ bars: mk(73, 100, 1) }, { bars: mk(73, 100, 2) }];
  assert.ok(Math.abs(relativeVolume(mk(74, 200, 3), shortPrior) - 2 * 74 / 73) < 1e-6);
  // A half-day with far fewer bars up to the same time is not used.
  assert.equal(relativeVolume(mk(60, 200, 3), [{ bars: mk(20, 100, 1) }]), null);
});

test('floorPivots and structure', () => {
  const p = floorPivots([{ high: 110, low: 90, close: 100 }]);
  assert.equal(p.pivot, 100);
  assert.equal(p.r1, 110);
  assert.equal(p.s1, 90);
  assert.equal(p.r2, 120);
  const mk = (arr) => arr.map(([high, low]) => ({ high, low }));
  assert.equal(structure(mk([[10, 8], [11, 9], [10.5, 8.8], [11, 9], [12, 10], [13, 11], [12.5, 10.5], [13.5, 11.5]])), 1);
  assert.equal(structure(mk([[13.5, 11.5], [13, 11], [13.2, 11.2], [12.5, 10.5], [12, 10], [11, 9], [11.5, 9.5], [10.5, 8.5]])), -1);
  assert.equal(structure(mk([[10, 9]])), 0);
});

test('too early in the session returns a clear "not enough data" result', () => {
  const a = analyzeIntraday(chartOf(withToday(breakoutDay(), MIN_BARS_TODAY - 1)));
  assert.equal(a.insufficient, true);
  assert.equal(a.tooEarly, true);
  assert.match(a.message, /minutes of trading/);
  assert.equal(analyzeIntraday({ candles: [] }).insufficient, true);
});

test('daily-only candles give an "no intraday data" result instead of crashing', () => {
  const a = analyzeIntraday({ candles: [{ time: '2026-01-01', open: 1, high: 2, low: 1, close: 2, volume: 5 }] });
  assert.equal(a.insufficient, true);
  assert.equal(analyzeIntraday(null).insufficient, true);
});

test('morning breakout on rising volume: bullish, ORB scenario, sane buy plan', () => {
  const a = analyzeIntraday(chartOf(withToday(breakoutDay(), 30)));
  assert.equal(a.insufficient, false);
  assert.equal(a.stats.orb, 'above');
  assert.ok(a.stats.vsVwapPct > 0, 'above VWAP');
  assert.ok(a.stats.rvol > 1.2, `rvol ${a.stats.rvol}`);
  assert.ok(a.score >= 50, `score ${a.score}`);
  assert.equal(a.verdict.key, 'strong_buy');
  assert.equal(a.scenario.key, 'orb_breakout');
  assert.equal(a.plan.action, 'buy');
  const p = a.plan;
  assert.ok(p.stopLoss < p.entryLow && p.entryLow <= p.entryHigh, 'stop below entry zone');
  assert.ok(p.entryHigh < p.target1 && p.target1 < p.target2, 'entry < t1 < t2');
  assert.ok(p.riskReward >= 1.5, `R:R ${p.riskReward}`);
  assert.ok(p.riskPct > 0 && p.riskPct < 2, `risk ${p.riskPct}%`);
  assert.ok(p.notes.some((n) => /Square off/i.test(n)));
});

test('morning breakdown: bearish, avoid plan, no buy levels', () => {
  const a = analyzeIntraday(chartOf(withToday(breakdownDay(), 30)));
  assert.equal(a.stats.orb, 'below');
  assert.ok(a.score <= -20, `score ${a.score}`);
  assert.equal(a.scenario.group, 'bear');
  assert.equal(a.plan.action, 'avoid');
  assert.equal(a.plan.entryLow, null);
  assert.equal(a.scenario.buyReady, false);
});

test('gap up that fades below the open is flagged, not bought', () => {
  const fade = session(4, {
    open: 1020, // +2% gap over yesterday's ~1000 close
    path: (i) => 1 - i * 0.0006 + wiggle(i),
    volAt: () => 150000,
  });
  const a = analyzeIntraday(chartOf(withToday(fade, 30)));
  assert.ok(a.stats.gapPct > 1, `gap ${a.stats.gapPct}`);
  assert.equal(a.scenario.key, 'gap_up_fade');
  assert.equal(a.plan.action, 'avoid');
});

test('gap up that holds and keeps climbing is a buy scenario', () => {
  const hold = session(4, {
    open: 1015,
    path: (i) => 1 + i * 0.0003 + wiggle(i),
    volAt: (i) => 170000 + i * 1000,
  });
  const a = analyzeIntraday(chartOf(withToday(hold, 36)));
  assert.ok(a.stats.gapPct >= 0.5);
  assert.ok(a.scenario.buyReady, a.scenario.key);
  assert.ok(['orb_breakout', 'gap_up_hold', 'trend_up', 'vwap_pullback'].includes(a.scenario.key), a.scenario.key);
});

test('quiet sideways day on thin volume is not a buy', () => {
  const quiet = session(4, { open: 1000, path: (i) => 1 + Math.sin(i / 3) * 0.0006, vol: 40000, range: 0.0004 });
  const a = analyzeIntraday(chartOf(withToday(quiet, 40)));
  assert.ok(Math.abs(a.score) < 50, `score ${a.score}`);
  assert.ok(['low_volume', 'range_bound', 'building', 'weak_below_vwap'].includes(a.scenario.key), a.scenario.key);
  assert.notEqual(a.plan.action, 'buy');
});

test('a stock that has run far above VWAP is called overextended instead of a buy', () => {
  const rocket = session(4, { open: 1000, path: (i) => 1 + i * 0.004, volAt: () => 300000 });
  const a = analyzeIntraday(chartOf(withToday(rocket, 40)));
  assert.equal(a.scenario.key, 'overextended');
  assert.notEqual(a.plan.action, 'buy');
});

test('classifyScenario covers each branch and always returns a known scenario', () => {
  const base = { price: 100, vwap: 99, open: 99.5, e9: 100, e21: 99.5, rsi: 60, rvol: 1.5, gapPct: 0, orb: 'inside', struct: 0, atr5: 0.2, dayHigh: 100.1 };
  const cases = [
    [{ orb: 'above' }, 'orb_breakout'],
    [{ gapPct: 1 }, 'gap_up_hold'],
    [{ gapPct: -1 }, 'gap_down_reversal'],
    [{ vwap: 99.8, dayHigh: 100.6 }, 'vwap_pullback'],
    [{ struct: 1 }, 'trend_up'],
    [{ rsi: 85, price: 103 }, 'overextended'],
    [{ price: 98, orb: 'below', e9: 98.5, e21: 99 }, 'orb_breakdown'],
    [{ price: 98, gapPct: 1, open: 99.5, e9: 98.5, e21: 99 }, 'gap_up_fade'],
    [{ price: 98, gapPct: -1, open: 99.5, e9: 98.5, e21: 99 }, 'gap_down_continue'],
    [{ price: 98, struct: -1, e9: 98.5, e21: 99 }, 'trend_down'],
    [{ price: 98, rsi: 25, e9: 99.5, e21: 99 }, 'oversold_bounce'],
    [{ rvol: 0.4, price: 99, vwap: 99, e9: 99, e21: 99 }, 'low_volume'],
    [{ price: 98, e9: 98.5, e21: 99 }, 'weak_below_vwap'],
    [{}, 'building'],
    [{ price: 99, e9: 99, e21: 99.5 }, 'range_bound'],
  ];
  for (const [over, want] of cases) {
    assert.equal(classifyScenario({ ...base, ...over }).key, want, JSON.stringify(over));
  }
  // Every scenario that exists is exercised above, and each has the fields the UI needs.
  assert.deepEqual([...new Set(cases.map((c) => c[1]))].sort(), Object.keys(SCENARIOS).sort());
  for (const s of Object.values(SCENARIOS)) {
    assert.ok(s.label && s.blurb && ['bull', 'wait', 'bear'].includes(s.group));
    if (s.buyReady) assert.equal(s.bias, 'bullish');
  }
});

test('score always stays within -100..100 and every output is finite', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const slope = (seed % 9 - 4) * 0.0012;
    const day = session(4, { open: 1000 * (1 + ((seed % 5) - 2) * 0.01), path: (i) => 1 + i * slope + Math.sin(i * seed) * 0.002, volAt: (i) => 50000 + ((i * seed * 7919) % 200000) });
    const a = analyzeIntraday(chartOf(withToday(day, 20 + (seed % 50))));
    assert.ok(a.score >= -100 && a.score <= 100, `score ${a.score}`);
    for (const k of ['stopLoss', 'target1', 'target2', 'riskReward']) assert.ok(Number.isFinite(a.plan[k]), `${k} for seed ${seed}`);
    assert.ok(a.plan.stopLoss < a.stats.price, 'stop below price');
    assert.ok(a.plan.target1 > a.stats.price, 'target above price');
  }
});

test('index data without volume still analyses (VWAP approximated, no volume factor)', () => {
  const noVol = (bars) => bars.map((b) => ({ ...b, volume: 0 }));
  const candles = noVol(withToday(breakoutDay(), 30));
  const a = analyzeIntraday(chartOf(candles));
  assert.equal(a.insufficient, false);
  assert.equal(a.stats.volumeAvailable, false);
  assert.equal(a.stats.rvol, null);
  assert.ok(!a.factors.some((f) => f.key === 'volume'));
  assert.ok(Number.isFinite(a.stats.vwap));
});

test('intradayPlan keeps risk inside sane bounds and measures room to the next real resistance', () => {
  const bars = Array.from({ length: 10 }, (_, i) => ({ low: 99 + i * 0.05, high: 100 + i * 0.05 }));
  const p = intradayPlan(101, 0.2, { bars, vwap: 100.4, orh: 100.2, resistances: [101.2, 103, 105] });
  assert.ok(p.stopLoss < 101);
  assert.ok(p.riskPct >= 0.3 - 1e-9 && p.riskPct <= 1.2 + 1e-9, `riskPct ${p.riskPct}`);
  assert.ok(p.target1 > 101 && p.target2 > p.target1);
  assert.ok(p.room < 1.5, 'close resistance at 101.2 blocks the path');
  assert.ok(p.riskReward >= 1.5);
  // Today's high right above price (a stock near its high) is not an obstacle...
  const q = intradayPlan(101, 0.2, { bars, vwap: 100.4, orh: 100.2, resistances: [], softResistances: [101.4] });
  assert.equal(q.room, null);
  assert.equal(q.nearestResistance, null);
  // ...but can still be chosen as a target when it is far enough away.
  const far = intradayPlan(101, 0.2, { bars, vwap: 100.4, orh: 100.2, resistances: [], softResistances: [102.2] });
  assert.ok(Math.abs(far.target1 - 102.2) < 1e-9, `target1 ${far.target1}`);
});

test('thin volume lowers conviction for a move, instead of adding to it', () => {
  const mk = (volAt) => analyzeIntraday(chartOf(withToday(session(4, {
    open: 1001, path: (i) => (i < 3 ? 1 + i * 0.0002 : 1.0006 + (i - 3) * 0.0005 + wiggle(i)), volAt,
  }), 30)));
  const heavy = mk((i) => 160000 + i * 2000);
  const thin = mk(() => 30000);
  assert.ok(thin.stats.rvol < 0.7, `rvol ${thin.stats.rvol}`);
  const f = thin.factors.find((x) => x.key === 'volume');
  assert.ok(f.points < 0, 'rising on thin volume is a negative');
  assert.ok(thin.score < heavy.score);
});

test('late in the session the plan warns against starting a new trade', () => {
  const a = analyzeIntraday(chartOf(withToday(breakoutDay(), 30), { marketState: 'open' }), { minutesLeft: 20 });
  assert.equal(a.marketOpen, true);
  assert.ok(a.plan.notes.some((n) => /too late/i.test(n)));
});

// ---------- best of the best ----------
const goodItem = () => {
  const intraday = compactIntraday(analyzeIntraday(chartOf(withToday(breakoutDay(), 30))));
  return {
    symbol: 'AAA.NS', name: 'Alpha', price: intraday.stats.price, intraday,
    daily: { score: 62, verdict: { key: 'strong_buy', label: 'Strong Buy' } },
  };
};

test('a clean setup passes every best-of-the-best check', () => {
  const r = evaluateBest(goodItem(), { marketBias: { name: 'NIFTY 50', bias: 'bullish' }, marketOpen: true, minutesLeft: 200 });
  assert.equal(r.passed, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.equal(r.passCount, r.total);
  assert.ok(r.checks.length >= 10, 'market and time checks are included when known');
});

test('each check can individually knock a stock out', () => {
  const ok = { marketBias: { name: 'NIFTY 50', bias: 'neutral' }, marketOpen: true, minutesLeft: 200 };
  const failing = (mutate, ctx = ok) => {
    const it = goodItem();
    mutate(it);
    const r = evaluateBest(it, ctx);
    return r.checks.filter((c) => !c.ok).map((c) => c.key);
  };
  assert.deepEqual(failing(() => {}), []);
  assert.deepEqual(failing((it) => { it.daily = { score: 0, verdict: { key: 'hold', label: 'Hold / Wait' } }; }), ['daily']);
  assert.deepEqual(failing((it) => { it.daily = null; }), ['daily']);
  assert.deepEqual(failing(() => {}, { ...ok, marketBias: { name: 'NIFTY 50', bias: 'bearish' } }), ['market']);
  assert.deepEqual(failing(() => {}, { ...ok, minutesLeft: 30 }), ['time']);
  assert.ok(failing((it) => { it.intraday.stats.rvol = 0.8; }).includes('volume'));
  assert.ok(failing((it) => { it.intraday.stats.rvol = null; }).includes('volume'));
  assert.ok(failing((it) => { it.intraday.stats.rsi = 82; }).includes('rsi'));
  assert.ok(failing((it) => { it.intraday.stats.rsi = 48; }).includes('rsi'));
  assert.ok(failing((it) => { it.intraday.stats.vsVwapPct = -0.2; }).includes('vwap'));
  assert.ok(failing((it) => { it.intraday.stats.ema9 = 90; }).includes('trend'));
  assert.ok(failing((it) => { it.intraday.plan.room = 0.8; }).includes('room'));
  assert.ok(failing((it) => { it.intraday.score = 40; }).includes('score'));
  assert.ok(failing((it) => { it.intraday.scenario = { ...it.intraday.scenario, buyReady: false }; }).includes('scenario'));
  // When it's after hours the time check is not applied at all.
  const closed = evaluateBest(goodItem(), { marketBias: { bias: 'neutral' }, marketOpen: false, minutesLeft: null });
  assert.ok(!closed.checks.some((c) => c.key === 'time'));
  // Unknown market direction (index fetch failed) does not block, and adds no check.
  assert.ok(!evaluateBest(goodItem(), {}).checks.some((c) => c.key === 'market'));
});

test('stocks without intraday data are never "best"', () => {
  assert.equal(evaluateBest({ intraday: null }).passed, false);
  assert.equal(evaluateBest({ intraday: { insufficient: true } }).passed, false);
});

test('buildBoard ranks passing stocks, falls back to near misses and lists Strong Buys', () => {
  const mk = (symbol, over = {}) => {
    const it = goodItem();
    it.symbol = symbol;
    it.name = symbol;
    Object.assign(it, over);
    return it;
  };
  const strong = mk('STRONG');
  const weaker = mk('WEAKER');
  weaker.intraday = { ...weaker.intraday, score: 55, stats: { ...weaker.intraday.stats, rvol: 1.3 } };
  const noDaily = mk('NODAILY', { daily: { score: 5, verdict: { key: 'hold', label: 'Hold / Wait' } } });
  const bear = mk('BEAR');
  bear.intraday = { ...bear.intraday, score: -60, verdict: { key: 'strong_sell', label: 'Strong Sell' }, scenario: { key: 'orb_breakdown', ...SCENARIOS.orb_breakdown } };
  bear.daily = { score: -70, verdict: { key: 'strong_sell', label: 'Strong Sell' } };
  const tooEarly = { symbol: 'EARLY', name: 'EARLY', intraday: { insufficient: true }, daily: null };

  const ctx = { marketBias: { name: 'NIFTY 50', bias: 'bullish' }, marketOpen: false };
  const board = buildBoard([weaker, noDaily, bear, strong, tooEarly], ctx);
  assert.deepEqual(board.best.map((x) => x.symbol), ['STRONG', 'WEAKER'], 'passing stocks ranked by conviction');
  assert.deepEqual(board.nearMisses, [], 'no near misses when something passed');
  assert.deepEqual(board.strongBuyDaily.map((x) => x.symbol).sort(), ['STRONG', 'WEAKER']);
  assert.deepEqual(board.strongBuyIntraday.map((x) => x.symbol).sort(), ['NODAILY', 'STRONG', 'WEAKER']);
  assert.equal(board.counts.orb_breakout, 3);
  assert.equal(board.counts.orb_breakdown, 1);
  assert.equal(board.items.length, 5);

  // A bearish market blocks everything — near misses explain why.
  const weak = buildBoard([strong, noDaily, bear], { ...ctx, marketBias: { name: 'NIFTY 50', bias: 'bearish' } });
  assert.deepEqual(weak.best, []);
  assert.equal(weak.nearMisses[0].symbol, 'STRONG');
  assert.ok(weak.nearMisses[0].best.checks.some((c) => c.key === 'market' && !c.ok));
  assert.ok(!weak.nearMisses.some((x) => x.symbol === 'BEAR'), 'sell-rated stocks are not near misses');

  // No Strong Buy on the daily chart -> the closest "Buy" ones are offered instead.
  const buyOnly = mk('BUYONLY', { daily: { score: 35, verdict: { key: 'buy', label: 'Buy' } } });
  const none = buildBoard([buyOnly], ctx);
  assert.deepEqual(none.strongBuyDaily, []);
  assert.deepEqual(none.closestDaily.map((x) => x.symbol), ['BUYONLY']);
});

// ---------- market direction ----------
test('indexBias reads the index trend', () => {
  assert.equal(indexBias(chartOf(withToday(breakoutDay(), 40)), 'NIFTY 50').bias, 'bullish');
  assert.equal(indexBias(chartOf(withToday(breakdownDay(), 40)), 'NIFTY 50').bias, 'bearish');
  const flat = session(4, { open: 1000, path: (i) => 1 + Math.sin(i / 2) * 0.0003 });
  assert.equal(indexBias(chartOf(withToday(flat, 40)), 'NIFTY 50').bias, 'neutral');
  const early = indexBias(chartOf(withToday(breakoutDay(), 3)), 'NIFTY 50');
  assert.equal(early.bias, 'unknown');
});

// ---------- data layer ----------
test('normalizeChart exposes the end of the trading session', () => {
  const end = Math.floor(Date.now() / 1000) + 3600;
  const body = {
    chart: { result: [{ meta: { symbol: 'X', gmtoffset: 0, regularMarketPrice: 10, currentTradingPeriod: { regular: { start: end - 20000, end } } },
      timestamp: [end - 600, end - 300], indicators: { quote: [{ open: [9, 10], high: [10, 11], low: [9, 10], close: [10, 10], volume: [1, 1] }] } }] },
  };
  const c = normalizeChart(body, 'X', { step: 300 });
  assert.equal(c.sessionEnd, end * 1000);
  assert.equal(c.marketState, 'open');
  const noPeriod = normalizeChart({ chart: { result: [{ meta: { symbol: 'X', regularMarketPrice: 10 }, timestamp: [1700000000], indicators: { quote: [{ open: [9], high: [10], low: [9], close: [10], volume: [1] }] } }] } }, 'X');
  assert.equal(noPeriod.sessionEnd, null);
});

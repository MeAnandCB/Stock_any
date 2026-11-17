import { sma, rsi, macd, bollinger, atr, pivots } from './indicators.js';

export const MIN_BARS = 30;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const round = (v, d = 2) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const pct = (a, b) => (isNum(a) && isNum(b) && b !== 0 ? ((a - b) / b) * 100 : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function computeSeries(candles) {
  const closes = candles.map((c) => c.close);
  return {
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    bb: bollinger(closes, 20, 2),
    rsi: rsi(closes, 14),
    macd: macd(closes),
    atr: atr(candles, 14),
  };
}

function returnOver(closes, bars) {
  const n = closes.length;
  if (n <= bars) return null;
  return pct(closes[n - 1], closes[n - 1 - bars]);
}

// Annualised volatility (%) from daily log returns.
export function volatility(closes, bars = 252) {
  const s = closes.slice(-(bars + 1));
  if (s.length < 21) return null;
  const r = [];
  for (let i = 1; i < s.length; i++) if (s[i - 1] > 0 && s[i] > 0) r.push(Math.log(s[i] / s[i - 1]));
  if (r.length < 20) return null;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

// Simple candlestick patterns on the latest bar(s).
export function detectPattern(candles, sma20Last) {
  const n = candles.length;
  if (n < 2) return null;
  const c = candles[n - 1];
  const p = candles[n - 2];
  const range = c.high - c.low;
  if (range <= 0) return null;
  const body = Math.abs(c.close - c.open);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  const afterDrop = isNum(sma20Last) && c.close < sma20Last;
  const afterRise = isNum(sma20Last) && c.close > sma20Last;

  const prevRed = p.close < p.open;
  const prevGreen = p.close > p.open;
  const green = c.close > c.open;
  const red = c.close < c.open;

  if (prevRed && green && c.open <= p.close && c.close >= p.open && body > Math.abs(p.close - p.open)) {
    return { name: 'Bullish Engulfing', bias: 'bullish', text: 'Today\'s green candle fully covers yesterday\'s red one — buyers took control.' };
  }
  if (prevGreen && red && c.open >= p.close && c.close <= p.open && body > Math.abs(p.close - p.open)) {
    return { name: 'Bearish Engulfing', bias: 'bearish', text: 'Today\'s red candle fully covers yesterday\'s green one — sellers took control.' };
  }
  if (body > 0 && lower >= 2 * body && upper <= body && afterDrop) {
    return { name: 'Hammer', bias: 'bullish', text: 'Long lower wick after a fall — sellers pushed down but buyers pushed it back up. Possible bounce.' };
  }
  if (body > 0 && upper >= 2 * body && lower <= body && afterRise) {
    return { name: 'Shooting Star', bias: 'bearish', text: 'Long upper wick after a rise — buyers pushed up but sellers pushed it back down. Possible pullback.' };
  }
  if (body <= 0.1 * range) {
    return { name: 'Doji', bias: 'neutral', text: 'Open and close are almost equal — buyers and sellers are undecided.' };
  }
  return null;
}

// Merge price levels that are within `tol` of each other.
function cluster(levels, tol) {
  const sorted = [...levels].sort((a, b) => a - b);
  const groups = [];
  for (const v of sorted) {
    const g = groups[groups.length - 1];
    if (g && v - g[g.length - 1] <= tol) g.push(v);
    else groups.push([v]);
  }
  // Levels touched more often are stronger; return the group average.
  return groups.map((g) => ({ price: g.reduce((a, b) => a + b, 0) / g.length, touches: g.length }));
}

export function findLevels(candles, price, a) {
  const recent = candles.slice(-150);
  const { highs, lows } = pivots(recent, 4);
  const tol = 0.6 * a;
  let supports = cluster(lows.filter((v) => v < price - 0.1 * a), tol)
    .sort((x, y) => y.price - x.price)
    .slice(0, 3)
    .map((l) => l.price);
  let resistances = cluster(highs.filter((v) => v > price + 0.1 * a), tol)
    .sort((x, y) => x.price - y.price)
    .slice(0, 3)
    .map((l) => l.price);

  if (!supports.length) {
    const lo = Math.min(...recent.slice(-60).map((c) => c.low));
    supports = [lo < price - 0.1 * a ? lo : price - 2 * a];
  }
  if (!resistances.length) {
    const hi = Math.max(...recent.map((c) => c.high));
    resistances = [hi > price + 0.1 * a ? hi : price + 3 * a];
  }
  return { supports, resistances };
}

// Build a trade plan for a hypothetical entry price using ATR-based risk and
// nearby support / resistance.
export function planFrom(entry, a, supports, resistances) {
  let stop = entry - 2 * a;
  const sup = supports.find((s) => s < entry - 0.3 * a);
  if (sup != null) {
    const cand = sup - 0.5 * a;
    if (cand >= entry - 3 * a && cand <= entry - 0.75 * a) stop = cand;
  }
  const risk = entry - stop;
  const above = resistances.filter((r) => r > entry).sort((x, y) => x - y);
  const t1 = above.find((r) => r - entry >= 1.5 * risk && r - entry <= 4 * risk) ?? entry + 2 * risk;
  const t2 =
    above.find((r) => r > t1 + 0.75 * risk && r - entry <= 6 * risk) ?? Math.max(entry + 3 * risk, t1 + risk);
  const blocking = above.find((r) => r < t1 - 0.1 * a) ?? null;
  return {
    entry,
    stopLoss: stop,
    target1: t1,
    target2: t2,
    riskReward: (t1 - entry) / risk,
    riskPct: (risk / entry) * 100,
    blocking,
  };
}

const VERDICTS = [
  { min: 50, key: 'strong_buy', label: 'Strong Buy', summary: 'Most indicators are positive. The trend is up and momentum is strong.' },
  { min: 20, key: 'buy', label: 'Buy', summary: 'More indicators are positive than negative. Conditions look favourable — always use a stop-loss.' },
  { min: -20, key: 'hold', label: 'Hold / Wait', summary: 'Signals are mixed. It is usually wiser to wait for a clearer direction before buying.' },
  { min: -50, key: 'sell', label: 'Sell / Avoid', summary: 'More indicators are negative. The price is weak — avoid buying for now.' },
  { min: -Infinity, key: 'strong_sell', label: 'Strong Sell', summary: 'Most indicators are negative. The stock is in a clear downtrend.' },
];

export function verdictFor(score) {
  return VERDICTS.find((v) => score >= v.min);
}

export function analyze(chart) {
  const candles = chart?.candles ?? [];
  if (candles.length < MIN_BARS) {
    return {
      insufficient: true,
      message: `Only ${candles.length} days of price history available — at least ${MIN_BARS} are needed for analysis (new listings often have too little data).`,
      series: null,
    };
  }

  const s = computeSeries(candles);
  const closes = candles.map((c) => c.close);
  const n = candles.length;
  const L = n - 1;
  const price = closes[L];
  const prev = closes[L - 1];
  // Guard against a zero ATR (e.g. suspended / flat stock).
  const a = Math.max(s.atr[L] ?? 0, price * 0.005);

  const sma20 = s.sma20[L];
  const sma50 = s.sma50[L];
  const sma200 = s.sma200[L];
  const r = s.rsi[L];
  const mLine = s.macd.line[L];
  const mSig = s.macd.signal[L];
  const bbU = s.bb.upper[L];
  const bbL = s.bb.lower[L];

  const factors = [];
  const add = (key, label, weight, points, text) => {
    const verdict = points > 0 ? 'bullish' : points < 0 ? 'bearish' : 'neutral';
    factors.push({ key, label, weight, points, verdict, text });
  };

  // 1. Long-term trend
  if (isNum(sma200)) {
    add('trend_long', 'Long-term trend (200-day average)', 2, price > sma200 ? 2 : -2,
      price > sma200
        ? `Price is above its 200-day average (${round(sma200)}). The long-term trend is UP.`
        : `Price is below its 200-day average (${round(sma200)}). The long-term trend is DOWN.`);
  }

  // 2. Medium-term trend
  if (isNum(sma50)) {
    add('trend_mid', 'Medium-term trend (50-day average)', 1.5, price > sma50 ? 1.5 : -1.5,
      price > sma50
        ? `Price is above its 50-day average (${round(sma50)}) — the last few months are positive.`
        : `Price is below its 50-day average (${round(sma50)}) — the last few months are weak.`);
  }

  // 3. Golden / death cross
  if (isNum(sma50) && isNum(sma200)) {
    let crossNote = '';
    for (let i = Math.max(1, L - 20); i <= L; i++) {
      const a0 = s.sma50[i - 1], b0 = s.sma200[i - 1], a1 = s.sma50[i], b1 = s.sma200[i];
      if ([a0, b0, a1, b1].every(isNum)) {
        if (a0 <= b0 && a1 > b1) crossNote = ' A "Golden Cross" happened recently — a classic bullish signal.';
        if (a0 >= b0 && a1 < b1) crossNote = ' A "Death Cross" happened recently — a classic bearish signal.';
      }
    }
    add('cross', 'Moving-average alignment', 1, sma50 > sma200 ? 1 : -1,
      (sma50 > sma200
        ? 'The 50-day average is above the 200-day average (healthy uptrend structure).'
        : 'The 50-day average is below the 200-day average (downtrend structure).') + crossNote);
  }

  // 4. Short-term trend
  if (isNum(sma20) && isNum(sma50)) {
    add('trend_short', 'Short-term trend (20 vs 50 day)', 1, sma20 > sma50 ? 1 : -1,
      sma20 > sma50
        ? 'The 20-day average is above the 50-day — short-term momentum is building up.'
        : 'The 20-day average is below the 50-day — short-term momentum is fading.');
  }

  // 5. RSI
  if (isNum(r)) {
    let pts, text;
    if (r < 30) { pts = 1; text = `RSI is ${round(r, 0)} (below 30 = "oversold"). The stock has fallen a lot and may bounce — but wait for confirmation.`; }
    else if (r < 45) { pts = -0.5; text = `RSI is ${round(r, 0)} — momentum is weak.`; }
    else if (r < 55) { pts = 0; text = `RSI is ${round(r, 0)} — neutral momentum.`; }
    else if (r < 70) { pts = 1; text = `RSI is ${round(r, 0)} — healthy positive momentum.`; }
    else { pts = -1; text = `RSI is ${round(r, 0)} (above 70 = "overbought"). The stock rose fast and may cool down — risky to chase.`; }
    add('rsi', 'RSI (momentum)', 1, pts, text);
  }

  // 6. MACD
  if (isNum(mLine) && isNum(mSig)) {
    let crossNote = '';
    for (let i = Math.max(1, L - 4); i <= L; i++) {
      const p0 = s.macd.hist[i - 1], p1 = s.macd.hist[i];
      if (isNum(p0) && isNum(p1)) {
        if (p0 <= 0 && p1 > 0) crossNote = ' It just crossed UP — a fresh buy signal.';
        if (p0 >= 0 && p1 < 0) crossNote = ' It just crossed DOWN — a fresh sell signal.';
      }
    }
    add('macd', 'MACD (trend momentum)', 1.5, mLine > mSig ? 1.5 : -1.5,
      (mLine > mSig ? 'MACD is above its signal line — momentum is positive.' : 'MACD is below its signal line — momentum is negative.') + crossNote);
  }

  // 7. Bollinger Bands
  if (isNum(bbU) && isNum(bbL)) {
    let pts = 0, text = 'Price is inside its normal range (Bollinger Bands).';
    if (price < bbL) { pts = 0.5; text = 'Price dropped below its lower Bollinger Band — it is stretched down and often snaps back.'; }
    else if (price > bbU) { pts = -0.5; text = 'Price is above its upper Bollinger Band — it is stretched up and may pull back.'; }
    add('bollinger', 'Bollinger Bands (price range)', 0.5, pts, text);
  }

  // 8. Volume confirmation
  const vols = candles.slice(-21, -1).map((c) => c.volume).filter((v) => v > 0);
  const avgVol = vols.length ? vols.reduce((x, y) => x + y, 0) / vols.length : null;
  const lastVol = candles[L].volume;
  if (avgVol && lastVol > 0) {
    const ratio = lastVol / avgVol;
    let pts = 0, text = `Volume is normal (${round(ratio, 1)}× the 20-day average).`;
    if (ratio >= 1.5 && price > prev) { pts = 1; text = `Heavy buying: volume is ${round(ratio, 1)}× normal on an up day — strong interest from buyers.`; }
    else if (ratio >= 1.5 && price < prev) { pts = -1; text = `Heavy selling: volume is ${round(ratio, 1)}× normal on a down day — strong selling pressure.`; }
    add('volume', 'Volume', 1, pts, text);
  }

  // 9. 1-month momentum
  const ret1m = returnOver(closes, 21);
  if (isNum(ret1m)) {
    const pts = ret1m > 5 ? 1 : ret1m < -5 ? -1 : 0;
    add('momentum', '1-month performance', 1, pts,
      `The stock is ${ret1m >= 0 ? 'up' : 'down'} ${round(Math.abs(ret1m), 1)}% over the last month.`);
  }

  // 10. Candlestick pattern
  const pattern = detectPattern(candles, sma20);
  if (pattern) {
    add('pattern', `Candle pattern: ${pattern.name}`, 0.5, pattern.bias === 'bullish' ? 0.5 : pattern.bias === 'bearish' ? -0.5 : 0, pattern.text);
  }

  const maxScore = factors.reduce((t, f) => t + f.weight, 0) || 1;
  const total = factors.reduce((t, f) => t + f.points, 0);
  const score = Math.round(clamp((total / maxScore) * 100, -100, 100));
  const verdict = verdictFor(score);
  const bull = factors.filter((f) => f.verdict === 'bullish').length;
  const bear = factors.filter((f) => f.verdict === 'bearish').length;
  const agreement = factors.length ? Math.abs(bull - bear) / factors.length : 0;
  const confidence = agreement >= 0.6 ? 'High' : agreement >= 0.3 ? 'Medium' : 'Low';

  // Levels & trade plan
  const { supports, resistances } = findLevels(candles, price, a);
  let plan;
  if (verdict.key === 'strong_buy' || verdict.key === 'buy') {
    const p = planFrom(price, a, supports, resistances);
    const entryLow = Math.max(price - 0.5 * a, p.stopLoss + 0.5 * (price - p.stopLoss));
    plan = {
      action: 'buy',
      headline: 'Possible BUY setup',
      entryLow, entryHigh: price, ...p,
      notes: [
        `Buy zone: between ${round(entryLow)} and ${round(price)}. Avoid chasing far above this.`,
        `Place a stop-loss at ${round(p.stopLoss)} (${round(p.riskPct, 1)}% below entry). If price closes below it, exit — this limits your loss.`,
        `Book partial profit near Target 1 (${round(p.target1)}) and the rest near Target 2 (${round(p.target2)}).`,
      ],
    };
    if (p.blocking) plan.notes.push(`Watch out: resistance near ${round(p.blocking)} may slow the price before Target 1.`);
    if (isNum(r) && r >= 70) plan.notes.push('RSI is overbought — consider waiting for a small dip before buying.');
  } else if (verdict.key === 'hold') {
    const sup = supports[0];
    const res = resistances[0];
    const useSupport = sup != null && sup > price - 3 * a;
    const entry = useSupport ? sup : price;
    const p = planFrom(entry, a, supports.filter((x) => x < entry - 0.1 * a), resistances);
    plan = {
      action: 'wait',
      headline: 'WAIT for a better entry',
      entryLow: entry - 0.25 * a, entryHigh: entry + 0.25 * a, ...p,
      notes: [
        useSupport
          ? `Better entry: if the price dips to support near ${round(sup)} and holds there, it may be a lower-risk buy.`
          : 'No nearby support — wait for the trend to become clearer.',
        `Or wait for a breakout: a daily close above resistance ${round(res)} with high volume is a bullish sign.`,
        `If you already own it, keep a stop-loss near ${round(p.stopLoss)}.`,
      ],
    };
  } else {
    const sup = supports[0];
    const exitLevel = sup != null && sup > price - 3 * a ? sup - 0.25 * a : price - 1.5 * a;
    const p = planFrom(price, a, supports, resistances);
    plan = {
      action: 'avoid',
      headline: 'AVOID buying now',
      ...p,
      entryLow: null, entryHigh: null,
      exitLevel,
      notes: [
        'The trend is down — buying a falling stock ("catching a falling knife") is risky for beginners.',
        `If you own it: consider exiting or protect your capital with a stop-loss near ${round(exitLevel)}.`,
        `Re-check when the price closes back above the 50-day average${isNum(sma50) ? ` (${round(sma50)})` : ''}.`,
      ],
    };
    plan.stopLoss = exitLevel;
  }

  const closes252 = closes.slice(-252);
  const candles252 = candles.slice(-252);
  const stats = {
    price: round(price, 4),
    high52: round(Math.max(...candles252.map((c) => c.high)), 4),
    low52: round(Math.min(...candles252.map((c) => c.low)), 4),
    ret1w: round(returnOver(closes, 5)),
    ret1m: round(ret1m),
    ret3m: round(returnOver(closes, 63)),
    ret6m: round(returnOver(closes, 126)),
    ret1y: round(returnOver(closes, 252)),
    volatility: round(volatility(closes)),
    avgVolume: avgVol ? Math.round(avgVol) : null,
    atr: round(a, 4),
    rsi: round(r, 1),
    sma20: round(sma20, 4),
    sma50: round(sma50, 4),
    sma200: round(sma200, 4),
  };
  stats.fromHigh52 = round(pct(price, stats.high52));
  stats.fromLow52 = round(pct(price, stats.low52));
  stats.rangePos = stats.high52 > stats.low52 ? round(((price - stats.low52) / (stats.high52 - stats.low52)) * 100, 0) : null;

  // Long-term trend strength (used for the "long-term" ranking).
  let lt = 0;
  if (isNum(sma200)) lt += price > sma200 ? 30 : -30;
  if (isNum(sma50) && isNum(sma200)) lt += sma50 > sma200 ? 20 : -20;
  const ret1y = returnOver(closes, 252) ?? returnOver(closes, closes252.length - 1);
  if (isNum(ret1y)) lt += clamp(ret1y, -50, 50) * 0.6;
  const vol = volatility(closes);
  if (isNum(vol)) lt -= Math.max(0, vol - 30) * 0.5;
  const longTermScore = Math.round(clamp(lt, -100, 100));

  const roundPlan = Object.fromEntries(
    Object.entries(plan).map(([k, v]) => [k, typeof v === 'number' ? round(v, 4) : v])
  );

  return {
    insufficient: false,
    score,
    verdict: { key: verdict.key, label: verdict.label, summary: verdict.summary },
    confidence,
    bullishCount: bull,
    bearishCount: bear,
    factors,
    pattern,
    levels: { supports: supports.map((v) => round(v, 4)), resistances: resistances.map((v) => round(v, 4)) },
    plan: roundPlan,
    stats,
    longTermScore,
    series: s,
  };
}

// Compact summary used for scans, watchlists and the dashboard.
export function summarize(chart) {
  const base = {
    symbol: chart.symbol,
    name: chart.name,
    currency: chart.currency,
    price: chart.price,
    change: chart.change,
    changePct: chart.changePct,
    marketState: chart.marketState,
    spark: chart.candles.slice(-30).map((c) => round(c.close, 4)),
  };
  const a = analyze(chart);
  if (a.insufficient) return { ...base, insufficient: true, message: a.message };
  return {
    ...base,
    score: a.score,
    verdict: a.verdict,
    confidence: a.confidence,
    longTermScore: a.longTermScore,
    rsi: a.stats.rsi,
    ret1m: a.stats.ret1m,
    ret1y: a.stats.ret1y,
    volatility: a.stats.volatility,
    aboveSma50: isNum(a.stats.sma50) ? chart.candles[chart.candles.length - 1].close > a.stats.sma50 : null,
    aboveSma200: isNum(a.stats.sma200) ? chart.candles[chart.candles.length - 1].close > a.stats.sma200 : null,
    plan: {
      action: a.plan.action,
      entryLow: a.plan.entryLow,
      entryHigh: a.plan.entryHigh,
      stopLoss: a.plan.stopLoss,
      target1: a.plan.target1,
      riskReward: a.plan.riskReward,
    },
  };
}

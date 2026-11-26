// Intraday (same-day) analysis on 5-minute candles.
//
// Pure functions only (no network) so everything here is unit-tested with
// synthetic candles. Candle `time` values are unix seconds already shifted to
// exchange-local time (see yahoo.js), so the UTC date of a candle is the
// trading date on that exchange.
import { ema, rsi, macd, atr } from './indicators.js';
import { verdictFor, round, summarize } from './analysis.js';

export const BAR_MINUTES = 5;
export const MIN_BARS_TODAY = 6; // 30 minutes of trading before signals are meaningful
export const OPENING_RANGE_BARS = 3; // first 15 minutes
export const MIN_MINUTES_LEFT = 45; // don't suggest fresh intraday buys with less time than this left

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pct = (a, b) => (isNum(a) && isNum(b) && b !== 0 ? ((a - b) / b) * 100 : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dayKey = (t) => new Date(t * 1000).toISOString().slice(0, 10);

// ---------- scenarios ----------
// Every stock is placed in exactly one scenario. `group` drives the colour in
// the UI; `buyReady` marks the scenarios where a long (buy) trade can be
// considered at all.
export const SCENARIOS = {
  orb_breakout: {
    label: 'Opening-range breakout', group: 'bull', bias: 'bullish', buyReady: true, action: 'Buy',
    blurb: 'Price has broken above the high of the first 15 minutes, sits above VWAP, and the 9 EMA is above the 21 EMA. Buyers are in control — the classic intraday buy.',
  },
  gap_up_hold: {
    label: 'Gap-up holding', group: 'bull', bias: 'bullish', buyReady: true, action: 'Buy',
    blurb: 'The stock opened clearly higher than yesterday\'s close and is staying above its open and VWAP. Strong demand — buy dips that hold VWAP.',
  },
  gap_down_reversal: {
    label: 'Gap-down reversal', group: 'bull', bias: 'bullish', buyReady: true, action: 'Buy (higher risk)',
    blurb: 'The stock opened lower but buyers pushed it back above its open and VWAP. Reversals can run far but fail often — keep the stop tight.',
  },
  vwap_pullback: {
    label: 'Pullback to VWAP', group: 'bull', bias: 'bullish', buyReady: true, action: 'Buy',
    blurb: 'An uptrend that has cooled off to near VWAP. Buying a dip that holds VWAP gives a close stop-loss and a better risk:reward than chasing.',
  },
  trend_up: {
    label: 'Steady uptrend', group: 'bull', bias: 'bullish', buyReady: true, action: 'Buy',
    blurb: 'Higher highs and higher lows, above VWAP, 9 EMA above 21 EMA. A clean trend — buy small pullbacks, not spikes.',
  },
  building: {
    label: 'Building strength', group: 'wait', bias: 'bullish', buyReady: false, action: 'Watch',
    blurb: 'Above VWAP and trending up, but no breakout or clean pullback yet. Put it on watch and wait for a trigger.',
  },
  overextended: {
    label: 'Overextended — don\'t chase', group: 'wait', bias: 'neutral', buyReady: false, action: 'Wait',
    blurb: 'Price is far above VWAP or RSI is extremely high. Moves like this often snap back — wait for a pullback instead of buying the top.',
  },
  oversold_bounce: {
    label: 'Oversold bounce attempt', group: 'wait', bias: 'neutral', buyReady: false, action: 'Wait',
    blurb: 'RSI is very low, so a bounce is possible — but the trend is still down. Only consider it after price climbs back above VWAP.',
  },
  range_bound: {
    label: 'Sideways / range-bound', group: 'wait', bias: 'neutral', buyReady: false, action: 'Wait',
    blurb: 'Price is chopping around with no direction. Breakouts from a range are better trades than guessing inside it.',
  },
  low_volume: {
    label: 'Low interest (thin volume)', group: 'wait', bias: 'neutral', buyReady: false, action: 'Skip',
    blurb: 'Volume is far below normal for this time of day. Moves without volume are unreliable — better opportunities exist elsewhere.',
  },
  weak_below_vwap: {
    label: 'Weak — below VWAP', group: 'bear', bias: 'bearish', buyReady: false, action: 'Avoid',
    blurb: 'Price is under VWAP with the 9 EMA below the 21 EMA. Sellers are in control — avoid buying.',
  },
  orb_breakdown: {
    label: 'Opening-range breakdown', group: 'bear', bias: 'bearish', buyReady: false, action: 'Avoid',
    blurb: 'Price fell below the low of the first 15 minutes and is under VWAP. Sellers have taken over — do not buy.',
  },
  gap_up_fade: {
    label: 'Gap-up fading', group: 'bear', bias: 'bearish', buyReady: false, action: 'Avoid',
    blurb: 'Opened higher but is now below its open and VWAP — early buyers are trapped and selling. A warning sign.',
  },
  gap_down_continue: {
    label: 'Gap-down continuing', group: 'bear', bias: 'bearish', buyReady: false, action: 'Avoid',
    blurb: 'Opened lower and is still sliding below its open and VWAP. Do not try to catch it.',
  },
  trend_down: {
    label: 'Steady downtrend', group: 'bear', bias: 'bearish', buyReady: false, action: 'Avoid',
    blurb: 'Lower highs and lower lows, under VWAP. Never buy a stock that keeps making new lows.',
  },
};

// ---------- building blocks ----------

// Split a candle list into trading days (candles must be sorted by time).
export function splitDays(candles) {
  const days = [];
  for (const c of candles) {
    if (typeof c.time !== 'number') continue; // daily candles have string dates — not intraday
    const date = dayKey(c.time);
    const last = days[days.length - 1];
    if (last && last.date === date) last.bars.push(c);
    else days.push({ date, bars: [c] });
  }
  return days;
}

// Volume-weighted average price, cumulative from the first bar. Indices have
// no volume on Yahoo — then it falls back to a plain average of typical prices.
export function vwapSeries(bars) {
  const hasVolume = bars.some((b) => b.volume > 0);
  let pv = 0;
  let w = 0;
  return bars.map((b) => {
    const weight = hasVolume ? Math.max(0, b.volume) : 1;
    pv += ((b.high + b.low + b.close) / 3) * weight;
    w += weight;
    return w > 0 ? pv / w : null;
  });
}

// Today's cumulative volume vs. the average of earlier sessions at the same
// clock time. Aligning by time (not bar count) keeps it right when the data
// provider drops a bar or two. While the market is open the in-progress bar is
// left out (it is only partly traded and would understate the ratio).
const timeOfDay = (b) => ((b.time % 86400) + 86400) % 86400;
export function relativeVolume(today, prior, excludeLast = false) {
  const k = excludeLast ? today.length - 1 : today.length;
  if (k < 3) return null;
  const cutoff = timeOfDay(today[k - 1]);
  const sum = (bars) => bars.reduce((t, b) => t + Math.max(0, b.volume || 0), 0);
  const cur = sum(today.slice(0, k));
  const hist = prior
    .slice(-4)
    .map((d) => d.bars.filter((b) => timeOfDay(b) <= cutoff))
    .filter((bars) => bars.length >= 0.8 * k) // skip half-days and days with big gaps in the data
    .map(sum)
    .filter((v) => v > 0);
  if (cur <= 0 || !hist.length) return null;
  return cur / (hist.reduce((a, b) => a + b, 0) / hist.length);
}

// Classic floor-trader pivot levels from the previous session.
export function floorPivots(bars) {
  if (!bars?.length) return null;
  const high = Math.max(...bars.map((b) => b.high));
  const low = Math.min(...bars.map((b) => b.low));
  const close = bars[bars.length - 1].close;
  const p = (high + low + close) / 3;
  return { high, low, close, pivot: p, r1: 2 * p - low, r2: p + (high - low), s1: 2 * p - high, s2: p - (high - low) };
}

// +1 higher highs & higher lows, -1 lower highs & lower lows, 0 mixed
// (last hour of trading, split into two halves).
export function structure(bars) {
  const w = bars.slice(-12);
  if (w.length < 8) return 0;
  const h = Math.floor(w.length / 2);
  const a = w.slice(0, h);
  const b = w.slice(h);
  const hi = (x) => Math.max(...x.map((c) => c.high));
  const lo = (x) => Math.min(...x.map((c) => c.low));
  if (hi(b) > hi(a) && lo(b) > lo(a)) return 1;
  if (hi(b) < hi(a) && lo(b) < lo(a)) return -1;
  return 0;
}

// Buy plan on 5-minute risk: stop under the nearest support the trade relies
// on (recent swing low, VWAP or the opening-range high), targets at the next
// resistance levels or 2R / 3R+.
// `resistances` are real obstacles (yesterday's high, pivots); `softResistances`
// (today's high after a pullback) can be a target but do not count as blocking.
export function intradayPlan(entry, a5, { bars, vwap, orh, resistances, softResistances = [] }) {
  const minRisk = Math.max(a5, entry * 0.003);
  const maxRisk = Math.max(3 * a5, entry * 0.012);
  const swingLow = Math.min(...bars.slice(-8).map((b) => b.low));
  const supports = [swingLow, vwap, orh].filter((v) => isNum(v) && v < entry - minRisk);
  const structural = supports.length ? Math.max(...supports) - 0.15 * a5 : entry - 1.5 * minRisk;
  const risk = clamp(entry - structural, minRisk, maxRisk);
  const stop = entry - risk;
  const hard = resistances.filter((r) => isNum(r) && r > entry).sort((x, y) => x - y);
  const above = [...hard, ...softResistances.filter((r) => isNum(r) && r > entry)].sort((x, y) => x - y);
  const t1 = above.find((r) => r - entry >= 1.5 * risk && r - entry <= 4 * risk) ?? entry + 2 * risk;
  const t2 = above.find((r) => r > t1 + 0.5 * risk && r - entry <= 6 * risk) ?? Math.max(entry + 3 * risk, t1 + risk);
  const nearest = hard[0] ?? null;
  return {
    entry,
    stopLoss: stop,
    target1: t1,
    target2: t2,
    riskReward: (t1 - entry) / risk,
    riskPct: (risk / entry) * 100,
    // How many "risks" away the first resistance is — under 1.5 means the path up is blocked.
    nearestResistance: nearest,
    room: nearest == null ? null : (nearest - entry) / risk,
  };
}

// ---------- scenario classifier ----------
export function classifyScenario(x) {
  const { price, vwap, open, e9, e21, rsi: r, rvol, gapPct, orb, struct, atr5, dayHigh } = x;
  const aboveV = isNum(vwap) && price > vwap;
  const belowV = isNum(vwap) && price < vwap;
  const up = isNum(e9) && isNum(e21) && e9 > e21;
  const down = isNum(e9) && isNum(e21) && e9 < e21;
  const gapUp = isNum(gapPct) && gapPct >= 0.5;
  const gapDown = isNum(gapPct) && gapPct <= -0.5;

  const stretched = aboveV && ((isNum(r) && r >= 80) || (atr5 > 0 && (price - vwap) / atr5 >= 8));
  const pulledBack = aboveV && atr5 > 0 && price - vwap <= 2.5 * atr5 && dayHigh - price >= 1.5 * atr5;

  let key;
  if (stretched) key = 'overextended';
  else if (orb === 'above' && aboveV && up && (rvol == null || rvol >= 1.0)) key = 'orb_breakout';
  else if (gapUp && aboveV && price > open) key = 'gap_up_hold';
  else if (gapDown && aboveV && price > open && orb !== 'below') key = 'gap_down_reversal';
  else if (aboveV && up && pulledBack) key = 'vwap_pullback';
  else if (aboveV && up && struct === 1) key = 'trend_up';
  else if (gapUp && belowV && price < open) key = 'gap_up_fade';
  else if (gapDown && belowV && price < open) key = 'gap_down_continue';
  else if (orb === 'below' && belowV) key = 'orb_breakdown';
  else if (belowV && down && struct === -1) key = 'trend_down';
  else if (isNum(r) && r <= 30) key = 'oversold_bounce';
  else if (rvol != null && rvol < 0.6) key = 'low_volume';
  else if (belowV && down) key = 'weak_below_vwap';
  else if (aboveV && up) key = 'building';
  else key = 'range_bound';
  return { key, ...SCENARIOS[key] };
}

// ---------- full analysis of one stock ----------
// `chart` is a normalised 5-minute chart (several days). Returns the full
// analysis, or { insufficient: true } while there is too little data.
export function analyzeIntraday(chart, { minutesLeft = null } = {}) {
  const candles = chart?.candles ?? [];
  const days = splitDays(candles);
  const todayDay = days[days.length - 1];
  if (!todayDay) {
    return { insufficient: true, message: 'No intraday (5-minute) data is available for this symbol.' };
  }
  const today = todayDay.bars;
  const prior = days.slice(0, -1);
  const prevDay = prior[prior.length - 1] ?? null;
  const sessionDate = todayDay.date;
  const marketOpen = chart.marketState === 'open';
  if (today.length < MIN_BARS_TODAY) {
    return {
      insufficient: true,
      tooEarly: true,
      sessionDate,
      message: `Only ${today.length * BAR_MINUTES} minutes of trading so far — intraday signals need at least ${MIN_BARS_TODAY * BAR_MINUTES} minutes of data.`,
    };
  }

  const L = candles.length - 1;
  const closes = candles.map((c) => c.close);
  const e9 = ema(closes, 9)[L];
  const e21 = ema(closes, 21)[L];
  const r = rsi(closes, 14)[L];
  const mac = macd(closes);
  const macdLine = mac.line[L];
  const macdSig = mac.signal[L];
  const price = isNum(chart.price) ? chart.price : closes[L];
  const a5 = Math.max(atr(candles, 14)[L] ?? 0, price * 0.001);

  const open = today[0].open;
  const dayHigh = Math.max(...today.map((b) => b.high));
  const dayLow = Math.min(...today.map((b) => b.low));
  const vw = vwapSeries(today);
  const vwap = vw[vw.length - 1];
  const vwapBefore = vw[Math.max(0, vw.length - 7)];
  const vwapRising = isNum(vwap) && isNum(vwapBefore) ? vwap > vwapBefore : null;
  const hasVolume = today.some((b) => b.volume > 0);

  const orBars = today.slice(0, OPENING_RANGE_BARS);
  const orh = Math.max(...orBars.map((b) => b.high));
  const orl = Math.min(...orBars.map((b) => b.low));
  const orb = price > orh ? 'above' : price < orl ? 'below' : 'inside';

  const prevClose = prevDay ? prevDay.bars[prevDay.bars.length - 1].close : null;
  const piv = prevDay ? floorPivots(prevDay.bars) : null;
  const gapPct = pct(open, prevClose);
  const dayChangePct = pct(price, prevClose);
  const vsVwapPct = pct(price, vwap);
  const rvol = hasVolume ? relativeVolume(today, prior, marketOpen) : null;
  const rangePos = dayHigh > dayLow ? ((price - dayLow) / (dayHigh - dayLow)) * 100 : null;
  const struct = structure(today);

  // ----- factors (same style as the daily analysis) -----
  const factors = [];
  const add = (key, label, weight, points, text) => {
    factors.push({ key, label, weight, points, verdict: points > 0 ? 'bullish' : points < 0 ? 'bearish' : 'neutral', text });
  };

  if (isNum(vwap)) {
    const above = price > vwap;
    const pts = above ? (vwapRising ? 2 : 1.5) : vwapRising === false ? -2 : -1.5;
    add('vwap', 'VWAP (the day\'s average price)', 2, pts, above
      ? `Price is ${round(Math.abs(vsVwapPct), 2)}% above VWAP (${round(vwap)})${vwapRising ? ' and VWAP is rising' : ''} — buyers are in control today.`
      : `Price is ${round(Math.abs(vsVwapPct), 2)}% below VWAP (${round(vwap)})${vwapRising === false ? ' and VWAP is falling' : ''} — sellers are in control today.`);
  }

  add('orb', 'Opening range (first 15 minutes)', 2, orb === 'above' ? 2 : orb === 'below' ? -2 : 0,
    orb === 'above' ? `Price broke above the opening-range high (${round(orh)}) — a classic intraday buy trigger.`
      : orb === 'below' ? `Price broke below the opening-range low (${round(orl)}) — a classic intraday sell signal.`
        : `Price is still inside the first-15-minute range (${round(orl)} – ${round(orh)}). Wait for a break either way.`);

  if (isNum(e9) && isNum(e21)) {
    const upT = e9 > e21;
    add('ema', 'Short-term trend (9 vs 21 EMA)', 1.5, upT ? (price > e9 ? 1.5 : 1) : (price < e9 ? -1.5 : -1), upT
      ? 'The 9-period average is above the 21-period average — short-term momentum is up.'
      : 'The 9-period average is below the 21-period average — short-term momentum is down.');
  }

  if (isNum(r)) {
    let pts, text;
    if (r >= 80) { pts = -1; text = `RSI is ${round(r, 0)} — extremely hot. A pullback is likely, so buying here is chasing.`; }
    else if (r >= 70) { pts = 0; text = `RSI is ${round(r, 0)} — very strong but stretched. Fine to hold, risky to add.`; }
    else if (r >= 55) { pts = 1; text = `RSI is ${round(r, 0)} — healthy positive momentum.`; }
    else if (r >= 45) { pts = 0; text = `RSI is ${round(r, 0)} — neutral momentum.`; }
    else if (r > 30) { pts = -0.5; text = `RSI is ${round(r, 0)} — momentum is weak.`; }
    else { pts = 0.5; text = `RSI is ${round(r, 0)} (oversold) — a bounce is possible but the trend is down.`; }
    add('rsi', 'RSI on 5-minute candles', 1, pts, text);
  }

  if (isNum(macdLine) && isNum(macdSig)) {
    add('macd', 'MACD (momentum)', 1, macdLine > macdSig ? 1 : -1,
      macdLine > macdSig ? 'MACD is above its signal line — momentum is positive.' : 'MACD is below its signal line — momentum is negative.');
  }

  if (isNum(rvol)) {
    const dir = price >= open ? 1 : -1;
    let pts = 0;
    let text = `Volume so far is ${round(rvol, 1)}× normal for this time of day.`;
    if (rvol >= 1.5) { pts = 1.5 * dir; text = dir > 0 ? `Heavy buying: volume is ${round(rvol, 1)}× normal while price is above its open — real participation.` : `Heavy selling: volume is ${round(rvol, 1)}× normal while price is below its open.`; }
    else if (rvol >= 1.1) { pts = 0.75 * dir; text = `Volume is ${round(rvol, 1)}× normal — above-average interest.`; }
    else if (rvol < 0.7) { pts = -0.5 * dir; text = `Volume is only ${round(rvol, 1)}× normal — thin trading, so this move is less reliable.`; }
    add('volume', 'Relative volume', 1.5, pts, text);
  }

  if (isNum(dayChangePct)) {
    const pts = dayChangePct > 0.5 ? 1 : dayChangePct < -0.5 ? -1 : 0;
    add('day', 'Change vs yesterday\'s close', 1, pts, `The stock is ${dayChangePct >= 0 ? 'up' : 'down'} ${round(Math.abs(dayChangePct), 2)}% today.`);
  }

  if (piv) {
    const pts = price > piv.high ? 1 : price < piv.low ? -1 : 0;
    add('prevday', 'Yesterday\'s high / low', 1, pts,
      price > piv.high ? `Price is above yesterday's high (${round(piv.high)}) — a sign of strength.`
        : price < piv.low ? `Price is below yesterday's low (${round(piv.low)}) — a sign of weakness.`
          : `Price is inside yesterday's range (${round(piv.low)} – ${round(piv.high)}).`);
  }

  add('structure', 'Price structure (last hour)', 1, struct,
    struct === 1 ? 'Higher highs and higher lows over the last hour — a clean uptrend.'
      : struct === -1 ? 'Lower highs and lower lows over the last hour — a clean downtrend.'
        : 'No clear pattern of highs and lows over the last hour.');

  if (isNum(rangePos)) {
    const pts = rangePos >= 75 ? 0.5 : rangePos <= 25 ? -0.5 : 0;
    add('range', 'Position in today\'s range', 0.5, pts,
      `Price is at ${round(rangePos, 0)}% of today's range (low ${round(dayLow)} – high ${round(dayHigh)}).`);
  }

  const maxScore = factors.reduce((t, f) => t + f.weight, 0) || 1;
  const total = factors.reduce((t, f) => t + f.points, 0);
  const score = Math.round(clamp((total / maxScore) * 100, -100, 100));
  const verdict = verdictFor(score);
  const bull = factors.filter((f) => f.verdict === 'bullish').length;
  const bear = factors.filter((f) => f.verdict === 'bearish').length;
  const agreement = factors.length ? Math.abs(bull - bear) / factors.length : 0;
  const confidence = agreement >= 0.6 ? 'High' : agreement >= 0.3 ? 'Medium' : 'Low';

  const scenario = classifyScenario({ price, vwap, open, e9, e21, rsi: r, rvol, gapPct, orb, struct, atr5: a5, dayHigh });

  // ----- trade plan -----
  // Today's high is a breakout trigger rather than a ceiling, so it may serve as a target
  // after a pullback but never blocks the trade. Yesterday's high and the pivots do.
  const resistances = [piv?.high, piv?.r1, piv?.r2].filter(isNum);
  const softResistances = dayHigh > price + a5 ? [dayHigh] : [];
  const p = intradayPlan(price, a5, { bars: today, vwap, orh, resistances, softResistances });
  const goodVerdict = verdict.key === 'strong_buy' || verdict.key === 'buy';
  const action = goodVerdict && scenario.buyReady ? 'buy' : scenario.bias === 'bearish' || verdict.key === 'sell' || verdict.key === 'strong_sell' ? 'avoid' : 'wait';
  const entryLow = Math.max(price - 0.5 * a5, p.stopLoss + 0.5 * (price - p.stopLoss));
  const lateNote = isNum(minutesLeft) && minutesLeft < MIN_MINUTES_LEFT
    ? [`Only about ${Math.max(0, Math.round(minutesLeft))} minutes are left in the session — too late to start a new intraday trade.`] : [];
  let plan;
  if (action === 'buy') {
    plan = {
      action, headline: 'Possible intraday BUY', entryLow, entryHigh: price, ...p,
      notes: [
        `Buy zone: ${round(entryLow)} – ${round(price)}. Don't chase if the price runs away from it.`,
        `Stop-loss ${round(p.stopLoss)} (${round(p.riskPct, 2)}% below entry). Exit immediately if it hits — intraday moves are fast.`,
        `Book half near Target 1 (${round(p.target1)}), move the stop to your entry price, and trail the rest toward Target 2 (${round(p.target2)}).`,
        `Exit early if a 5-minute candle closes below VWAP (${round(vwap)}) — the day's trend has turned.`,
        'Square off before the market closes. Intraday trades should never be carried overnight.',
        ...lateNote,
      ],
    };
    if (isNum(p.room) && p.room < 1.5) plan.notes.push(`Watch out: resistance near ${round(p.nearestResistance)} is close and may stall the move before Target 1.`);
  } else if (action === 'wait') {
    plan = {
      action, headline: 'WAIT for a trigger', entryLow: null, entryHigh: null, ...p,
      notes: [
        scenario.blurb,
        orb === 'inside' ? `A break above the opening-range high (${round(orh)}) with rising volume would turn this bullish.` : `A pullback toward VWAP (${round(vwap)}) that holds would give a safer entry.`,
        ...lateNote,
      ],
    };
  } else {
    plan = {
      action, headline: 'AVOID buying now', entryLow: null, entryHigh: null, ...p,
      notes: [
        scenario.blurb,
        `Look again only if price climbs back above VWAP (${round(vwap)}) and the 9 EMA crosses above the 21 EMA.`,
      ],
    };
  }

  const levels = piv
    ? { prevHigh: round(piv.high, 4), prevLow: round(piv.low, 4), prevClose: round(piv.close, 4), pivot: round(piv.pivot, 4), r1: round(piv.r1, 4), r2: round(piv.r2, 4), s1: round(piv.s1, 4), s2: round(piv.s2, 4) }
    : null;

  return {
    insufficient: false,
    sessionDate,
    barsToday: today.length,
    minutesTraded: today.length * BAR_MINUTES,
    marketOpen,
    minutesLeft: isNum(minutesLeft) ? Math.round(minutesLeft) : null,
    score,
    verdict: { key: verdict.key, label: verdict.label, summary: verdict.summary },
    confidence,
    bullishCount: bull,
    bearishCount: bear,
    scenario,
    factors,
    plan: Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, typeof v === 'number' ? round(v, 4) : v])),
    stats: {
      price: round(price, 4), open: round(open, 4), dayHigh: round(dayHigh, 4), dayLow: round(dayLow, 4),
      dayChangePct: round(dayChangePct), gapPct: round(gapPct), rangePos: round(rangePos, 0),
      vwap: round(vwap, 4), vsVwapPct: round(vsVwapPct), vwapRising,
      orh: round(orh, 4), orl: round(orl, 4), orb,
      ema9: round(e9, 4), ema21: round(e21, 4), rsi: round(r, 1), atr5: round(a5, 4),
      rvol: round(rvol, 2), volumeAvailable: hasVolume,
    },
    levels,
  };
}

// One row of the intraday scan: the 5-minute analysis plus the stock's daily
// signal (used for the "daily chart agrees" check and the Strong Buy list).
export function buildItem(m5, d1, { minutesLeft = null } = {}) {
  const intraday = compactIntraday(analyzeIntraday(m5, { minutesLeft: m5.marketState === 'open' ? minutesLeft : null }));
  let daily = null;
  if (d1) {
    const s = summarize(d1);
    if (!s.insufficient) {
      daily = {
        score: s.score, verdict: s.verdict, confidence: s.confidence, longTermScore: s.longTermScore, rsi: s.rsi, ret1m: s.ret1m,
        ret1y: s.ret1y, volatility: s.volatility, aboveSma50: s.aboveSma50, aboveSma200: s.aboveSma200,
        action: s.plan.action, entryLow: s.plan.entryLow, entryHigh: s.plan.entryHigh, stopLoss: s.plan.stopLoss, target1: s.plan.target1,
      };
    }
  }
  return {
    symbol: m5.symbol,
    name: m5.name,
    currency: m5.currency,
    price: m5.price,
    dayChangePct: intraday?.stats?.dayChangePct ?? null,
    intraday,
    daily,
  };
}

// Smaller version for lists (no factor text or notes).
export function compactIntraday(a) {
  if (!a || a.insufficient) return a ? { insufficient: true, tooEarly: Boolean(a.tooEarly), message: a.message } : null;
  const { factors, plan, ...rest } = a;
  const { notes, headline, ...p } = plan;
  return { ...rest, plan: p };
}

// ---------- market direction (index) ----------
export function indexBias(chart, name = '') {
  const a = analyzeIntraday(chart);
  if (a.insufficient) {
    return { symbol: chart?.symbol ?? '', name, bias: 'unknown', score: null, text: a.message ?? 'Not enough data yet.' };
  }
  const s = a.stats;
  // Small differences are noise, so each reading needs a dead band before it counts.
  const sign = (v, band) => (!isNum(v) ? 0 : v > band ? 1 : v < -band ? -1 : 0);
  const pts =
    sign(s.dayChangePct, 0.3) + // vs yesterday's close
    sign(pct(s.price, s.open), 0.1) + // vs today's open
    sign(pct(s.ema9, s.ema21), 0.03) + // 9 vs 21 EMA
    sign(s.vsVwapPct, 0.1); // vs VWAP
  const bias = pts >= 2 ? 'bullish' : pts <= -2 ? 'bearish' : 'neutral';
  const text = bias === 'bullish' ? 'The index is trending up today — the wind is at your back for buy trades.'
    : bias === 'bearish' ? 'The index is falling today. Most stocks fall with it, so fresh buy trades are low-odds.'
      : 'The index is sideways or mixed. Be selective and only take the cleanest setups.';
  return {
    symbol: chart.symbol, name: name || chart.name, bias, score: pts, text,
    price: s.price, changePct: s.dayChangePct, sessionDate: a.sessionDate,
  };
}

// ---------- "best of the best" ----------
// Every check must pass. Each check says what it is and why it passed / failed
// so the UI can show a transparent checklist.
export function evaluateBest(item, ctx = {}) {
  const i = item.intraday;
  if (!i || i.insufficient) return { passed: false, passCount: 0, total: 0, checks: [] };
  const d = item.daily;
  const s = i.stats;
  const p = i.plan;
  const checks = [];
  const check = (key, label, ok, detail) => checks.push({ key, label, ok: Boolean(ok), detail });

  check('score', 'Intraday signal is Strong Buy (score +50 or more)', i.score >= 50, `Score ${i.score > 0 ? '+' : ''}${i.score}`);
  check('scenario', 'A proper buy setup (breakout, pullback, gap-hold or uptrend)', i.scenario.buyReady, i.scenario.label);
  check('vwap', 'Price above VWAP', isNum(s.vsVwapPct) && s.vsVwapPct > 0, isNum(s.vsVwapPct) ? `${s.vsVwapPct > 0 ? '+' : ''}${s.vsVwapPct}% vs VWAP` : 'VWAP unavailable');
  check('trend', '9 EMA above 21 EMA', isNum(s.ema9) && isNum(s.ema21) && s.ema9 > s.ema21, isNum(s.ema9) ? `9 EMA ${s.ema9} vs 21 EMA ${s.ema21}` : 'Not enough data');
  check('volume', 'Volume at least 1.2× normal', isNum(s.rvol) && s.rvol >= 1.2, isNum(s.rvol) ? `${s.rvol}× normal` : 'Volume data unavailable');
  check('rsi', 'RSI between 50 and 75 (strong, not overheated)', isNum(s.rsi) && s.rsi >= 50 && s.rsi <= 75, isNum(s.rsi) ? `RSI ${s.rsi}` : 'RSI unavailable');
  check('room', 'Room to run (nearest resistance at least 1.5× the risk away)', p.room == null || p.room >= 1.5,
    p.room == null ? 'No resistance overhead' : `Resistance ${p.room.toFixed(1)}× the risk away`);
  check('daily', 'Daily chart agrees (Buy or Strong Buy)', Boolean(d && d.verdict && (d.verdict.key === 'buy' || d.verdict.key === 'strong_buy')), d?.verdict ? d.verdict.label : 'No daily data');
  if (ctx.marketBias) {
    check('market', 'Overall market is not falling', ctx.marketBias.bias !== 'bearish', `${ctx.marketBias.name || 'Index'}: ${ctx.marketBias.bias}`);
  }
  if (ctx.marketOpen && isNum(ctx.minutesLeft)) {
    check('time', `At least ${MIN_MINUTES_LEFT} minutes left in the session`, ctx.minutesLeft >= MIN_MINUTES_LEFT, `${Math.max(0, Math.round(ctx.minutesLeft))} min left`);
  }
  const passCount = checks.filter((c) => c.ok).length;
  return { passed: passCount === checks.length, passCount, total: checks.length, checks };
}

// Ranking among stocks that pass: signal strength first, then participation and room.
export const conviction = (it) => {
  const s = it.intraday.stats;
  const p = it.intraday.plan;
  return it.intraday.score + Math.min(s.rvol ?? 0, 3) * 3 + Math.min(p.riskReward ?? 0, 3) * 2 + (it.daily?.score ?? 0) * 0.1;
};

// Turn the scanned items into the board the UI shows.
export function buildBoard(items, { marketBias = null, marketOpen = false, minutesLeft = null } = {}) {
  const ctx = { marketBias, marketOpen, minutesLeft };
  const evaluated = items.map((it) => ({ ...it, best: evaluateBest(it, ctx) }));
  const live = evaluated.filter((it) => it.intraday && !it.intraday.insufficient);

  const best = live.filter((it) => it.best.passed).sort((a, b) => conviction(b) - conviction(a)).slice(0, 3);
  // If nothing passes every check, show the closest ones so the user sees why.
  const nearMisses = best.length
    ? []
    : live
      .filter((it) => ['buy', 'strong_buy'].includes(it.intraday.verdict.key))
      .sort((a, b) => b.best.passCount - a.best.passCount || b.intraday.score - a.intraday.score)
      .slice(0, 3);

  const strongBuyDaily = evaluated.filter((it) => it.daily?.verdict?.key === 'strong_buy').sort((a, b) => b.daily.score - a.daily.score);
  const closestDaily = strongBuyDaily.length
    ? []
    : evaluated.filter((it) => it.daily?.verdict && it.daily.verdict.key === 'buy').sort((a, b) => b.daily.score - a.daily.score).slice(0, 3);
  const strongBuyIntraday = live.filter((it) => it.intraday.verdict.key === 'strong_buy').sort((a, b) => b.intraday.score - a.intraday.score);

  const counts = {};
  for (const it of live) counts[it.intraday.scenario.key] = (counts[it.intraday.scenario.key] || 0) + 1;

  return { items: evaluated, best, nearMisses, strongBuyDaily, closestDaily, strongBuyIntraday, counts };
}

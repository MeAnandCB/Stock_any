// "My stock fell — what now?" A diagnosis of a sharp fall, using only price data plus a news screen.
// Pure functions: unit-tested with made-up candles.
import { analyze, round } from './analysis.js';
import { sma } from './indicators.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const change = (a, b) => ((a - b) / b) * 100;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export const BIG_DROP_PCT = -3; // a one-day fall at least this large counts as a "big drop"
const MIN_BARS = 80;

// How did this stock behave after earlier falls at least as large? (Past behaviour, not a forecast.)
export function dropHistory(candles, dropPct, upto) {
  const find = (threshold) => {
    const rows = [];
    for (let i = 1; i < upto - 20; i++) {
      if (change(candles[i].close, candles[i - 1].close) > threshold) continue;
      if (rows.length && i - rows.at(-1).i < 5) continue; // one slide counts once
      rows.push({ i, d5: change(candles[i + 5].close, candles[i].close), d20: change(candles[i + 20].close, candles[i].close) });
    }
    return rows;
  };
  let threshold = Math.min(dropPct, -2);
  let rows = find(threshold);
  if (rows.length < 8) {
    threshold = Math.min(threshold * 0.7, -2);
    rows = find(threshold);
  }
  if (!rows.length) return { count: 0, thresholdPct: round(threshold, 1) };
  const part = (k) => ({
    higher: rows.filter((r) => r[k] > 0).length,
    medianPct: round(median(rows.map((r) => r[k])), 1),
    worstPct: round(Math.min(...rows.map((r) => r[k])), 1),
    bestPct: round(Math.max(...rows.map((r) => r[k])), 1),
  });
  return { count: rows.length, thresholdPct: round(threshold, 1), years: round((upto - 1) / 250, 1), after5: part('d5'), after20: part('d20') };
}

// candles: daily, oldest first (several years). index: daily candles of the market index.
export function diagnoseDrop({ candles, index = [], news = null, marketState = 'closed' }) {
  if (!candles || candles.length < MIN_BARS) {
    return { insufficient: true, message: `Only ${candles?.length ?? 0} days of price history — at least ${MIN_BARS} are needed to judge a fall.` };
  }
  const n = candles.length;
  const dayChange = (i) => change(candles[i].close, candles[i - 1].close);
  // The fall to study: today/yesterday if it was big, otherwise the worst day of the last five.
  let e = n - 1;
  if (dayChange(e) > BIG_DROP_PCT) for (let i = n - 5; i < n; i++) if (dayChange(i) < dayChange(e)) e = i;
  const day = candles[e];
  const prev = candles[e - 1];
  const dropPct = dayChange(e);

  // What the chart looked like BEFORE the fall.
  const before = analyze({ candles: candles.slice(Math.max(0, e - 500), e), marketState: 'closed' });
  const atr = before.stats.atr;
  const atrPct = (atr / prev.close) * 100;
  const vols = candles.slice(Math.max(0, e - 20), e).map((c) => c.volume).filter((v) => v > 0);
  const volumeMultiple = vols.length && day.volume > 0 ? day.volume / mean(vols) : null;
  const closePosition = day.high > day.low ? ((day.close - day.low) / (day.high - day.low)) * 100 : null;
  const gapPct = change(day.open, prev.close);

  const idxAt = index.findIndex((c) => c.time === day.time);
  const indexPct = idxAt > 0 ? change(index[idxAt].close, index[idxAt - 1].close) : null;
  const relativePct = indexPct == null ? null : dropPct - indexPct;
  const cause = relativePct == null ? 'unknown' : relativePct <= -2 ? 'stock' : indexPct <= -1.2 ? 'market' : 'mixed';

  // Which important levels did this day break?
  const closes = candles.map((c) => c.close);
  const broken = [];
  for (const [period, label] of [[20, '20-day average'], [50, '50-day average'], [200, '200-day average']]) {
    const line = sma(closes, period);
    if (isNum(line[e]) && isNum(line[e - 1]) && prev.close >= line[e - 1] && day.close < line[e]) broken.push({ label, price: round(line[e], 2), major: period >= 50 });
  }
  const support = before.levels.supports[0];
  if (isNum(support) && prev.close > support && day.close < support) broken.push({ label: 'support level', price: round(support, 2), major: true });

  const now = analyze({ candles: candles.slice(-500), marketState });
  const price = candles[n - 1].close;
  const after = candles.slice(e + 1);
  const lowSince = Math.min(day.low, ...after.map((c) => c.low));
  const newLowAfter = after.some((c) => c.low < day.low);
  const sinceDropPct = after.length ? change(price, day.close) : 0;

  const history = dropHistory(candles, dropPct, e);

  // ----- findings, in plain words -----
  const findings = [];
  const add = (tone, text) => findings.push({ tone, text });
  const multiple = atrPct > 0 ? Math.abs(dropPct) / atrPct : null;
  // Big in absolute terms, or clearly unusual for THIS stock.
  const big = dropPct <= BIG_DROP_PCT || (dropPct <= -2 && multiple >= 1.2);
  add(big ? 'bad' : 'info', `${day.time}: the price moved ${round(dropPct, 2)}% in one day${multiple ? ` — ${round(multiple, 1)}× its normal daily range (${round(atrPct, 1)}%)` : ''}.`);
  if (cause === 'stock') add('bad', `The market index moved ${round(indexPct, 2)}% that day, so this fall is about THIS company (or its sector), not the whole market. Find out why before doing anything.`);
  else if (cause === 'market') add('warn', `The whole market fell (${round(indexPct, 2)}%), so much of this is the market, not the company.`);
  else if (cause === 'mixed') add('info', `The market index moved ${round(indexPct, 2)}% that day.`);
  if (isNum(gapPct) && gapPct <= -2) add('warn', `It opened ${round(Math.abs(gapPct), 1)}% lower than the previous close (a gap down) — usually news that arrived while the market was shut.`);
  if (isNum(volumeMultiple)) {
    if (volumeMultiple >= 1.5) add('bad', `Volume was ${round(volumeMultiple, 1)}× normal: many holders were selling. Heavy-volume falls often need time to settle.`);
    else if (volumeMultiple < 0.8) add('good', `Volume was only ${round(volumeMultiple, 1)}× normal: not a rush to the exit.`);
    else add('info', `Volume was ${round(volumeMultiple, 1)}× normal.`);
  }
  if (isNum(closePosition)) {
    if (closePosition <= 25) add('warn', 'It closed near the day\'s low — sellers were still in control at the close.');
    else if (closePosition >= 60) add('good', 'It closed well off the day\'s low — some buyers stepped in.');
  }
  for (const b of broken) add(b.major ? 'bad' : 'warn', `It closed below the ${b.label} (about ${b.price}). A broken floor often turns into a ceiling.`);
  const s200 = now.stats.sma200;
  if (isNum(s200)) add(price > s200 ? 'good' : 'bad', price > s200 ? `Still above its 200-day average (${round(s200, 2)}) — the long-term trend is intact.` : `Below its 200-day average (${round(s200, 2)}) — the long-term trend is DOWN.`);
  if (isNum(now.stats.rsi) && now.stats.rsi < 30) add('info', `RSI is ${round(now.stats.rsi, 0)} (oversold). A bounce is possible, but "oversold" stocks can keep falling.`);
  if (after.length) add(newLowAfter ? 'bad' : 'info', newLowAfter ? 'It has made a new low since that day — the fall has not stopped yet.' : `Since then it has not made a lower low (${sinceDropPct >= 0 ? '+' : ''}${round(sinceDropPct, 1)}% from that close).`);
  if (news?.level === 'red') add('bad', 'Recent headlines contain SERIOUS warning words (see the news below). Read them first.');
  else if (news?.level === 'amber') add('warn', 'Recent headlines include negative stories (see below).');
  else if (news?.level === 'none') add('info', 'No recent headlines about the company were found. Check the exchange filings (NSE / BSE announcements).');

  // ----- stance -----
  const majorBreak = broken.some((b) => b.major);
  const heavy = isNum(volumeMultiple) && volumeMultiple >= 1.5;
  const downtrend = (isNum(s200) && price < s200) || ['sell', 'strong_sell'].includes(now.verdict.key);
  let stance;
  if (!big && !downtrend && !majorBreak && news?.level !== 'red') {
    stance = { key: 'no_big_drop', tone: 'info', title: 'No unusual one-day fall in the last 5 sessions', text: `The largest one-day move was ${round(dropPct, 2)}%. If your stock fell more than this, check that you typed the right symbol.` };
  } else if (news?.level === 'red' || (majorBreak && heavy) || (downtrend && cause === 'stock' && big)) {
    stance = { key: 'avoid', tone: 'bad', title: 'Do not buy more yet', text: 'The fall shows signs of real damage. Buying more now ("averaging down") adds money to a falling position. Wait until the reason is clear and the price stops making new lows.' };
  } else if (downtrend || majorBreak || newLowAfter || (heavy && cause === 'stock')) {
    stance = { key: 'wait', tone: 'warn', title: 'Wait for it to settle', text: 'There is no sign yet that the fall is over. Let the price prove it first (see "What would change this").' };
  } else {
    stance = { key: 'dip', tone: 'ok', title: 'Fell, but the bigger trend is intact', text: 'The long-term trend and key floors are still holding. If you choose to buy, do it only with a stop-loss and a small position — a dip can still become a downtrend.' };
  }

  const reclaim = majorBreak ? Math.max(...broken.filter((b) => b.major).map((b) => b.price)) : day.high;
  // Below the recent low AND at least 1.5 normal days away: a stop closer than that is hit by ordinary noise.
  const stop = Math.min(lowSince - 0.25 * now.stats.atr, price - 1.5 * now.stats.atr);
  const triggers = [
    `A daily CLOSE back above ${round(reclaim, 2)} (${majorBreak ? 'the broken level' : 'the high of the falling day'}).`,
    `At least 3 trading days in a row without going below ${round(lowSince, 2)}.`,
    'An up day on volume above normal — buyers returning, not just a pause in selling.',
    'You know why it fell, and the reason is temporary rather than damage to the business.',
  ];

  return {
    insufficient: false,
    day: {
      date: day.time, changePct: round(dropPct, 2), open: round(day.open, 2), high: round(day.high, 2), low: round(day.low, 2), close: round(day.close, 2),
      gapPct: round(gapPct, 2), volumeMultiple: round(volumeMultiple, 2), normalRangePct: round(atrPct, 2), timesNormal: round(multiple, 1),
      closePosition: round(closePosition, 0), indexPct: round(indexPct, 2), relativePct: round(relativePct, 2), cause, broken,
    },
    isLatest: e === n - 1,
    latest: { date: candles[n - 1].time, price: round(price, 2), changePct: round(dayChange(n - 1), 2), sinceDropPct: round(sinceDropPct, 2), newLowAfter, lowSince: round(lowSince, 2) },
    trend: { verdict: now.verdict, score: now.score, rsi: now.stats.rsi, sma50: now.stats.sma50, sma200: now.stats.sma200, ret1m: now.stats.ret1m, ret1y: now.stats.ret1y, fromHigh52: now.stats.fromHigh52, supports: now.levels.supports, resistances: now.levels.resistances },
    history,
    findings,
    stance,
    triggers,
    ifYouBuy: { stop: round(stop, 2), riskPct: round(((price - stop) / price) * 100, 2) },
  };
}

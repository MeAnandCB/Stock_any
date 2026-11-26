// The intraday market scan, shared by the website (/api/intraday), the Analyse page and the daily
// Telegram digest, so they can never disagree.
import { getChart, AppError } from './yahoo.js';
import { buildItem, buildBoard, indexBias, SCENARIOS } from './intraday.js';
import { MARKETS } from './universe.js';
import { mapLimit } from './util.js';

// 5-minute bars. 5 days gives enough history for the moving averages, yesterday's levels and
// "normal volume at this time of day".
const INTRADAY_FETCH = { ttlMs: 30000, step: 300 };
export const intradayChart = (symbol) => getChart(symbol, '5d', '5m', INTRADAY_FETCH);
export const minutesLeftIn = (chart) =>
  chart.marketState === 'open' && chart.sessionEnd ? Math.max(0, (chart.sessionEnd - Date.now()) / 60000) : null;

// How the whole market is behaving today (first index of the market). Never throws: a missing
// index just means the "market is not falling" check is skipped.
export async function marketDirection(market) {
  const ix = MARKETS[market].indices[0];
  try {
    return indexBias(await intradayChart(ix.symbol), ix.name);
  } catch {
    return null;
  }
}

// Scan every large cap of a market on 5-minute candles plus the daily chart.
// Returns the same object the /api/intraday endpoint sends. Does not save anything.
export async function runIntradayScan(market) {
  const symbols = MARKETS[market].stocks;
  const [direction, fetched] = await Promise.all([
    marketDirection(market),
    mapLimit(symbols, 5, async (s) => {
      const [m5, d1] = await Promise.all([intradayChart(s), getChart(s).catch(() => null)]);
      return { m5, d1 };
    }),
  ]);
  const ok = fetched.filter((r) => r.ok).map((r) => r.value);
  if (!ok.length) throw new AppError(fetched[0]?.error?.message || 'Could not load intraday data.', 503);
  const failed = [];
  fetched.forEach((r, i) => {
    if (!r.ok) failed.push({ symbol: symbols[i], error: r.error?.message || 'Failed' });
  });
  const marketOpen = ok.some((x) => x.m5.marketState === 'open');
  const minutesLeft = ok.map((x) => minutesLeftIn(x.m5)).find((v) => v != null) ?? null;
  const items = ok.map((x) => buildItem(x.m5, x.d1, { minutesLeft }));
  const board = buildBoard(items, { marketBias: direction, marketOpen, minutesLeft });
  const sessionDate = items.map((i) => i.intraday?.sessionDate).filter(Boolean).sort().pop() ?? null;
  return {
    market,
    updated: Date.now(),
    marketOpen,
    minutesLeft: minutesLeft == null ? null : Math.round(minutesLeft),
    sessionDate,
    marketBias: direction,
    total: symbols.length,
    failed,
    scenarios: SCENARIOS,
    ...board,
  };
}

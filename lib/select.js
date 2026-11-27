// Which stocks may be put forward. Shared by the Final Picks page and the Telegram digest.
import { conviction, MIN_MINUTES_LEFT } from './intraday.js';

export const IDEAS = 5;
export const MIN_LONG_TERM_SCORE = 20; // below this a stock is not "a strong long-term trend"

const ZONES = { IN: 'Asia/Kolkata', US: 'America/New_York' };
// Calendar date ("2026-11-26") in the market's own time zone.
export const localDate = (ms, market) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ZONES[market], year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

// What can the intraday section honestly say right now?   live | too_early | late | closed | stale
export function intradayState(result, now = Date.now()) {
  if (!result.marketOpen) return 'closed';
  const analysed = (result.items ?? []).filter((it) => it.intraday && !it.intraday.insufficient).length;
  if (analysed === 0) return (result.items ?? []).some((it) => it.intraday?.tooEarly) ? 'too_early' : 'stale';
  if (result.sessionDate !== localDate(now, result.market)) return 'stale';
  if (typeof result.minutesLeft === 'number' && result.minutesLeft < MIN_MINUTES_LEFT) return 'late';
  return 'live';
}

// ONLY stocks that pass every check. A plain "buy" signal lost money in testing (npm run backtest).
export function pickIntraday(items, n = IDEAS) {
  return items
    .filter((it) => it.intraday && !it.intraday.insufficient && it.best?.passed)
    .sort((a, b) => conviction(b) - conviction(a))
    .slice(0, n);
}

// Short term: strongest daily charts that are not already stretched.
export function pickSwing(items, n = IDEAS) {
  return items
    .filter((it) => it.daily && it.daily.verdict?.key === 'strong_buy' && it.daily.aboveSma200 === true && it.daily.action === 'buy' && !(it.daily.rsi >= 70))
    .sort((a, b) => b.daily.score - a.daily.score || b.daily.longTermScore - a.daily.longTermScore)
    .slice(0, n);
}

// Strongest long-term trends: above the 200-day average and not rated Sell on the daily chart.
export function pickLongTerm(items, n = IDEAS) {
  return items
    .filter((it) => it.daily && it.daily.aboveSma200 === true && ['strong_buy', 'buy', 'hold'].includes(it.daily.verdict?.key) && it.daily.longTermScore >= MIN_LONG_TERM_SCORE)
    .sort((a, b) => b.daily.longTermScore - a.daily.longTermScore || b.daily.score - a.daily.score)
    .slice(0, n);
}

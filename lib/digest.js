// The morning digest: 5 intraday ideas + 5 long-term ideas, formatted for Telegram.
// Pure functions (no network), so the choices and the wording are unit-tested.
import { conviction, MIN_MINUTES_LEFT } from './intraday.js';
import { escapeHtml as esc, splitMessage } from './telegram.js';

export const IDEAS = 5;
export const MIN_LONG_TERM_SCORE = 20; // below this a stock is not "a strong long-term trend"
export const MIN_RVOL = 0.7; // a rise on less than this much of the normal volume is not trusted

const MARKET_INFO = {
  IN: { zone: 'Asia/Kolkata', tz: 'IST', name: 'India (NSE)', currency: 'INR', locale: 'en-IN', symbol: '₹' },
  US: { zone: 'America/New_York', tz: 'ET', name: 'United States', currency: 'USD', locale: 'en-US', symbol: '$' },
};
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Calendar date ("2026-11-26") in the market's own time zone.
export const localDate = (ms, market) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: MARKET_INFO[market].zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

function whenText(ms, market) {
  const { zone, tz } = MARKET_INFO[market];
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' }).format(ms);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);
  return `${day.replace(',', '')}, ${time} ${tz}`;
}

const money = (v, market) => {
  if (!isNum(v)) return '—';
  const m = MARKET_INFO[market];
  return `${m.symbol}${new Intl.NumberFormat(m.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)}`;
};
const pct = (v, d = 1) => (isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d)}%` : '—');
const signed = (v) => (isNum(v) ? `${v > 0 ? '+' : ''}${Math.round(v)}` : '—');
const short = (symbol) => String(symbol).replace(/\.(NS|BO)$/i, '');
const duration = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

// ---------- choosing ----------

// What can the intraday section honestly say right now?
//   live | too_early | late | closed | stale
export function intradayState(result, now = Date.now()) {
  if (!result.marketOpen) return 'closed';
  const analysed = (result.items ?? []).filter((it) => it.intraday && !it.intraday.insufficient).length;
  if (analysed === 0) return (result.items ?? []).some((it) => it.intraday?.tooEarly) ? 'too_early' : 'stale';
  if (result.sessionDate !== localDate(now, result.market)) return 'stale';
  if (typeof result.minutesLeft === 'number' && result.minutesLeft < MIN_MINUTES_LEFT) return 'late';
  return 'live';
}

// Stocks with a real buy setup right now, best first. Stocks that pass every "best of the best" check lead.
// A move on thin volume (under 0.7x normal) is left out however good the rest of it looks.
export function pickIntraday(items, n = IDEAS) {
  return items
    .filter((it) => it.intraday && !it.intraday.insufficient && it.intraday.plan?.action === 'buy')
    .filter((it) => !isNum(it.intraday.stats?.rvol) || it.intraday.stats.rvol >= MIN_RVOL)
    .sort((a, b) => (b.best?.passed ? 1000 : 0) + conviction(b) - ((a.best?.passed ? 1000 : 0) + conviction(a)))
    .slice(0, n);
}

// Strongest long-term trends: above the 200-day average and not rated Sell on the daily chart.
export function pickLongTerm(items, n = IDEAS) {
  return items
    .filter((it) => it.daily && it.daily.aboveSma200 === true && ['strong_buy', 'buy', 'hold'].includes(it.daily.verdict?.key) && it.daily.longTermScore >= MIN_LONG_TERM_SCORE)
    .sort((a, b) => b.daily.longTermScore - a.daily.longTermScore || b.daily.score - a.daily.score)
    .slice(0, n);
}

// ---------- wording ----------
function intradayLine(it, n, market) {
  const i = it.intraday;
  const p = i.plan;
  const s = i.stats;
  const P = (v) => money(v, market);
  return [
    `${n}. <b>${esc(short(it.symbol))}</b> ${P(it.price)} (${pct(s.dayChangePct)}) — ${esc(i.scenario.label)}${it.best?.passed ? ' 🏆' : ''}`,
    `   Buy ${P(p.entryLow)}–${P(p.entryHigh)} · Stop ${P(p.stopLoss)} · T1 ${P(p.target1)} · T2 ${P(p.target2)} · R:R 1:${isNum(p.riskReward) ? p.riskReward.toFixed(1) : '—'}`,
    `   Score ${signed(i.score)} · volume ${isNum(s.rvol) ? `${s.rvol.toFixed(1)}×` : '—'} normal · RSI ${isNum(s.rsi) ? Math.round(s.rsi) : '—'}`,
  ].join('\n');
}

function longTermLine(it, n, market) {
  const d = it.daily;
  const P = (v) => money(v, market);
  let zone = 'Accumulate on dips';
  if (d.action === 'buy' && isNum(d.entryLow) && isNum(d.entryHigh)) zone = `Buy zone ${P(d.entryLow)}–${P(d.entryHigh)}`;
  else if (d.action === 'wait' && isNum(d.entryLow) && isNum(d.entryHigh)) zone = `Wait for a dip to ${P(d.entryLow)}–${P(d.entryHigh)}`;
  const stretched = isNum(d.rsi) && d.rsi >= 70 ? ' · ⚠ stretched — stagger your buying' : '';
  return [
    `${n}. <b>${esc(short(it.symbol))}</b> ${P(it.price)} — Trend ${signed(d.longTermScore)} · 1Y ${pct(d.ret1y)} · RSI ${isNum(d.rsi) ? Math.round(d.rsi) : '—'} · Daily: ${esc(d.verdict.label)}`,
    `   ${zone}${isNum(d.stopLoss) ? ` · Exit if it closes below ${P(d.stopLoss)}` : ''}${stretched}`,
  ].join('\n');
}

const STATE_TEXT = {
  too_early: '⏳ The market has only just opened. Intraday signals need about 30 minutes of trading — they will be ready after the first half hour.',
  closed: '⏸ The market is not open right now (before the opening bell, after the close, or a holiday / weekend), so there are no live intraday signals.',
  late: `⏰ Less than ${MIN_MINUTES_LEFT} minutes are left in the session — too late to start a new intraday trade.`,
  stale: '⚠ The intraday data is not from today\'s session, so no intraday ideas are shown.',
};

export function buildDigest(result, now = Date.now(), { appUrl = process.env.APP_URL } = {}) {
  const market = result.market in MARKET_INFO ? result.market : 'IN';
  const info = MARKET_INFO[market];
  const state = intradayState({ ...result, market }, now);
  const intraday = state === 'live' ? pickIntraday(result.items ?? []) : [];
  const longTerm = pickLongTerm(result.items ?? []);
  const scanned = (result.items ?? []).length;

  const head = [`📊 <b>StockSense morning digest</b>`, `${esc(whenText(now, market))} · ${esc(info.name)}`];
  const mb = result.marketBias;
  if (mb && mb.bias !== 'unknown') {
    const open = result.marketOpen
      ? `market open${typeof result.minutesLeft === 'number' ? `, ${duration(result.minutesLeft)} left` : ''}`
      : 'market closed';
    head.push(`${esc(mb.name)} ${pct(mb.changePct)} (${esc(mb.bias)}) · ${open}`);
  }

  const sections = [head.join('\n')];

  const intraHead = `⚡ <b>Intraday ideas</b> — same-day trades`;
  if (state === 'live') {
    sections.push(intraday.length
      ? `${intraHead}\n${intraday.map((it, k) => intradayLine(it, k + 1, market)).join('\n\n')}\n\n<i>${intraday.length} of ${scanned} large caps have a buy setup right now. 🏆 = passes every best-of-the-best check. Close intraday trades before the market closes.</i>`
      : `${intraHead}\nNo stock has a clean buy setup right now. On days like this the best trade is often <b>no trade</b>.`);
  } else {
    sections.push(`${intraHead}\n${STATE_TEXT[state]}`);
  }

  sections.push(longTerm.length
    ? `🌱 <b>Long-term ideas</b> — months to years\n${longTerm.map((it, k) => longTermLine(it, k + 1, market)).join('\n\n')}\n\n<i>Ranked by trend strength among ${scanned} large caps (above the 200-day average, steady 1-year climb). Price data only — check the company's profits, debt and valuation before investing.</i>`
    : `🌱 <b>Long-term ideas</b> — months to years\nNo large cap currently shows a strong, steady long-term uptrend.`);

  const foot = ['⚠️ Rule-based signals from price charts — not investment advice. Always use a stop-loss.'];
  if (appUrl && /^https?:\/\//i.test(appUrl)) foot.push(`<a href="${esc(appUrl.replace(/\/+$/, ''))}/#/intraday">Open StockSense</a>`);
  sections.push(foot.join('\n'));

  const text = sections.join('\n\n');
  return { text, messages: splitMessage(text), state, intraday, longTerm };
}

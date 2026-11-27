// The morning digest — intraday, short-term and long-term ideas, formatted for Telegram.
// Pure functions (no network), so the choices and the wording are unit-tested.
import { MIN_MINUTES_LEFT } from './intraday.js';
import { escapeHtml as esc, splitMessage } from './telegram.js';
import { localDate } from './select.js';
import { selectCandidates, applyNews, loadEvidence, evidenceSummary } from './final.js';

export { IDEAS, MIN_LONG_TERM_SCORE, localDate, intradayState, pickIntraday, pickSwing, pickLongTerm } from './select.js';

const MARKET_INFO = {
  IN: { zone: 'Asia/Kolkata', tz: 'IST', name: 'India (NSE)', currency: 'INR', locale: 'en-IN', symbol: '₹' },
  US: { zone: 'America/New_York', tz: 'ET', name: 'United States', currency: 'USD', locale: 'en-US', symbol: '$' },
};
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

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

// ---------- wording ----------
const newsMark = (it) => (it.news?.level === 'amber' ? '\n   📰 Negative headlines this week — read them before buying' : '');

function intradayLine(it, n, market) {
  const i = it.intraday;
  const p = i.plan;
  const s = i.stats;
  const P = (v) => money(v, market);
  return [
    `${n}. <b>${esc(short(it.symbol))}</b> ${P(it.price)} (${pct(s.dayChangePct)}) — ${esc(i.scenario.label)}`,
    `   Buy ${P(p.entryLow)}–${P(p.entryHigh)} · Stop ${P(p.stopLoss)} · Sell by 3:15 PM (optional target ${P(p.target1)})`,
    `   Score ${signed(i.score)} · volume ${isNum(s.rvol) ? `${s.rvol.toFixed(1)}×` : '—'} normal · RSI ${isNum(s.rsi) ? Math.round(s.rsi) : '—'}`,
  ].join('\n') + newsMark(it);
}

function swingLine(it, n, market) {
  const d = it.daily;
  const P = (v) => money(v, market);
  return [
    `${n}. <b>${esc(short(it.symbol))}</b> ${P(it.price)} — Daily score ${signed(d.score)} · RSI ${isNum(d.rsi) ? Math.round(d.rsi) : '—'}`,
    `   Buy ${P(d.entryLow)}–${P(d.entryHigh)} · Stop ${P(d.stopLoss)} · Target ${P(d.target1)}`,
  ].join('\n') + newsMark(it);
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
  ].join('\n') + newsMark(it);
}

const STATE_TEXT = {
  too_early: '⏳ The market has only just opened. Intraday signals need about 30 minutes of trading — they will be ready after the first half hour.',
  closed: '⏸ The market is not open right now (before the opening bell, after the close, or a holiday / weekend), so there are no live intraday signals.',
  late: `⏰ Less than ${MIN_MINUTES_LEFT} minutes are left in the session — too late to start a new intraday trade.`,
  stale: '⚠ The intraday data is not from today\'s session, so no intraday ideas are shown.',
};

const testLine = (e) => (e && e.level !== 'untested'
  ? `<i>Testing: ${esc(e.label)}.${e.trades ? ` ${e.trades} past trades, ${e.winRate}% made money, average ${e.avgNetPct > 0 ? '+' : ''}${e.avgNetPct.toFixed(2)}% after costs.` : ''}</i>`
  : '<i>Testing: these rules have not been measured for this market.</i>');

// `picks` is the news-screened board from applyNews(); without it the picks are made without a news screen.
export function buildDigest(result, now = Date.now(), { appUrl = process.env.APP_URL, picks = null, evidence } = {}) {
  const market = result.market in MARKET_INFO ? result.market : 'IN';
  const info = MARKET_INFO[market];
  const board = picks ?? applyNews(selectCandidates({ ...result, market }, now), new Map());
  const { state, intraday, swing, long: longTerm, heldBack } = board;
  const proof = evidence ?? evidenceSummary(loadEvidence(market));

  const head = [`📊 <b>StockSense morning digest</b>`, `${esc(whenText(now, market))} · ${esc(info.name)}`];
  const mb = result.marketBias;
  if (mb && mb.bias !== 'unknown') {
    const open = result.marketOpen
      ? `market open${typeof result.minutesLeft === 'number' ? `, ${duration(result.minutesLeft)} left` : ''}`
      : 'market closed';
    head.push(`${esc(mb.name)} ${pct(mb.changePct)} (${esc(mb.bias)}) · ${open}`);
  }
  const sections = [head.join('\n')];
  const list = (rows, line) => rows.map((it, k) => line(it, k + 1, market)).join('\n\n');

  const intraHead = `⚡ <b>Intraday</b> — only stocks that pass every check`;
  if (state !== 'live') sections.push(`${intraHead}\n${STATE_TEXT[state]}`);
  else if (!intraday.length) sections.push(`${intraHead}\nNo stock passes every check right now. On days like this the best trade is often <b>no trade</b>.`);
  else sections.push(`${intraHead}\n${list(intraday, intradayLine)}\n\n${testLine(proof.intraday)}`);

  sections.push(swing.length
    ? `📈 <b>Short term</b> — 1 to 4 weeks\n${list(swing, swingLine)}\n\n${testLine(proof.swing)}\n<i>Treat these as ideas to research, not buy calls.</i>`
    : `📈 <b>Short term</b> — 1 to 4 weeks\nNo strong daily setup that is not already stretched.`);

  sections.push(longTerm.length
    ? `🌱 <b>Long-term ideas</b> — months to years\n${list(longTerm, longTermLine)}\n\n${testLine(proof.long)}\n<i>For long-term money a broad index fund is the better-supported core. Check profits, debt and valuation before buying a single stock.</i>`
    : `🌱 <b>Long-term ideas</b> — months to years\nNo large cap currently shows a strong, steady long-term uptrend.`);

  if (heldBack.length) sections.push(`🚫 Held back because of serious headlines: ${esc(heldBack.map((h) => short(h.symbol)).join(', '))}`);

  const foot = ['⚠️ Rule-based signals from price charts and a headline scan — not investment advice. Always use a stop-loss.'];
  if (appUrl && /^https?:\/\//i.test(appUrl)) foot.push(`<a href="${esc(appUrl.replace(/\/+$/, ''))}/#/final">Open StockSense</a>`);
  sections.push(foot.join('\n'));

  const text = sections.join('\n\n');
  return { text, messages: splitMessage(text), state, intraday, swing, longTerm };
}

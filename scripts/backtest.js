// How well have the signals really done?   npm run backtest
//
// Replays the app's own rules on past data (about 60 sessions of 5-minute candles for intraday,
// 5 years of daily candles for short and long term) and writes public/evidence.json, which the app
// shows next to its picks.  Options:  --market=IN   --data=<folder>  (reuse downloaded data)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, normalizeChart } from '../lib/yahoo.js';
import { MARKETS } from '../lib/universe.js';
import { mapLimit } from '../lib/util.js';
import {
  backtestIntraday, backtestSwing, backtestLongTerm, stats, longStats, COST_PCT, INTRADAY_RULES, SWING_RULES, LONG_RULES,
} from '../lib/backtest.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const market = (arg('market') || 'IN').toUpperCase();
const dir = arg('data') || path.join(root, '.cache', 'backtest', market);
mkdirSync(dir, { recursive: true });

const file = (s) => path.join(dir, `${s.replace(/[^A-Z0-9]/gi, '_')}.json`);
async function download(symbol) {
  if (existsSync(file(symbol))) return JSON.parse(readFileSync(file(symbol), 'utf8'));
  const get = async (range, interval, step) => {
    const { body } = await fetchJson(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplit`, { timeoutMs: 20000, retries: 2 });
    return normalizeChart(body, symbol, { step }).candles;
  };
  const d = { symbol, daily: await get('5y', '1d', 0), m5: await get('60d', '5m', 300) };
  writeFileSync(file(symbol), JSON.stringify(d));
  return d;
}

const info = MARKETS[market];
console.log(`Loading data for ${info.label}…`);
const loaded = await mapLimit([info.indices[0].symbol, ...info.stocks], 3, download);
if (!loaded[0].ok) throw new Error(`Could not load the market index: ${loaded[0].error?.message}`);
const [index, ...stocks] = loaded.filter((r) => r.ok).map((r) => r.value);
console.log(`${stocks.length} stocks loaded.\n`);

const progress = (label) => (x, n, total) => process.stdout.write(`\r${label} ${n}/${total} ${String(x).padEnd(14)}`);

// ---------- intraday (split: older two thirds to look at, newest third to check) ----------
const intra = backtestIntraday(stocks, index, { onDay: progress('Intraday day') });
const cut = intra.dates[Math.floor(intra.dates.length * (2 / 3))];
const split = (trades, c, cost) => ({ all: stats(trades, cost), earlier: stats(trades.filter((t) => t.day < c), cost), recent: stats(trades.filter((t) => t.day >= c), cost) });
const intradayOut = INTRADAY_RULES.map((r) => ({ id: r.id, label: r.label, current: Boolean(r.current), ...split(intra.trades[r.id], cut, COST_PCT.intraday) }));

// ---------- short term ----------
console.log('');
const swing = backtestSwing(stocks, index, { onStock: progress('Short-term stock') });
const allDays = index.daily.slice(252).map((c) => c.time);
const swingCut = allDays[Math.floor(allDays.length * (2 / 3))];
const swingOut = SWING_RULES.map((r) => ({ id: r.id, label: r.label, current: Boolean(r.current), ...split(swing.trades[r.id], swingCut, COST_PCT.swing) }));

// ---------- long term ----------
console.log('\nLong term…');
const long = backtestLongTerm(stocks, index);
const longOut = LONG_RULES.map((r) => ({ id: r.id, label: r.label, current: Boolean(r.current), months3: longStats(long[r.id][63]), year1: longStats(long[r.id][252]) }));

const evidence = {
  market,
  generatedAt: new Date().toISOString(),
  stocks: stocks.length,
  costs: COST_PCT,
  intraday: { from: intra.dates[0], to: intra.dates.at(-1), sessions: intra.dates.length, recentFrom: cut, rules: intradayOut },
  swing: { from: allDays[0], to: allDays.at(-1), recentFrom: swingCut, rules: swingOut },
  longTerm: { rules: longOut },
  caveats: [
    'Past results do not predict future results.',
    'The stock list is today\'s large companies. Companies that fell out of favour are missing, so past returns look better than they would have been in real time (survivorship bias).',
    'Only about 60 sessions of 5-minute data are available, which is a short and single market period for judging intraday rules.',
    'Prices are not adjusted for dividends, and your real fills and charges may differ.',
  ],
};
writeFileSync(path.join(root, 'public', market === 'IN' ? 'evidence.json' : `evidence-${market}.json`), `${JSON.stringify(evidence, null, 1)}\n`);

// ---------- print ----------
const f = (v, d = 2) => (v == null ? '  —' : `${v > 0 ? '+' : ''}${v.toFixed(d)}`);
console.log(`\n===== INTRADAY  ${evidence.intraday.from} → ${evidence.intraday.to} (${intra.dates.length} sessions, cost ${COST_PCT.intraday}% a trade; "recent" = from ${cut}) =====`);
console.log('rule                                                          trades  win%  avg net%   avg R  stopped%  edge vs any stock%   t   | earlier net% | recent net%');
for (const r of intradayOut) {
  const a = r.all;
  console.log(`${(r.current ? '* ' : '  ') + r.label.padEnd(60)} ${String(a.trades).padStart(5)} ${String(a.winRate ?? '—').padStart(5)}  ${f(a.avgNetPct, 3).padStart(7)} ${f(a.avgR).padStart(7)}  ${String(a.stopRate ?? '—').padStart(6)}   ${f(a.edgeVsAnyStockPct, 3).padStart(10)}      ${f(a.t).padStart(6)} | ${f(r.earlier.avgNetPct, 3).padStart(10)}   | ${f(r.recent.avgNetPct, 3).padStart(9)} (${r.recent.trades})`);
}
console.log(`\n===== SHORT TERM  ${evidence.swing.from} → ${evidence.swing.to} (cost ${COST_PCT.swing}% a trade; "recent" = from ${swingCut}) =====`);
console.log('rule                                                          trades  win%  avg net%   avg R  stopped%  edge vs any stock%   t   | earlier net% | recent net%');
for (const r of swingOut) {
  const a = r.all;
  console.log(`${(r.current ? '* ' : '  ') + r.label.padEnd(60)} ${String(a.trades).padStart(5)} ${String(a.winRate ?? '—').padStart(5)}  ${f(a.avgNetPct, 3).padStart(7)} ${f(a.avgR).padStart(7)}  ${String(a.stopRate ?? '—').padStart(6)}   ${f(a.edgeVsAnyStockPct, 3).padStart(10)}      ${f(a.t).padStart(6)} | ${f(r.earlier.avgNetPct, 3).padStart(10)}   | ${f(r.recent.avgNetPct, 3).padStart(9)} (${r.recent.trades})`);
}
console.log('\n===== LONG TERM (a new set of 5 every month; "all" = holding all stocks equally) =====');
for (const r of longOut) {
  for (const [name, s] of [['3 months', r.months3], ['1 year', r.year1]]) {
    if (!s.periods) continue;
    console.log(`${(r.current ? '* ' : '  ') + r.label.padEnd(76)} ${name.padEnd(8)} picks ${f(s.avgPickedPct).padStart(7)}%  all ${f(s.avgAllStocksPct).padStart(7)}%  excess ${f(s.excessPct).padStart(6)}%  beat all ${s.beatAllStocksRate}% of months  lost money ${s.lostMoneyRate}%  worst ${f(s.worstPeriodPct)}%  (${s.periods} starts)`);
  }
}
console.log('\n* = the rule the app used before this test.  Saved to public/evidence.json');

// "Final picks" for three time frames — each shown next to what testing says about that rule
// (public/evidence.json, made by `npm run backtest`).
import { readFileSync } from 'node:fs';
import { intradayState, pickIntraday, pickSwing, pickLongTerm } from './select.js';

export const PER_HORIZON = 5;

export function loadEvidence(market = 'IN') {
  try {
    // `new URL(..., import.meta.url)` lets serverless hosts bundle the file with the function.
    const url = market === 'IN' ? new URL('../public/evidence.json', import.meta.url) : new URL('../public/evidence-US.json', import.meta.url);
    return JSON.parse(readFileSync(url, 'utf8'));
  } catch {
    return null; // not tested for this market yet
  }
}

// How much trust a rule has earned. Deliberately strict: "good" needs a positive result in both the older
// and the newer period, at least 100 trades AND a result that luck would rarely produce (|t| >= 2).
export function reliability(rule) {
  const a = rule?.all;
  const r = rule?.recent;
  if (!a?.trades) return { level: 'untested', label: 'Not tested' };
  if (a.avgNetPct <= 0 && a.t <= -2) return { level: 'bad', label: 'Lost money in testing' };
  if (a.avgNetPct > 0 && r?.avgNetPct > 0) {
    return a.t >= 2 && a.trades >= 100
      ? { level: 'good', label: 'Held up in testing' }
      : { level: 'weak', label: 'Slightly positive — NOT proven' };
  }
  return { level: 'bad', label: 'No reliable edge in testing' };
}

const signed = (v, d = 2) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`);

// One plain-English line per time frame.
export function evidenceSummary(evidence) {
  const none = { level: 'untested', label: 'Not tested for this market', text: 'Run "npm run backtest" to measure these rules on past data.' };
  if (!evidence) return { intraday: none, swing: none, long: none, anyBuy: none };
  const find = (group, id) => group.rules.find((x) => x.id === id);
  const trade = (group, id, what) => {
    const x = find(group, id);
    if (!x?.all?.trades) return none;
    return {
      ...reliability(x),
      trades: x.all.trades, winRate: x.all.winRate, avgNetPct: x.all.avgNetPct, recentAvgNetPct: x.recent?.avgNetPct, t: x.all.t,
      from: group.from, to: group.to,
      text: `${x.all.trades} test trades ${what} (${group.from} to ${group.to}): ${x.all.winRate}% made money, average ${signed(x.all.avgNetPct)} per trade after costs; most recent period ${signed(x.recent?.avgNetPct)}.`,
    };
  };
  const lt = find(evidence.longTerm, 'trend_score');
  const long = lt?.year1?.periods
    ? {
      level: lt.year1.excessPct > 0 && lt.year1.beatAllStocksRate >= 60 ? 'weak' : 'bad',
      label: lt.year1.excessPct > 0 ? 'Slightly better than average — NOT proven' : 'Did NOT beat simply holding all the stocks',
      text: `Held for 1 year, the top 5 returned ${signed(lt.year1.avgPickedPct, 1)} on average against ${signed(lt.year1.avgAllStocksPct, 1)} for holding all ${evidence.stocks} equally; they won in ${lt.year1.beatAllStocksRate}% of start months. Over 3 months: ${signed(lt.months3.avgPickedPct, 1)} against ${signed(lt.months3.avgAllStocksPct, 1)}.`,
      avgPickedPct: lt.year1.avgPickedPct, avgAllStocksPct: lt.year1.avgAllStocksPct,
    }
    : none;
  return {
    intraday: trade(evidence.intraday, 'all_checks', 'of stocks passing every check'),
    anyBuy: trade(evidence.intraday, 'any_buy_tight', 'of any plain buy signal'),
    swing: trade(evidence.swing, 'shown', 'of this same short-term rule'),
    long,
  };
}

// Which stocks to put forward in each time frame (before looking at the news). A few spares are kept so
// that stocks held back for bad news can be replaced.
export function selectCandidates(scan, now = Date.now()) {
  const items = scan.items ?? [];
  const state = intradayState(scan, now);
  return {
    state,
    intraday: state === 'live' ? pickIntraday(items, PER_HORIZON + 3) : [],
    swing: pickSwing(items, PER_HORIZON + 3),
    long: pickLongTerm(items, PER_HORIZON * 2),
  };
}

// Attach the news screen. A stock with serious headlines is held back, with the reason shown.
export function applyNews(candidates, newsBySymbol) {
  const held = new Map();
  const finish = (list, horizon) => {
    const out = [];
    for (const it of list) {
      const news = newsBySymbol.get(it.symbol) ?? null;
      if (news?.level === 'red') {
        const h = held.get(it.symbol) ?? { symbol: it.symbol, name: it.name, horizons: [], news };
        h.horizons.push(horizon);
        held.set(it.symbol, h);
        continue;
      }
      if (out.length < PER_HORIZON) out.push({ ...it, news });
    }
    return out;
  };
  return {
    state: candidates.state,
    intraday: finish(candidates.intraday, 'intraday'),
    swing: finish(candidates.swing, 'short term'),
    long: finish(candidates.long, 'long term'),
    heldBack: [...held.values()],
  };
}

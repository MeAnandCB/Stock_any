import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenNews, newsKeywordsFor, mentions } from '../lib/news.js';
import { selectCandidates, applyNews, reliability, evidenceSummary, loadEvidence, PER_HORIZON } from '../lib/final.js';
import { buildDigest } from '../lib/digest.js';
import { diagnoseDrop, dropHistory } from '../lib/stockcheck.js';
import { simulateTrade, stats, longStats } from '../lib/backtest.js';
import { analyzeIntraday, STOP_WIDTH } from '../lib/intraday.js';

const NOW = Date.UTC(2026, 10, 26, 5, 0, 0);
const head = (title, daysAgo = 1) => ({ title, publisher: 'x', link: 'https://x.y', time: NOW - daysAgo * 86400000 });

// ---------- news screen ----------
test('screenNews separates serious, negative and event headlines, and ignores old ones', () => {
  const s = screenNews([
    head('ACME shares crash as SEBI probe into accounting begins'),
    head('Brokerage downgrades ACME, cuts target price'),
    head('ACME Q2 results: board meet on Friday, dividend expected'),
    head('ACME opens a new plant'),
    head('Old: ACME fraud case', 30),
  ], NOW);
  assert.equal(s.level, 'red');
  assert.equal(s.checked, 4, 'the month-old headline is left out');
  assert.equal(s.serious.length, 1);
  assert.equal(s.negative.length, 1);
  assert.equal(s.events.length, 1);
  assert.equal(screenNews([head('ACME profit falls 12% in the quarter')], NOW).level, 'amber');
  assert.equal(screenNews([head('ACME wins large order'), head('ACME fine-tunes strategy for strikes deal')], NOW).level, 'clear', 'innocent words are not flagged');
  assert.equal(screenNews([], NOW).level, 'none');
  assert.equal(screenNews(null, NOW).level, 'none');
});

test('only headlines that name the company count', () => {
  const k = newsKeywordsFor({ symbol: 'TCS.NS', name: 'Tata Consultancy Services Limited' });
  const got = mentions([head('Tata Consultancy wins deal'), head('TCS shares rise'), head('Tata Motors fraud probe')], k);
  assert.equal(got.length, 2, 'another group company\'s bad news is not pinned on this one');
});

// ---------- final picks ----------
const item = (symbol, { best = false, daily = 'strong_buy', rsi = 60, lt = 50, action = 'buy', above200 = true, score = 60 } = {}) => ({
  symbol, name: symbol, currency: 'INR', price: 100, dayChangePct: 1,
  intraday: { insufficient: false, sessionDate: '2026-11-26', score: 70, verdict: { key: 'strong_buy' }, scenario: { label: 'x' }, stats: { rvol: 1.5, rsi: 60, dayChangePct: 1 }, plan: { action: 'buy', entryLow: 99, entryHigh: 100, entry: 100, stopLoss: 98, target1: 104, riskReward: 2 } },
  daily: { score, verdict: { key: daily, label: daily }, longTermScore: lt, aboveSma200: above200, rsi, ret1y: 10, action, entryLow: 99, entryHigh: 100, stopLoss: 95, target1: 110 },
  best: { passed: best, passCount: best ? 9 : 6, total: 9 },
});
const scan = (items, over = {}) => ({ market: 'IN', marketOpen: true, minutesLeft: 200, sessionDate: '2026-11-26', items, ...over });

test('selectCandidates: each time frame has its own rule; intraday is empty unless the market is live', () => {
  const items = [item('PASS', { best: true }), item('NOPASS'), item('STRETCHED', { rsi: 75 }), item('JUSTBUY', { daily: 'buy' }), item('BELOW', { above200: false }), item('WAIT', { action: 'wait' })];
  const c = selectCandidates(scan(items), NOW);
  assert.deepEqual(c.intraday.map((x) => x.symbol), ['PASS']);
  assert.deepEqual(c.swing.map((x) => x.symbol).sort(), ['NOPASS', 'PASS'], 'strong buy, above 200-day, not stretched, buyable now');
  assert.ok(!c.long.some((x) => x.symbol === 'BELOW'));
  const closed = selectCandidates(scan(items, { marketOpen: false }), NOW);
  assert.deepEqual(closed.intraday, []);
  assert.equal(closed.state, 'closed');
  assert.ok(closed.swing.length, 'daily lists still work before the open');
});

test('a stock with serious headlines is held back and replaced by the next one', () => {
  const items = Array.from({ length: 8 }, (_, i) => item(`S${i}`, { score: 90 - i, lt: 80 - i }));
  const red = screenNews([head('S0 raided in money laundering probe')], NOW);
  const amber = screenNews([head('S1 downgrade by broker')], NOW);
  const b = applyNews(selectCandidates(scan(items), NOW), new Map([['S0', red], ['S1', amber]]));
  assert.equal(b.swing.length, PER_HORIZON);
  assert.ok(!b.swing.some((x) => x.symbol === 'S0') && !b.long.some((x) => x.symbol === 'S0'));
  assert.equal(b.swing[0].symbol, 'S1', 'merely negative news is shown with a warning, not removed');
  assert.equal(b.swing[0].news.level, 'amber');
  assert.deepEqual(b.heldBack.map((h) => [h.symbol, h.horizons.join('+')]), [['S0', 'short term+long term']]);
  const digest = buildDigest(scan(items), NOW, { picks: b });
  assert.match(digest.text, /Held back because of serious headlines: S0/);
  assert.match(digest.text, /Negative headlines this week/);
});

test('reliability is strict: small or one-period results are never called proven', () => {
  const rule = (avg, t, trades, recent) => ({ all: { avgNetPct: avg, t, trades }, recent: { avgNetPct: recent } });
  assert.equal(reliability(rule(0.4, 3, 500, 0.3)).level, 'good');
  assert.equal(reliability(rule(0.4, 1.2, 500, 0.3)).level, 'weak', 'could be luck');
  assert.equal(reliability(rule(0.4, 3, 60, 0.3)).level, 'weak', 'too few trades');
  assert.equal(reliability(rule(0.9, 2.4, 580, -1.2)).level, 'bad', 'great on old data, losing recently');
  assert.equal(reliability(rule(-0.07, -2.7, 1300, 0.02)).label, 'Lost money in testing');
  assert.equal(reliability(null).level, 'untested');
  assert.equal(evidenceSummary(null).intraday.level, 'untested');
});

test('the shipped evidence file matches what the app claims', () => {
  const e = loadEvidence('IN');
  assert.ok(e, 'public/evidence.json is present (npm run backtest)');
  const s = evidenceSummary(e);
  for (const k of ['intraday', 'anyBuy', 'swing', 'long']) assert.ok(s[k].label && s[k].text, k);
  assert.equal(e.intraday.rules.find((r) => r.current).id, 'all_checks');
  assert.equal(e.swing.rules.find((r) => r.current).id, 'shown', 'the short-term label measures the rule the cards use');
  assert.equal(loadEvidence('US'), null, 'no US test results are invented');
});

// ---------- drop diagnosis ----------
function series(n, f, { vol = () => 1000 } = {}) {
  const out = [];
  let prev = f(0);
  for (let i = 0; i < n; i++) {
    const close = f(i);
    out.push({ time: new Date(Date.UTC(2022, 0, 1) + i * 86400000).toISOString().slice(0, 10), open: prev, high: Math.max(prev, close) * 1.006, low: Math.min(prev, close) * 0.994, close, volume: vol(i) });
    prev = close;
  }
  return out;
}
const rising = (i) => 100 * (1 + 0.0015 * i) * (1 + 0.006 * Math.sin(i / 3));
const withDrop = (base, pct, volume = 1000) => {
  const last = base.at(-1);
  const close = last.close * (1 + pct / 100);
  return [...base, { time: '2030-01-01', open: last.close * 0.97, high: last.close * 0.972, low: close * 0.998, close, volume }];
};
const flatIndex = (candles, lastPct = 0) => candles.map((c, i) => ({ ...c, close: i === candles.length - 1 ? 1000 * (1 + lastPct / 100) : 1000 }));

test('a heavy company-specific crash through support says: do not buy more yet', () => {
  const candles = withDrop(series(420, rising), -12, 6000);
  const d = diagnoseDrop({ candles, index: flatIndex(candles, 0.3) });
  assert.equal(d.day.date, '2030-01-01');
  assert.ok(d.day.changePct < -11.5);
  assert.equal(d.day.cause, 'stock');
  assert.ok(d.day.volumeMultiple > 5 && d.day.timesNormal > 4);
  assert.ok(d.day.broken.some((b) => b.major));
  assert.equal(d.stance.key, 'avoid');
  assert.ok(d.findings.some((f) => f.tone === 'bad' && /THIS company/.test(f.text)));
  assert.ok(d.triggers.length >= 3);
  assert.ok(d.ifYouBuy.stop < d.latest.price);
  assert.ok(d.ifYouBuy.riskPct >= 1.5, `a multi-day stop is never inside normal noise (${d.ifYouBuy.riskPct}%)`);
});

test('a market-wide fall is told apart from a company fall; serious news always means wait', () => {
  const candles = withDrop(series(420, rising), -3.5);
  const market = diagnoseDrop({ candles, index: flatIndex(candles, -3) });
  assert.equal(market.day.cause, 'market');
  assert.notEqual(market.stance.key, 'no_big_drop');
  const news = screenNews([head('Auditor resigns at ACME amid probe')], NOW);
  assert.equal(diagnoseDrop({ candles, index: flatIndex(candles, -3), news }).stance.key, 'avoid');
});

test('no unusual fall is said plainly, and too little history is refused', () => {
  const calm = diagnoseDrop({ candles: series(300, rising) });
  assert.equal(calm.stance.key, 'no_big_drop');
  assert.equal(diagnoseDrop({ candles: series(30, rising) }).insufficient, true);
});

test('dropHistory reports what happened after earlier falls, using only data before the event', () => {
  // Every 40th day falls 5% and the price recovers afterwards.
  const f = (i) => 100 * (1 + 0.001 * i) * (i % 40 === 39 ? 0.95 : 1);
  const c = series(600, f);
  const h = dropHistory(c, -4.5, c.length - 1);
  assert.ok(h.count >= 10, `count ${h.count}`);
  assert.equal(h.after5.higher, h.count);
  assert.ok(h.after20.medianPct > 0);
  assert.equal(dropHistory(series(200, rising), -20, 199).count, 0);
});

// ---------- the test engine itself ----------
test('simulateTrade is conservative: next-bar entry, stop first, gaps filled at the open', () => {
  const b = (open, high, low, close) => ({ open, high, low, close });
  assert.equal(simulateTrade([b(100, 106, 94, 100)], 0, { stop: 95, target: 105 }).how, 'stop', 'both touched: stop assumed first');
  const gap = simulateTrade([b(100, 101, 99, 100), b(90, 91, 89, 90)], 0, { stop: 95, target: 110 });
  assert.deepEqual([gap.how, gap.exit], ['stop', 90], 'a gap through the stop fills at the worse price');
  const t = simulateTrade([b(100, 101, 99, 100), b(101, 106, 100, 104)], 0, { stop: 95, target: 105 });
  assert.deepEqual([t.how, t.exit, t.held], ['target', 105, 2]);
  assert.equal(simulateTrade([b(100, 101, 99, 100), b(100, 102, 99, 101)], 0, { stop: 90 }).how, 'time');
  assert.equal(simulateTrade([b(94, 96, 93, 95)], 0, { stop: 95, target: 105 }), null, 'already below the stop: not taken');
  assert.equal(simulateTrade([b(100, 120, 99, 101), b(100, 101, 99, 100)], 0, { stop: 90, target: 130, maxBars: 1 }).held, 1);
});

test('stats take off costs and do not call noise significant', () => {
  const mk = (gross, day) => ({ grossPct: gross, riskPct: 1, how: 'time', day });
  const s = stats([mk(0.1, 'a'), mk(0.1, 'b'), mk(0.1, 'c')], 0.25);
  assert.equal(s.winRate, 0, 'a gain smaller than the costs is a loss');
  assert.ok(Math.abs(s.avgNetPct + 0.15) < 1e-9);
  const noisy = stats([mk(5, 'a'), mk(-5, 'b'), mk(4, 'c'), mk(-3, 'd')], 0);
  assert.ok(Math.abs(noisy.t) < 1);
  assert.equal(stats([], 0.1).trades, 0);
  assert.equal(longStats([{ pickedPct: 5, allStocksPct: 8, worstPickPct: -3, date: 'a' }]).excessPct, -3);
});

test('the intraday plan uses the tested wider stop while judging the setup on the tight one', () => {
  const bars = [];
  for (let d = 0; d < 5; d++) {
    let prev = 1000;
    for (let i = 0; i < 40; i++) {
      const close = 1000 * (1 + d * 0.001 + i * 0.0004 + 0.0012 * Math.sin(i * 1.7));
      bars.push({ time: Date.UTC(2026, 10, 2 + d) / 1000 + 33300 + i * 300, open: prev, high: Math.max(prev, close) * 1.001, low: Math.min(prev, close) * 0.999, close, volume: 1e5 });
      prev = close;
    }
  }
  const a = analyzeIntraday({ candles: bars, price: bars.at(-1).close, marketState: 'closed' });
  const p = a.plan;
  assert.ok(Math.abs((p.entry - p.stopLoss) - STOP_WIDTH * (p.entry - p.baseStop)) < 0.01);
  assert.ok(Math.abs((p.target1 - p.entry) - 2 * (p.entry - p.stopLoss)) < 0.01);
  assert.equal(p.riskReward, 2);
});

test('a multi-word company name still resolves when only a one-word search answers', async () => {
  const { search, clearCache, matchingAllWords } = await import('../lib/yahoo.js');
  const q = (symbol, longname) => ({ symbol, longname, quoteType: 'EQUITY' });
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    asked.push([u.hostname.slice(0, 6), u.searchParams.get('q')]);
    const quotes = u.searchParams.get('q') === 'asian' ? [q('ASIANPAINT.NS', 'Asian Paints Limited'), q('ASIANHOTNR.NS', 'Asian Hotels (North)')] : [];
    return new Response(JSON.stringify({ quotes }), { status: 200 });
  };
  try {
    clearCache();
    const r = await search('asian paints');
    assert.deepEqual(r.quotes.map((x) => x.symbol), ['ASIANPAINT.NS']);
    assert.deepEqual(asked.slice(0, 2), [['query1', 'asian paints'], ['query2', 'asian paints']], 'the second server is tried before giving up');
    asked.length = 0;
    await search('asian paints');
    assert.ok(asked.some((a) => a[1] === 'asian paints'), 'an empty answer was not cached');
    assert.deepEqual((await search('zzzz')).quotes, []);
    assert.deepEqual(matchingAllWords([{ symbol: 'A', name: 'Tata Motors' }], ['tata', 'steel']), []);
  } finally {
    globalThis.fetch = real;
    clearCache();
  }
});

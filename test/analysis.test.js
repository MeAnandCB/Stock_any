import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, summarize, planFrom, findLevels, detectPattern, verdictFor } from '../lib/analysis.js';
import { normalizeChart } from '../lib/yahoo.js';
import { scoreHeadline, aggregate } from '../lib/sentiment.js';
import { parseRss, decodeEntities, newsNameFor } from '../lib/news.js';
import { cleanSymbol, mapLimit } from '../lib/util.js';

// Deterministic pseudo-random generator so tests are repeatable.
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

function makeCandles(n, drift, seed = 1, start = 100) {
  const r = rng(seed);
  const out = [];
  let p = start;
  const d0 = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const open = p;
    p = Math.max(1, p * (1 + drift + (r() - 0.5) * 0.02));
    const high = Math.max(open, p) * (1 + r() * 0.01);
    const low = Math.min(open, p) * (1 - r() * 0.01);
    out.push({ time: new Date(d0 + i * 86400000).toISOString().slice(0, 10), open, high, low, close: p, volume: 1e6 + r() * 1e5 });
  }
  return out;
}
const chartOf = (candles, extra = {}) => {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  return { symbol: 'TEST', name: 'Test Co', currency: 'INR', price: last?.close, change: prev ? last.close - prev.close : null, changePct: prev ? ((last.close - prev.close) / prev.close) * 100 : null, marketState: 'closed', candles, ...extra };
};

test('steady uptrend produces a bullish signal with a sane buy plan', () => {
  const a = analyze(chartOf(makeCandles(300, 0.004)));
  assert.equal(a.insufficient, false);
  assert.ok(a.score > 20, `score ${a.score}`);
  assert.ok(['buy', 'strong_buy'].includes(a.verdict.key));
  const p = a.plan;
  assert.equal(p.action, 'buy');
  assert.ok(p.stopLoss < p.entryLow && p.entryLow <= p.entryHigh, 'stop < entry zone');
  assert.ok(p.entryHigh < p.target1 && p.target1 < p.target2, 'entry < t1 < t2');
  assert.ok(p.riskReward >= 1.5);
});

test('steady downtrend produces a bearish signal and avoid plan', () => {
  const a = analyze(chartOf(makeCandles(300, -0.004)));
  assert.ok(a.score < -20, `score ${a.score}`);
  assert.ok(['sell', 'strong_sell'].includes(a.verdict.key));
  assert.equal(a.plan.action, 'avoid');
  assert.ok(a.plan.exitLevel < a.stats.price);
});

test('score is always within -100..100 and verdicts cover all scores', () => {
  for (let seed = 1; seed < 40; seed++) {
    const a = analyze(chartOf(makeCandles(260, (seed % 7 - 3) * 0.002, seed)));
    assert.ok(a.score >= -100 && a.score <= 100);
    assert.ok(a.verdict.label);
    assert.ok(Number.isFinite(a.plan.stopLoss));
  }
  assert.equal(verdictFor(-100).key, 'strong_sell');
  assert.equal(verdictFor(100).key, 'strong_buy');
});

test('too little history is reported, not crashed on', () => {
  const a = analyze(chartOf(makeCandles(10, 0.001)));
  assert.equal(a.insufficient, true);
  assert.match(a.message, /at least/);
  const s = summarize(chartOf(makeCandles(10, 0.001)));
  assert.equal(s.insufficient, true);
  assert.equal(analyze({ candles: [] }).insufficient, true);
  assert.equal(analyze(null).insufficient, true);
});

test('works without 200 days of history (no SMA200)', () => {
  const a = analyze(chartOf(makeCandles(60, 0.003)));
  assert.equal(a.insufficient, false);
  assert.equal(a.stats.sma200, null);
  assert.ok(!a.factors.some((f) => f.key === 'trend_long'));
});

test('flat price (suspended stock) does not divide by zero', () => {
  const c = Array.from({ length: 100 }, (_, i) => ({ time: `2024-01-${String((i % 28) + 1).padStart(2, '0')}-${i}`, open: 50, high: 50, low: 50, close: 50, volume: 0 }));
  const a = analyze(chartOf(c));
  for (const v of [a.plan.stopLoss, a.plan.target1, a.stats.atr]) assert.ok(Number.isFinite(v));
});

test('summary contains the fields the UI needs', () => {
  const s = summarize(chartOf(makeCandles(300, 0.002)));
  for (const k of ['symbol', 'name', 'price', 'score', 'verdict', 'rsi', 'longTermScore', 'spark', 'plan']) assert.ok(k in s, k);
  assert.equal(s.spark.length, 30);
});

test('planFrom keeps stop below entry and targets above', () => {
  const p = planFrom(100, 2, [97, 90], [103, 110, 120]);
  assert.ok(p.stopLoss < 100);
  assert.ok(p.target1 > 100 && p.target2 > p.target1);
  assert.equal(p.blocking, 103);
});

test('findLevels always returns at least one support below and resistance above', () => {
  const c = makeCandles(200, 0.01); // price at all-time high
  const price = c[c.length - 1].close;
  const { supports, resistances } = findLevels(c, price, 2);
  assert.ok(supports.length && supports.every((s) => s < price));
  assert.ok(resistances.length && resistances.every((r) => r > price));
});

test('candlestick pattern detection', () => {
  const engulf = [{ open: 10, close: 9, high: 10.2, low: 8.8 }, { open: 8.9, close: 10.3, high: 10.4, low: 8.8 }];
  assert.equal(detectPattern(engulf, 11).name, 'Bullish Engulfing');
  const doji = [{ open: 10, close: 10.5, high: 11, low: 9 }, { open: 10, close: 10.01, high: 11, low: 9 }];
  assert.equal(detectPattern(doji, 10).name, 'Doji');
  assert.equal(detectPattern([{ open: 1, close: 1, high: 1, low: 1 }, { open: 1, close: 1, high: 1, low: 1 }], 1), null);
});

test('normalizeChart cleans nulls, dedupes days and errors on unknown symbols', () => {
  const body = {
    chart: {
      result: [{
        meta: { symbol: 'X.NS', currency: 'INR', regularMarketPrice: 12, gmtoffset: 19800 },
        timestamp: [1704067200, 1704153600, 1704160000, 1704240000],
        indicators: { quote: [{ open: [10, null, 11, 11.5], high: [10.5, 11, 11.6, 12.2], low: [9.5, 10, 10.8, 11.2], close: [10, 10.5, 11.2, 11.8], volume: [100, 200, null, 300] }] },
      }],
    },
  };
  const c = normalizeChart(body, 'X.NS');
  assert.equal(c.candles.length, 3); // null open dropped
  assert.equal(c.candles.at(-1).close, 12); // synced with live price
  assert.ok(c.candles.every((k, i, arr) => i === 0 || arr[i - 1].time < k.time));
  assert.equal(c.candles[1].volume, 0);
  assert.throws(() => normalizeChart({ chart: { result: null, error: { code: 'Not Found' } } }, 'BAD'), (e) => e.status === 404);
  assert.throws(() => normalizeChart({}, 'BAD'), (e) => e.status === 404);
});

test('headline sentiment', () => {
  assert.equal(scoreHeadline('Infosys shares surge after strong profit growth').label, 'positive');
  assert.equal(scoreHeadline('Stock plunges as company misses estimates').label, 'negative');
  assert.equal(scoreHeadline('Company to hold annual meeting').label, 'neutral');
  const agg = aggregate([{ sentiment: { label: 'positive' } }, { sentiment: { label: 'positive' } }, { sentiment: { label: 'negative' } }]);
  assert.equal(agg.mood, 'positive');
  assert.equal(aggregate([]).mood, 'neutral');
});

test('RSS parsing decodes entities, strips publisher and rejects bad links', () => {
  const xml = `<rss><channel>
    <item><title>Tata &amp; Sons rally - Mint</title><link>https://example.com/a</link><pubDate>Sat, 14 Nov 2026 22:23:18 GMT</pubDate><source url="https://mint">Mint</source></item>
    <item><title>Bad link</title><link>javascript:alert(1)</link></item>
  </channel></rss>`;
  const items = parseRss(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Tata & Sons rally');
  assert.equal(items[0].publisher, 'Mint');
  assert.ok(items[0].time > 0);
  assert.equal(decodeEntities('&#39;a&#x27;&lt;'), "'a'<");
  assert.equal(newsNameFor('Reliance Industries Limited'), 'Reliance Industries');
  assert.equal(newsNameFor('Apple Inc.'), 'Apple');
});

test('symbol validation', () => {
  assert.equal(cleanSymbol(' reliance.ns '), 'RELIANCE.NS');
  assert.equal(cleanSymbol('M&M.NS'), 'M&M.NS');
  assert.equal(cleanSymbol('^NSEI'), '^NSEI');
  assert.equal(cleanSymbol('../etc/passwd'), null);
  assert.equal(cleanSymbol('<script>'), null);
  assert.equal(cleanSymbol(''), null);
  assert.equal(cleanSymbol('A'.repeat(30)), null);
});

test('mapLimit respects concurrency and captures failures', async () => {
  let running = 0, peak = 0;
  const res = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (x) => {
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    if (x === 3) throw new Error('boom');
    return x * 2;
  });
  assert.equal(peak, 2);
  assert.equal(res[2].ok, false);
  assert.equal(res[5].value, 12);
});

test('intraday bars: aligned to the session grid, live bar merged, times ascending', () => {
  const open = 1794800700; // 03:45:00 UTC = 09:15 IST session open
  const body = {
    chart: {
      result: [{
        meta: { symbol: 'X.NS', currency: 'INR', regularMarketPrice: 104, gmtoffset: 19800 },
        // three finished 1-min bars, then a stray "live" tick 27s into the 4th minute, twice
        timestamp: [open, open + 60, open + 120, open + 180, open + 207],
        indicators: { quote: [{ open: [100, 101, 102, 103, 103.5], high: [101, 102, 103, 103.6, 104.2], low: [99.5, 100.5, 101.5, 102.8, 103.4], close: [101, 102, 103, 103.5, 104], volume: [10, 20, 30, 5, 9] }] },
      }],
    },
  };
  const c = normalizeChart(body, 'X.NS', { step: 60 });
  assert.equal(c.candles.length, 4); // stray tick merged into the 4th bar
  const last = c.candles.at(-1);
  assert.equal(last.time, open + 180 + 19800); // exchange-local timestamp
  assert.equal(last.open, 103);
  assert.equal(last.high, 104.2);
  assert.equal(last.low, 102.8);
  assert.equal(last.close, 104);
  assert.equal(last.volume, 9);
  assert.ok(c.candles.every((k, i, arr) => typeof k.time === 'number' && (i === 0 || arr[i - 1].time < k.time)));
  // hourly bars keep the :15 session offset instead of snapping to the clock hour
  const h = normalizeChart({ chart: { result: [{ meta: { gmtoffset: 19800, regularMarketPrice: 11 }, timestamp: [open, open + 3600, open + 3600 + 900], indicators: { quote: [{ open: [10, 11, 11], high: [11, 12, 12], low: [9, 10, 10], close: [11, 11, 11], volume: [1, 1, 1] }] } }] } }, 'X', { step: 3600 });
  assert.deepEqual(h.candles.map((k) => k.time - 19800), [open, open + 3600]);
});

test('academy: English and Malayalam courses are complete and in sync', async () => {
  const load = async (f) => (await import(new URL(`../public/academy/${f}`, import.meta.url))).default;
  const en = { ...(await load('lessons-en-1.js')), ...(await load('lessons-en-2.js')) };
  const ml = { ...(await load('lessons-ml-1.js')), ...(await load('lessons-ml-2.js')) };
  const src = (await import('node:fs')).readFileSync(new URL('../public/academy.js', import.meta.url), 'utf8');
  const order = [...src.matchAll(/\['([a-z-]+)', \d+\]/g)].map((m) => m[1]);
  assert.equal(order.length, 22);
  assert.equal(new Set(order).size, 22);
  assert.deepEqual(Object.keys(en).sort(), [...order].sort());
  assert.deepEqual(Object.keys(ml).sort(), [...order].sort());
  const TYPES = new Set(['h', 'p', 'ul', 'ol', 'tip', 'warn', 'ex', 'fig', 'try']);
  const figs = new Set(['candle', 'trend', 'sr', 'patterns', 'plan', 'cpatterns']);
  for (const id of order) {
    for (const [name, L] of [['en', en[id]], ['ml', ml[id]]]) {
      assert.ok(L.t && L.s && L.b.length >= 5, `${name}/${id} has content`);
      for (const b of L.b) {
        assert.ok(TYPES.has(b[0]), `${name}/${id} block type ${b[0]}`);
        if (b[0] === 'ul' || b[0] === 'ol') assert.ok(Array.isArray(b[1]) && b[1].every((x) => typeof x === 'string' && x.length));
        else assert.ok(typeof b[1] === 'string' && b[1].length);
        if (b[0] === 'fig') assert.ok(figs.has(b[1]), `${name}/${id} figure ${b[1]}`);
        if (b[0] === 'try') assert.match(b[2], /^#\/(dashboard|picks|analyze\/[A-Z0-9.%^]+)$/);
      }
      assert.ok(L.q.length >= 2, `${name}/${id} has a quiz`);
      for (const q of L.q) {
        assert.equal(q[1].length, 3);
        assert.ok(Number.isInteger(q[2]) && q[2] >= 0 && q[2] < 3);
        assert.ok(q[0] && q[3]);
      }
      // balanced **bold** markers
      const text = JSON.stringify(L);
      assert.equal((text.match(/\*\*/g) || []).length % 2, 0, `${name}/${id} bold markers balanced`);
    }
    // same structure in both languages
    assert.deepEqual(ml[id].b.map((b) => b[0]), en[id].b.map((b) => b[0]), `${id}: same block sequence`);
    assert.deepEqual(ml[id].b.filter((b) => b[0] === 'fig' || b[0] === 'try').map((b) => b[2] ?? b[1]), en[id].b.filter((b) => b[0] === 'fig' || b[0] === 'try').map((b) => b[2] ?? b[1]), `${id}: same figures/links`);
    assert.deepEqual(ml[id].b.filter((b) => Array.isArray(b[1])).map((b) => b[1].length), en[id].b.filter((b) => Array.isArray(b[1])).map((b) => b[1].length), `${id}: same list lengths`);
    assert.deepEqual(ml[id].q.map((q) => q[2]), en[id].q.map((q) => q[2]), `${id}: same quiz answers`);
    // Malayalam lessons must actually be in Malayalam script
    assert.match(ml[id].t, /[\u0D00-\u0D7F]/);
  }
});

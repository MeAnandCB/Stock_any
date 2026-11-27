import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { escapeHtml, splitMessage, sendTelegram, sendAll, telegramConfigured, LIMIT } from '../lib/telegram.js';
import { pickIntraday, pickLongTerm, intradayState, buildDigest, localDate, IDEAS } from '../lib/digest.js';
import { runDigest } from '../lib/digest-job.js';
import { createServer } from '../server.js';

// ---------- fixtures ----------
const NOW = Date.UTC(2026, 10, 26, 5, 0, 0); // Thu 26 Nov 2026, 10:30 IST
const SESSION = '2026-11-26';
const intra = (symbol, { score = 70, rvol = 1.6, action = 'buy', best = false, scenario = 'Opening-range breakout', daily = 50, name } = {}) => ({
  symbol, name: name ?? `${symbol} Ltd`, currency: 'INR', price: 1000, dayChangePct: 1.2,
  intraday: {
    insufficient: false, sessionDate: SESSION, score, verdict: { key: 'strong_buy', label: 'Strong Buy' }, scenario: { key: 'orb_breakout', label: scenario },
    stats: { rvol, rsi: 62, dayChangePct: 1.2 },
    plan: { action, entryLow: 995.5, entryHigh: 1000, entry: 1000, stopLoss: 990, target1: 1020, target2: 1030, riskReward: 2 },
  },
  daily: { score: daily, verdict: { key: 'buy', label: 'Buy' }, longTermScore: 0, aboveSma200: false },
  best: { passed: best, passCount: best ? 9 : 5, total: 9 },
});
const long = (symbol, { lt = 60, above200 = true, verdict = 'buy', label = 'Buy', rsi = 60, action = 'buy', score = 40 } = {}) => ({
  symbol, name: `${symbol} Ltd`, currency: 'INR', price: 2500, dayChangePct: 0.4,
  intraday: { insufficient: true, tooEarly: true },
  daily: { score, verdict: { key: verdict, label }, longTermScore: lt, aboveSma200: above200, rsi, ret1y: 18.44, action, entryLow: 2480, entryHigh: 2500, stopLoss: 2310 },
  best: { passed: false, passCount: 0, total: 0 },
});
const scan = (items, over = {}) => ({
  market: 'IN', updated: NOW, marketOpen: true, minutesLeft: 330, sessionDate: SESSION,
  marketBias: { name: 'NIFTY 50', bias: 'bullish', changePct: 0.43 }, items, ...over,
});

// Telegram's HTML mode: only <b> <i> <a href="…"> are used; every other < > & must be escaped.
function assertTelegramHtml(text) {
  const stack = [];
  const re = /<(\/?)([a-z]+)([^>]*)>|[<>]|&(?!(amp|lt|gt|quot);)/gi;
  let m;
  while ((m = re.exec(text))) {
    if (!m[2]) assert.fail(`stray "${m[0]}" near: …${text.slice(Math.max(0, m.index - 20), m.index + 20)}…`);
    if (!['b', 'i', 'a'].includes(m[2])) assert.fail(`tag <${m[2]}> is not allowed`);
    if (m[1]) assert.equal(stack.pop(), m[2], `closing </${m[2]}> does not match`);
    else stack.push(m[2]);
  }
  assert.deepEqual(stack, [], 'every tag is closed');
}

// ---------- telegram helpers ----------
test('escapeHtml escapes exactly what Telegram needs', () => {
  assert.equal(escapeHtml('A&B <script>"x"</script>'), 'A&amp;B &lt;script&gt;"x"&lt;/script&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(42), '42');
});

test('splitMessage: short text is untouched; long text splits at blank lines, never loses content', () => {
  assert.deepEqual(splitMessage('hello\n\nworld'), ['hello\n\nworld']);
  const block = (i) => `[#${i}#] ${'x'.repeat(300)}\n   second line [#${i}#]`;
  const text = Array.from({ length: 40 }, (_, i) => block(i)).join('\n\n');
  const parts = splitMessage(text, 1000);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 1000, `part of ${p.length}`);
  for (let i = 0; i < 40; i++) assert.equal(parts.filter((p) => p.includes(block(i))).length, 1, `block ${i} is whole and appears once`);
  assert.equal(parts.join('\n\n').replace(/\s+/g, ''), text.replace(/\s+/g, ''), 'nothing lost or duplicated');
  // One enormous paragraph without blank lines, and one enormous single line.
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${'y'.repeat(50)}`).join('\n');
  for (const p of splitMessage(lines, 500)) assert.ok(p.length <= 500);
  const wall = 'z'.repeat(2500);
  const cut = splitMessage(wall, 1000);
  assert.deepEqual(cut.map((c) => c.length), [1000, 1000, 500]);
  assert.deepEqual(splitMessage('  \n\n  '), []);
  assert.equal(LIMIT < 4096, true);
});

// A stand-in for api.telegram.org: records requests and replies as scripted.
function fakeTelegram() {
  const seen = [];
  let replies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const reply = replies.shift() ?? { status: 200, body: { ok: true, result: { message_id: seen.length } } };
      seen.push({ url: req.url, body: JSON.parse(raw || '{}') });
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${server.address().port}`, seen, script: (...r) => (replies = r), close: () => server.close(),
  })));
}
const TOKEN = '123456789:AAFakeTokenFakeTokenFakeToken_abc-123';
const withTelegram = async (fn, extra = {}) => {
  const tg = await fakeTelegram();
  const keep = ['TELEGRAM_API_BASE', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'].map((k) => [k, process.env[k]]);
  Object.assign(process.env, { TELEGRAM_API_BASE: tg.base, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '555', ...extra });
  try { return await fn(tg); } finally {
    tg.close();
    for (const [k, v] of keep) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
};

test('sendTelegram posts the right request and returns the result', async () => {
  await withTelegram(async (tg) => {
    assert.equal(telegramConfigured(), true);
    const r = await sendTelegram('hello <b>x</b>');
    assert.equal(r.message_id, 0);
    assert.equal(tg.seen[0].url, `/bot${TOKEN}/sendMessage`);
    assert.deepEqual(tg.seen[0].body, { chat_id: '555', text: 'hello <b>x</b>', parse_mode: 'HTML', disable_web_page_preview: true });
    assert.equal(await sendAll(['a', 'b', 'c']), 3);
    assert.equal(tg.seen.length, 4);
  });
});

test('Telegram errors are explained, never contain the token, and 429 is retried once', async () => {
  await withTelegram(async (tg) => {
    tg.script({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } });
    await assert.rejects(sendTelegram('x'), (e) => /chat not found/.test(e.message) && /Start/.test(e.message) && !e.message.includes(TOKEN) && e.status === 502);
    tg.script({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } });
    await assert.rejects(sendTelegram('x'), /token is wrong/);
    tg.script({ status: 400, body: { ok: false, description: `can't parse entities near ${TOKEN}` } });
    await assert.rejects(sendTelegram('x'), (e) => !e.message.includes(TOKEN) && /\*\*\*/.test(e.message));
    // rate limited -> waits, retries once, succeeds
    const n = tg.seen.length;
    tg.script({ status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } } });
    assert.ok(await sendTelegram('x'));
    assert.equal(tg.seen.length, n + 2);
    // ...but not forever
    tg.script(...Array(3).fill({ status: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 0 } } }));
    await assert.rejects(sendTelegram('x'), /Too Many Requests/);
  });
  // A dropped connection is retried, so one network blip does not cost the morning's digest.
  await withTelegram(async (tg) => {
    let calls = 0;
    const flaky = async (...a) => { if (++calls < 3) throw Object.assign(new TypeError('fetch failed'), { cause: new Error('read ECONNRESET') }); return fetch(...a); };
    assert.ok(await sendTelegram('x', { fetchImpl: flaky }));
    assert.equal(calls, 3);
    assert.equal(tg.seen.length, 1, 'delivered once');
    let tries = 0;
    const dead = async () => { tries++; throw Object.assign(new TypeError('fetch failed'), { cause: new Error(`connect ECONNREFUSED ${TOKEN}`) }); };
    await assert.rejects(sendTelegram('x', { fetchImpl: dead }), (e) => /Could not reach Telegram/.test(e.message) && !e.message.includes(TOKEN));
    assert.equal(tries, 3, 'gives up after three tries');
  });
  // Telegram unreachable: the error says so and still hides the token.
  await withTelegram(async () => {
    await assert.rejects(sendTelegram('x'), (e) => /Could not reach Telegram/.test(e.message) && !e.message.includes(TOKEN));
  }, { TELEGRAM_API_BASE: 'http://127.0.0.1:1' });
  await withTelegram(async () => {
    assert.equal(telegramConfigured(), false);
    await assert.rejects(sendTelegram('x'), (e) => e.status === 503 && /not set up/.test(e.message));
  }, { TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' });
});

// ---------- choosing ----------
test('pickIntraday: ONLY stocks that pass every check (plain buy signals lost money in testing), at most five', () => {
  const items = [
    intra('PLAIN', { score: 99 }), intra('P1', { score: 60, best: true }), intra('P2', { score: 90, best: true }), intra('WAIT', { action: 'wait', score: 99 }),
    ...['A', 'B', 'C', 'D', 'E'].map((x, i) => intra(x, { score: 55 + i, best: true })),
    { symbol: 'EARLY', intraday: { insufficient: true, tooEarly: true }, daily: null }, { symbol: 'NOINTRA', intraday: null, daily: null },
  ];
  const picked = pickIntraday(items).map((x) => x.symbol);
  assert.equal(picked.length, IDEAS);
  assert.equal(picked[0], 'P2', 'strongest first');
  for (const bad of ['PLAIN', 'WAIT', 'EARLY', 'NOINTRA']) assert.ok(!picked.includes(bad), bad);
  assert.deepEqual(pickIntraday([intra('ONLY', { best: true })]).map((x) => x.symbol), ['ONLY'], 'fewer than five is fine — never padded');
  assert.deepEqual(pickIntraday([intra('PLAIN')]), [], 'a plain buy signal is never put forward');
});

test('pickLongTerm: strongest steady uptrends, above the 200-day average, not rated Sell', () => {
  const items = [
    long('A', { lt: 55 }), long('B', { lt: 80 }), long('C', { lt: 70, verdict: 'hold', label: 'Hold / Wait', action: 'wait' }),
    long('SELL', { lt: 90, verdict: 'sell', label: 'Sell / Avoid' }), long('BELOW', { lt: 95, above200: false }), long('WEAK', { lt: 19 }),
    long('D', { lt: 40 }), long('E', { lt: 45 }), long('F', { lt: 30 }), long('TIE1', { lt: 55, score: 10 }), long('TIE2', { lt: 55, score: 60 }),
    { symbol: 'NODAILY', daily: null, intraday: null },
  ];
  const picked = pickLongTerm(items).map((x) => x.symbol);
  assert.deepEqual(picked, ['B', 'C', 'TIE2', 'A', 'TIE1'], 'sorted by trend score, ties by daily score');
  for (const bad of ['SELL', 'BELOW', 'WEAK', 'NODAILY']) assert.ok(!picked.includes(bad), bad);
  assert.deepEqual(pickLongTerm([long('X', { lt: 10 })]), []);
});

test('intradayState tells the truth about what the data can support', () => {
  const live = [intra('A')];
  assert.equal(intradayState(scan(live), NOW), 'live');
  assert.equal(intradayState(scan(live, { marketOpen: false }), NOW), 'closed');
  assert.equal(intradayState(scan(live, { sessionDate: '2026-11-25' }), NOW), 'stale', 'open flag but data is from another day');
  assert.equal(intradayState(scan(live, { minutesLeft: 20 }), NOW), 'late');
  assert.equal(intradayState(scan(live, { minutesLeft: 45 }), NOW), 'live');
  const early = [{ symbol: 'A', intraday: { insufficient: true, tooEarly: true } }, { symbol: 'B', intraday: { insufficient: true, tooEarly: true } }];
  assert.equal(intradayState(scan(early, { sessionDate: null }), NOW), 'too_early');
  assert.equal(intradayState(scan([{ symbol: 'A', intraday: null }], { sessionDate: null }), NOW), 'stale');
  assert.equal(localDate(Date.UTC(2026, 10, 25, 20, 0), 'IN'), '2026-11-26', 'India is already tomorrow at 20:00 UTC');
  assert.equal(localDate(Date.UTC(2026, 10, 25, 20, 0), 'US'), '2026-11-25');
});

// ---------- the message ----------
test('a live morning digest lists intraday and long-term ideas in valid Telegram HTML', () => {
  const items = [intra('HDFCBANK.NS', { best: true, score: 84 }), intra('SBIN.NS'), long('TCS.NS', { lt: 62, rsi: 72 }), long('TITAN.NS', { lt: 50, verdict: 'hold', label: 'Hold / Wait', action: 'wait' }),
    long('WIPRO.NS', { lt: 10, verdict: 'strong_buy', label: 'Strong Buy', score: 66, rsi: 58 })];
  const d = buildDigest(scan(items), NOW, { appUrl: 'https://example.vercel.app/' });
  assert.equal(d.state, 'live');
  assert.equal(d.messages.length, 1);
  assertTelegramHtml(d.text);
  assert.match(d.text, /<b>StockSense morning digest<\/b>/);
  assert.match(d.text, /Thu 26 Nov, 10:30 IST/);
  assert.match(d.text, /NIFTY 50 \+0\.4% \(bullish\) · market open, 5 h 30 min left/);
  assert.match(d.text, /1\. <b>HDFCBANK<\/b> ₹1,000\.00 \(\+1\.2%\) — Opening-range breakout\n/);
  assert.match(d.text, /Buy ₹995\.50–₹1,000\.00 · Stop ₹990\.00 · Sell by 3:15 PM \(optional target ₹1,020\.00\)/);
  assert.ok(!d.text.includes('SBIN'), 'a plain buy signal is not sent');
  assert.match(d.text, /Testing: Slightly positive — NOT proven\. 78 past trades/);
  assert.match(d.text, /Short term<\/b> — 1 to 4 weeks\n1\. <b>WIPRO<\/b> ₹2,500\.00 — Daily score \+66 · RSI 58/);
  assert.match(d.text, /Short term[\s\S]*Testing: Slightly positive — NOT proven\. 938 past trades/);
  assert.match(d.text, /ideas to research, not buy calls/);
  assert.match(d.text, /Did NOT beat simply holding all the stocks/);
  assert.match(d.text, /Score \+84 · volume 1\.6× normal · RSI 62/);
  assert.match(d.text, /1\. <b>TCS<\/b> ₹2,500\.00 — Trend \+62 · 1Y \+18\.4% · RSI 72 · Daily: Buy/);
  assert.match(d.text, /Buy zone ₹2,480\.00–₹2,500\.00 · Exit if it closes below ₹2,310\.00 · ⚠ stretched — stagger your buying/);
  assert.match(d.text, /Wait for a dip to ₹2,480\.00–₹2,500\.00/);
  assert.match(d.text, /not investment advice/);
  assert.match(d.text, /<a href="https:\/\/example\.vercel\.app\/#\/final">Open StockSense<\/a>/);
  assert.deepEqual(d.intraday.map((x) => x.symbol), ['HDFCBANK.NS']);
});

test('names are escaped, so nothing in the data can break or inject into the message', () => {
  const evil = intra('<b>EVIL&CO.NS', { scenario: 'Break <out> & run', best: true });
  const d = buildDigest(scan([evil, long('A&B.NS', { lt: 60 })]), NOW, { appUrl: 'https://x.y/"><script>' });
  assertTelegramHtml(d.text);
  assert.ok(d.text.includes('&lt;b&gt;EVIL&amp;CO'));
  assert.ok(d.text.includes('Break &lt;out&gt; &amp; run'));
  assert.ok(!d.text.includes('<script'), 'a malformed APP_URL never reaches the message');
  const noLink = buildDigest(scan([intra('A')]), NOW, { appUrl: 'javascript:alert(1)' });
  assert.ok(!noLink.text.includes('<a '), 'only http(s) links are added');
});

test('the digest is honest when intraday ideas are not possible, but still gives long-term ideas', () => {
  const items = [intra('A'), long('TCS.NS', { lt: 60 })];
  for (const [over, phrase] of [
    [{ marketOpen: false, minutesLeft: null }, /not open right now/],
    [{ minutesLeft: 20 }, /too late to start a new intraday trade/],
    [{ sessionDate: '2026-11-25' }, /not from today/],
  ]) {
    const d = buildDigest(scan(items, over), NOW);
    assertTelegramHtml(d.text);
    assert.match(d.text, phrase);
    assert.ok(!/Buy ₹/.test(d.text.split('Long-term')[0]), 'no buy levels are shown for intraday');
    assert.match(d.text, /<b>TCS<\/b>/, 'long-term ideas are still there');
  }
  const early = buildDigest(scan([{ symbol: 'A', intraday: { insufficient: true, tooEarly: true }, daily: null }], { sessionDate: null }), NOW);
  assert.match(early.text, /only just opened/);
  assert.match(early.text, /No large cap currently shows a strong, steady long-term uptrend/);
  const none = buildDigest(scan([intra('W')]), NOW);
  assert.match(none.text, /No stock passes every check right now.*no trade/s);
});

test('the US digest uses dollars and New York time', () => {
  const us = { ...intra('AAPL', { best: true }), currency: 'USD', price: 354.07 };
  const d = buildDigest({ ...scan([us], { sessionDate: '2026-11-25' }), market: 'US' }, Date.UTC(2026, 10, 25, 15, 0), {});
  assert.match(d.text, /Wed 25 Nov, 10:00 ET/);
  assert.match(d.text, /United States/);
  assert.match(d.text, /<b>AAPL<\/b> \$354\.07/);
  assert.ok(!d.text.includes('₹'));
  assert.ok(!/past trades/.test(d.text), 'India test results are never quoted for another market');
});

test('an oversized digest is split into several messages that are each valid', () => {
  const many = Array.from({ length: 5 }, (_, i) => intra(`S${i}.NS`, { best: true, scenario: 'Opening-range breakout '.repeat(30) }));
  const d = buildDigest(scan(many), NOW);
  assert.ok(d.messages.length > 1);
  for (const m of d.messages) assert.ok(m.length <= LIMIT);
});

// ---------- the job ----------
function fakeDb() {
  const docs = new Map();
  const calls = { deleted: [], updated: [] };
  return {
    docs, calls,
    collection: () => ({
      insertOne: async (d) => { if (docs.has(d._id)) throw Object.assign(new Error('dup'), { code: 11000 }); docs.set(d._id, d); },
      deleteOne: async ({ _id }) => { calls.deleted.push(_id); docs.delete(_id); },
      updateOne: async ({ _id }, u) => { calls.updated.push(_id); docs.set(_id, { ...docs.get(_id), ...u.$set }); },
    }),
  };
}
const liveScan = () => async () => scan([intra('HDFCBANK.NS', { best: true }), long('TCS.NS', { lt: 62 })]);

test('runDigest: dry run builds the message and sends nothing', async () => {
  let sent = 0;
  const r = await runDigest({ dry: true, now: NOW, scan: liveScan(), send: async () => { sent++; } });
  assert.equal(r.dry, true);
  assert.equal(r.sent, false);
  assert.equal(sent, 0);
  assert.deepEqual([r.intraday, r.longTerm, r.state], [['HDFCBANK.NS'], ['TCS.NS'], 'live']);
});

test('runDigest sends once a day: a second call is skipped unless forced; a failed send can be retried', async () => {
  const db = fakeDb();
  const sends = [];
  const send = async (m) => sends.push(m);
  const first = await runDigest({ now: NOW, scan: liveScan(), send, db });
  assert.equal(first.sent, true);
  assert.equal(sends.length, 1);
  const doc = db.docs.get('IN:2026-11-26');
  assert.equal(doc.state, 'live');
  assert.equal(doc.intraday[0].symbol, 'HDFCBANK.NS', 'the ideas are saved with their levels');
  assert.equal(doc.intraday[0].stopLoss, 990);
  assert.deepEqual(doc.longTerm, ['TCS.NS']);

  const again = await runDigest({ now: NOW + 60000, scan: liveScan(), send, db });
  assert.equal(again.sent, false);
  assert.match(again.reason, /already sent today/);
  assert.equal(sends.length, 1);
  assert.equal((await runDigest({ now: NOW + 90000, scan: liveScan(), send, db, force: true })).sent, true);
  assert.equal(sends.length, 2);
  // Tomorrow is a new day.
  assert.equal((await runDigest({ now: NOW + 86400000, scan: liveScan(), send, db })).sent, true);

  // A send that fails gives the claim back so the retry works, and the error reaches the caller.
  const db2 = fakeDb();
  await assert.rejects(runDigest({ now: NOW, scan: liveScan(), db: db2, send: async () => { throw new Error('Telegram down'); } }), /Telegram down/);
  assert.deepEqual(db2.calls.deleted, ['IN:2026-11-26']);
  assert.equal((await runDigest({ now: NOW, scan: liveScan(), db: db2, send })).sent, true);
});

test('runDigest is not blocked by a broken database, and refuses cleanly without Telegram settings', async () => {
  const broken = { collection: () => ({ insertOne: async () => { throw new Error('db down'); }, deleteOne: async () => {}, updateOne: async () => {} }) };
  const sends = [];
  const r = await runDigest({ now: NOW, scan: liveScan(), send: async (m) => sends.push(m), db: broken });
  assert.equal(r.sent, true, 'the digest matters more than the bookkeeping');
  const keep = [process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID];
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  try {
    await assert.rejects(runDigest({ now: NOW, scan: liveScan() }), (e) => e.status === 503 && /TELEGRAM_BOT_TOKEN/.test(e.message));
    assert.equal((await runDigest({ now: NOW, scan: liveScan(), dry: true })).dry, true, 'a dry run needs no Telegram settings');
  } finally {
    if (keep[0] !== undefined) process.env.TELEGRAM_BOT_TOKEN = keep[0];
    if (keep[1] !== undefined) process.env.TELEGRAM_CHAT_ID = keep[1];
  }
});

test('a digest really reaches (a fake) Telegram, end to end through runDigest', async () => {
  await withTelegram(async (tg) => {
    const r = await runDigest({ now: NOW, scan: liveScan(), db: fakeDb() });
    assert.equal(r.sent, true);
    assert.equal(tg.seen.length, 1);
    assert.equal(tg.seen[0].body.chat_id, '555');
    assert.match(tg.seen[0].body.text, /StockSense morning digest/);
    assertTelegramHtml(tg.seen[0].body.text);
  });
});

// ---------- the protected endpoint ----------
test('/api/cron/digest cannot be triggered without the secret', async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (headers = {}, query = '') => fetch(`http://127.0.0.1:${port}/api/cron/digest${query}`, { headers }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const keep = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    const off = await call({ Authorization: 'Bearer anything' });
    assert.equal(off.status, 503, 'not set up -> nobody can trigger it');
    assert.match(off.json.error, /CRON_SECRET/);
    process.env.CRON_SECRET = 'correct-horse-battery-staple';
    assert.equal((await call()).status, 401);
    assert.equal((await call({ Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await call({ Authorization: 'correct-horse-battery-staple' })).status, 401, 'must be a Bearer token');
    assert.equal((await call({ Authorization: 'Bearer correct-horse-battery-stapleX' })).status, 401);
    const bad = await call({ Authorization: 'Bearer correct-horse-battery-staple' }, '?market=XX');
    assert.equal(bad.status, 400, 'with the right secret, an unknown market is rejected before any scan');
    assert.equal(JSON.stringify([(await call({ Authorization: 'Bearer nope' })).json]).includes('correct-horse'), false);
  } finally {
    if (keep === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = keep;
    server.close();
  }
});

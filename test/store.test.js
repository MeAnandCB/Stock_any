import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, loadEnv } from '../lib/env.js';
import { safeError, getDb, closeDb, dbEnabled } from '../lib/db.js';
import {
  scanDocument, pickOperations, persistBoard, ensureIndexes, listPicks, listScans, dbStats, resetStoreCache,
} from '../lib/store.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ---------- fixtures ----------
const T = Date.UTC(2026, 10, 25, 5, 33, 0); // 11:03 IST
const mkItem = (symbol, over = {}) => ({
  symbol, name: `${symbol} Ltd`, currency: 'INR', price: 100, dayChangePct: 1.2,
  intraday: {
    insufficient: false, score: 76, verdict: { key: 'strong_buy', label: 'Strong Buy' }, scenario: { key: 'orb_breakout' },
    stats: { vsVwapPct: 0.8, orb: 'above', rvol: 1.9, rsi: 62, gapPct: 0.1 },
    plan: { action: 'buy', entryLow: 99.5, entryHigh: 100, entry: 100, stopLoss: 98.8, target1: 102.4, target2: 103.6, riskReward: 2, riskPct: 1.2 },
  },
  daily: { score: 60, verdict: { key: 'strong_buy' } },
  best: { passed: true, passCount: 9, total: 9, checks: [{ key: 'x', ok: true }] },
  ...over,
});
const mkResult = (over = {}) => {
  const a = mkItem('AAA.NS');
  const b = mkItem('BBB.NS');
  const weak = mkItem('CCC.NS', { best: { passed: false, passCount: 4, total: 9, checks: [] }, daily: null });
  const early = { symbol: 'EARLY.NS', name: 'Early', price: 5, intraday: { insufficient: true }, daily: null };
  return {
    market: 'IN', updated: T, marketOpen: true, minutesLeft: 200, sessionDate: '2026-11-25',
    marketBias: { name: 'NIFTY 50', bias: 'bullish', changePct: 0.8 },
    counts: { orb_breakout: 2, range_bound: 1 },
    items: [a, b, weak, early], best: [a, b], strongBuyDaily: [a, b], strongBuyIntraday: [a, b],
    ...over,
  };
};

// ---------- env file ----------
test('parseEnv handles comments, quotes, export and trailing comments', () => {
  const v = parseEnv([
    '# a comment', '', 'MONGODB_URI=mongodb+srv://u:p%23w@cluster0.x.mongodb.net/?retryWrites=true',
    'MONGODB_DB = "my db"', "NAME='single'", 'export EXPORTED=yes', 'TRAILING=value # note', 'bad line', '1BAD=x', 'EMPTY=',
  ].join('\r\n'));
  assert.equal(v.MONGODB_URI, 'mongodb+srv://u:p%23w@cluster0.x.mongodb.net/?retryWrites=true');
  assert.equal(v.MONGODB_DB, 'my db');
  assert.equal(v.NAME, 'single');
  assert.equal(v.EXPORTED, 'yes');
  assert.equal(v.TRAILING, 'value');
  assert.equal(v.EMPTY, '');
  assert.ok(!('1BAD' in v));
});

test('loadEnv fills only unset variables and reports names, not values', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ss-env-'));
  const file = path.join(dir, '.env');
  writeFileSync(file, 'SS_TEST_NEW=from-file\nSS_TEST_KEEP=from-file\n');
  process.env.SS_TEST_KEEP = 'from-real-env';
  delete process.env.SS_TEST_NEW;
  const set = loadEnv(file);
  assert.deepEqual(set, ['SS_TEST_NEW']);
  assert.equal(process.env.SS_TEST_NEW, 'from-file');
  assert.equal(process.env.SS_TEST_KEEP, 'from-real-env', 'real environment wins');
  assert.deepEqual(loadEnv(path.join(dir, 'missing.env')), [], 'missing file is fine');
  delete process.env.SS_TEST_NEW;
  delete process.env.SS_TEST_KEEP;
});

test('safeError never leaks a connection string or password', () => {
  const e = new Error('getaddrinfo failed for mongodb+srv://anand:S3cret!@cluster0.abc.mongodb.net/stocks?x=1 (retrying)');
  const m = safeError(e);
  assert.ok(!m.includes('S3cret') && !m.includes('anand'), m);
  assert.match(m, /mongodb:\/\/\*\*\*/);
  assert.ok(!safeError(new Error('bad auth for //user:pass@host/db')).includes('pass'));
  assert.equal(safeError(null), 'Unknown database error');
  assert.ok(safeError(new Error('x'.repeat(1000))).length <= 300);
});

// ---------- documents ----------
test('scanDocument: open market buckets by 5 minutes, closed market is one per session', () => {
  const open = scanDocument(mkResult());
  assert.equal(open._id, `IN:${Math.floor(T / 300000)}`);
  assert.equal(scanDocument(mkResult({ updated: T + 60000 }))._id, open._id, 'same 5-minute bucket');
  assert.notEqual(scanDocument(mkResult({ updated: T + 300000 }))._id, open._id, 'next bucket');
  assert.equal(scanDocument(mkResult({ marketOpen: false }))._id, 'IN:2026-11-25:closed');
  assert.equal(open.ts.getTime(), T);
  assert.deepEqual(open.best, ['AAA.NS', 'BBB.NS']);
  assert.deepEqual(open.marketBias, { name: 'NIFTY 50', bias: 'bullish', changePct: 0.8 });
  assert.equal(open.items.length, 4);
  const [a, , weak, early] = open.items;
  assert.deepEqual(a.intraday.plan, { action: 'buy', entry: 100, stopLoss: 98.8, target1: 102.4, target2: 103.6, riskReward: 2 });
  assert.equal(a.intraday.scenario, 'orb_breakout');
  assert.equal(a.daily.verdict, 'strong_buy');
  assert.equal(a.bestPassed, true);
  assert.equal(weak.bestPassed, false);
  assert.equal(weak.daily, null);
  assert.equal(early.intraday, null, 'too-early stocks are kept, without analysis');
  assert.ok(!JSON.stringify(open).includes('checks'), 'the long check list is not stored per stock');
});

test('scanDocument copes with a minimal result (no bias, no lists)', () => {
  const d = scanDocument({ market: 'US', marketOpen: false, items: [] }, T);
  assert.equal(d._id, 'US:unknown:closed');
  assert.equal(d.marketBias, null);
  assert.deepEqual(d.best, []);
  assert.equal(d.ts.getTime(), T);
});

test('pickOperations: only while open; levels frozen on insert, "last seen" updated; no field clashes', () => {
  assert.deepEqual(pickOperations(mkResult({ marketOpen: false })), []);
  const ops = pickOperations(mkResult());
  assert.equal(ops.length, 2);
  const { filter, update, upsert } = ops[0].updateOne;
  assert.equal(upsert, true);
  assert.equal(filter._id, 'IN:2026-11-25:AAA.NS');
  const frozen = update.$setOnInsert;
  assert.deepEqual([frozen.entry, frozen.stopLoss, frozen.target1, frozen.target2], [100, 98.8, 102.4, 103.6]);
  assert.equal(frozen.scenario, 'orb_breakout');
  assert.equal(frozen.checksPassed, 9);
  assert.equal(frozen.firstSeen.getTime(), T);
  assert.equal(update.$set.rank, 1);
  assert.equal(ops[1].updateOne.update.$set.rank, 2);
  // MongoDB rejects an update that touches the same field in two operators.
  const overlap = Object.keys(frozen).filter((k) => k in update.$set);
  assert.deepEqual(overlap, []);
});

// ---------- persistBoard without / with a broken database ----------
test('persistBoard is a harmless no-op when no database is configured', async () => {
  const saved = process.env.MONGODB_URI;
  delete process.env.MONGODB_URI;
  assert.equal(dbEnabled(), false);
  assert.deepEqual(await persistBoard(mkResult()), { saved: false, reason: 'disabled' });
  assert.equal(await getDb(), null);
  if (saved !== undefined) process.env.MONGODB_URI = saved;
});

test('persistBoard never throws when the database misbehaves, and hides secrets in the error', async () => {
  resetStoreCache();
  const boom = {
    collection: () => ({
      createIndex: async () => {},
      dropIndex: async () => {},
      replaceOne: async () => { throw new Error('connect failed mongodb://bob:hunter2@db.example.com/x'); },
    }),
  };
  const origError = console.error;
  console.error = () => {}; // the failure is logged once; keep test output clean
  try {
    const r = await persistBoard(mkResult(), { db: boom });
    assert.equal(r.saved, false);
    assert.equal(r.reason, 'error');
    assert.ok(!r.error.includes('hunter2'));
  } finally {
    console.error = origError;
  }
  // A database that never answers is cut off by the time limit instead of hanging the page.
  const hang = { collection: () => ({ createIndex: () => new Promise(() => {}), dropIndex: async () => {} }) };
  console.error = () => {};
  try {
    const t0 = Date.now();
    const r = await persistBoard(mkResult(), { db: hang, timeoutMs: 80 });
    assert.equal(r.reason, 'error');
    assert.ok(Date.now() - t0 < 1000);
  } finally {
    console.error = origError;
  }
});

test('an unreachable database fails fast, then backs off instead of retrying every request', async () => {
  const saved = { uri: process.env.MONGODB_URI, db: process.env.MONGODB_DB };
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/';
  process.env.MONGODB_TIMEOUT_MS = '300';
  await closeDb();
  try {
    const t0 = Date.now();
    await assert.rejects(getDb());
    assert.ok(Date.now() - t0 < 3000, 'gives up within the connection timeout');
    const t1 = Date.now();
    await assert.rejects(getDb());
    assert.ok(Date.now() - t1 < 50, 'second call is rejected immediately during the cool-down');
    const origError = console.error;
    console.error = () => {};
    const r = await persistBoard(mkResult());
    console.error = origError;
    assert.equal(r.saved, false);
  } finally {
    await closeDb();
    delete process.env.MONGODB_TIMEOUT_MS;
    if (saved.uri === undefined) delete process.env.MONGODB_URI; else process.env.MONGODB_URI = saved.uri;
    if (saved.db === undefined) delete process.env.MONGODB_DB; else process.env.MONGODB_DB = saved.db;
  }
});

// ---------- real MongoDB (set TEST_MONGODB_URI to run) ----------
const URI = process.env.TEST_MONGODB_URI;
test('against a real MongoDB: idempotent saves, frozen pick levels, reads, indexes, TTL changes', { skip: !URI && 'set TEST_MONGODB_URI to run' }, async () => {
  const keep = { uri: process.env.MONGODB_URI, db: process.env.MONGODB_DB, ttl: process.env.SCAN_TTL_DAYS };
  const dbName = `stocksense_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  process.env.MONGODB_URI = URI;
  process.env.MONGODB_DB = dbName;
  delete process.env.SCAN_TTL_DAYS;
  resetStoreCache();
  await closeDb();
  try {
    const db = await getDb();
    assert.equal(db.databaseName, dbName);

    // 1. first save while open
    const r1 = await persistBoard(mkResult());
    assert.deepEqual([r1.saved, r1.scanSaved, r1.picks], [true, true, 2]);

    // 2. a refresh inside the same 5-minute bucket does not write another scan, and picks keep their original levels
    const moved = mkResult({ updated: T + 60000 });
    moved.best[0] = mkItem('AAA.NS', { price: 101.5 });
    moved.best[0].intraday.plan = { ...moved.best[0].intraday.plan, entry: 101.5, stopLoss: 100.1, target1: 104.2 };
    moved.best[0].intraday.score = 83;
    const r2 = await persistBoard(moved);
    assert.deepEqual([r2.saved, r2.scanSaved], [true, false]);
    assert.equal(await db.collection('scans').countDocuments(), 1);
    assert.equal(await db.collection('picks').countDocuments(), 2);
    const aaa = await db.collection('picks').findOne({ _id: 'IN:2026-11-25:AAA.NS' });
    assert.equal(aaa.entry, 100, 'entry stays as first signalled');
    assert.equal(aaa.stopLoss, 98.8);
    assert.equal(aaa.signalScore, 76);
    assert.equal(aaa.lastScore, 83, 'but "last seen" moves on');
    assert.equal(aaa.lastPrice, 101.5);
    assert.equal(aaa.lastSeen.getTime(), T + 60000);
    assert.equal(aaa.firstSeen.getTime(), T);

    // 3. a later bucket stores a new scan; a second process (empty cache) overwrites rather than duplicates
    await persistBoard(mkResult({ updated: T + 300000 }));
    assert.equal(await db.collection('scans').countDocuments(), 2);
    resetStoreCache();
    await persistBoard(mkResult({ updated: T + 300000 }));
    assert.equal(await db.collection('scans').countDocuments(), 2, 'no duplicate after cache reset');

    // 4. after the close: one snapshot per session, and no picks
    const closed = { marketOpen: false, updated: T + 9 * 3600000 };
    await persistBoard(mkResult(closed));
    await persistBoard(mkResult({ ...closed, updated: closed.updated + 600000 }));
    resetStoreCache();
    await persistBoard(mkResult({ ...closed, updated: closed.updated + 1200000 }));
    assert.equal(await db.collection('scans').countDocuments({ marketOpen: false }), 1);
    assert.equal(await db.collection('picks').countDocuments(), 2);

    // 5. other markets are kept apart
    await persistBoard(mkResult({ market: 'US', sessionDate: '2026-11-24' }));
    assert.equal((await listPicks(db, { market: 'US' })).length, 2);

    // 6. reads
    const picks = await listPicks(db, { market: 'IN', limit: 10 });
    assert.equal(picks.length, 2);
    assert.equal(picks[0].id.startsWith('IN:2026-11-25:'), true);
    assert.ok(!('_id' in picks[0]));
    assert.deepEqual(JSON.parse(JSON.stringify(picks[0])).firstSeen, new Date(T).toISOString());
    const scans = await listScans(db, { market: 'IN', limit: 10 });
    assert.equal(scans.length, 3);
    assert.ok(scans.every((s) => !('items' in s)), 'list view leaves out the heavy per-stock rows');
    assert.ok(scans[0].ts >= scans[1].ts, 'newest first');
    const full = await db.collection('scans').findOne({ _id: scans[0].id });
    assert.equal(full.items.length, 4);
    assert.deepEqual(await dbStats(db), { scans: 4, picks: 4 });

    // 7. indexes + retention
    const idx = async (d, c) => Object.fromEntries((await d.collection(c).indexes()).map((i) => [i.name, i]));
    let s = await idx(db, 'scans');
    assert.equal(s.ts_ttl.expireAfterSeconds, 30 * 86400);
    assert.ok(s.market_ts);
    assert.ok((await idx(db, 'picks')).market_firstSeen);
    await closeDb();
    process.env.SCAN_TTL_DAYS = '7'; // retention changed -> index is rebuilt, not an error
    const db2 = await getDb();
    await ensureIndexes(db2);
    s = await idx(db2, 'scans');
    assert.equal(s.ts_ttl.expireAfterSeconds, 7 * 86400);
    await closeDb();
    process.env.SCAN_TTL_DAYS = '0'; // keep forever -> TTL index removed
    const db3 = await getDb();
    await ensureIndexes(db3);
    assert.ok(!('ts_ttl' in (await idx(db3, 'scans'))));
  } finally {
    try {
      const db = await getDb();
      await db.dropDatabase();
    } catch { /* best effort */ }
    await closeDb();
    for (const [k, v] of [['MONGODB_URI', keep.uri], ['MONGODB_DB', keep.db], ['SCAN_TTL_DAYS', keep.ttl]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    resetStoreCache();
  }
});

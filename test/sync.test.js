import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNC_KEYS, CODE_ALPHABET, generateCode, normalizeCode, sanitizeItems, planSync, createEngine, SyncError, MAX_ITEM_BYTES,
} from '../lib/sync-core.js';
import { hashCode } from '../lib/sync.js';
import { createLimiter } from '../lib/ratelimit.js';
import { createServer, resetSyncLimits } from '../server.js';
import { closeDb, getDb } from '../lib/db.js';

const randomBytes = () => crypto.getRandomValues(new Uint8Array(32));
const J = JSON.stringify;
const ACCOUNT = { v: 1, market: 'IN', cash: 951234.5, startFunds: 1000000, orders: [{ id: 1 }, { id: 2 }], trades: [{ id: 1 }], holdings: [{ symbol: 'TCS.NS', qty: 10 }], positions: [], seq: 2 };

// ---------- sync code ----------
test('generated codes are well-formed, unique and survive sloppy typing', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const code = generateCode(randomBytes());
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/, code);
    assert.equal(normalizeCode(code), code);
    assert.equal(normalizeCode(code.toLowerCase()), code, 'lower case');
    assert.equal(normalizeCode(code.replace(/-/g, ' ')), code, 'spaces instead of dashes');
    assert.equal(normalizeCode(`  ${code.replace(/-/g, '')}\n`), code, 'no dashes, stray whitespace');
    seen.add(code);
  }
  assert.equal(seen.size, 500);
  assert.equal(normalizeCode(generateCode(new Uint8Array(24)).replace(/0/g, 'o')), generateCode(new Uint8Array(24)), 'letter O is read as zero');
  assert.throws(() => generateCode(new Uint8Array(5)));
});

test('any single mistyped character is caught by the check character', () => {
  const code = generateCode(randomBytes());
  const raw = code.replace(/-/g, '');
  let tried = 0;
  for (let i = 0; i < raw.length; i++) {
    for (const c of CODE_ALPHABET) {
      if (c === raw[i]) continue;
      tried++;
      assert.equal(normalizeCode(raw.slice(0, i) + c + raw.slice(i + 1)), null, `position ${i} -> ${c}`);
    }
  }
  assert.equal(tried, 25 * 31);
  for (const bad of [null, undefined, 42, '', 'ABC', code + 'A', code.slice(0, -1), `${code}${code}`, 'x'.repeat(500), code.replace(/^./, 'U')]) {
    assert.equal(normalizeCode(bad), null, String(bad).slice(0, 20));
  }
});

test('codes are not stored in the clear: the server keeps only a hash', () => {
  const code = generateCode(randomBytes());
  const h = hashCode(code);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(!h.includes(code.replace(/-/g, '').toLowerCase().slice(0, 8)));
  assert.notEqual(hashCode(code), hashCode(generateCode(randomBytes())));
});

// ---------- items ----------
test('sanitizeItems keeps only synced keys and rejects malformed or oversized data', () => {
  const ok = sanitizeItems({ 'ss.watch': { json: J(['A']), updatedAt: 5.9 }, 'ss.theme': { json: '"dark"', updatedAt: 1 }, 'evil.key': { json: '1', updatedAt: 1 } });
  assert.deepEqual(ok, { 'ss.watch': { json: '["A"]', updatedAt: 5 } });
  assert.deepEqual(sanitizeItems(null), {});
  assert.deepEqual(sanitizeItems({}), {});
  const bad = (v) => { try { sanitizeItems(v); } catch (e) { return e instanceof SyncError ? e.status : 'other'; } return null; };
  assert.equal(bad([]), 400);
  assert.equal(bad('x'), 400);
  assert.equal(bad({ 'ss.watch': null }), 400);
  assert.equal(bad({ 'ss.watch': { json: 5, updatedAt: 1 } }), 400);
  assert.equal(bad({ 'ss.watch': { json: '[]', updatedAt: '1' } }), 400);
  assert.equal(bad({ 'ss.watch': { json: '[]', updatedAt: -1 } }), 400);
  assert.equal(bad({ 'ss.watch': { json: '[]', updatedAt: NaN } }), 400);
  assert.equal(bad({ 'ss.watch': { json: '{broken', updatedAt: 1 } }), 400, 'must be valid JSON text');
  assert.equal(bad({ 'ss.watch': { json: J('x'.repeat(MAX_ITEM_BYTES + 1)), updatedAt: 1 } }), 413);
  const half = J('x'.repeat(1.2 * 1024 * 1024));
  assert.equal(bad({ 'ss.paper.IN': { json: half, updatedAt: 1 }, 'ss.paper.US': { json: half, updatedAt: 1 } }), 413, 'total size');
  assert.deepEqual(SYNC_KEYS.filter((k) => /theme|interval|disclaimer|market$|sync/.test(k)), [], 'device-only settings are never synced');
});

test('planSync: newest wins per key; ties with different content go to the cloud', () => {
  const it = (json, updatedAt) => ({ json, updatedAt });
  assert.deepEqual(planSync({}, {}), { push: [], apply: [] });
  assert.deepEqual(planSync({ 'ss.watch': it('[1]', 5) }, {}), { push: ['ss.watch'], apply: [] }, 'cloud lacks it');
  assert.deepEqual(planSync({}, { 'ss.watch': it('[1]', 5) }), { push: [], apply: ['ss.watch'] }, 'device lacks it');
  assert.deepEqual(planSync({ 'ss.watch': it('[1]', 9) }, { 'ss.watch': it('[2]', 5) }), { push: ['ss.watch'], apply: [] });
  assert.deepEqual(planSync({ 'ss.watch': it('[1]', 5) }, { 'ss.watch': it('[2]', 9) }), { push: [], apply: ['ss.watch'] });
  assert.deepEqual(planSync({ 'ss.watch': it('[1]', 5) }, { 'ss.watch': it('[1]', 5) }), { push: [], apply: [] });
  assert.deepEqual(planSync({ 'ss.watch': it('[1]', 5) }, { 'ss.watch': it('[2]', 5) }), { push: [], apply: ['ss.watch'] });
  const mixed = planSync({ 'ss.watch': it('a', 9), 'ss.paper.IN': it('b', 1) }, { 'ss.watch': it('c', 2), 'ss.paper.IN': it('d', 8) });
  assert.deepEqual(mixed, { push: ['ss.watch'], apply: ['ss.paper.IN'] }, 'each key decided on its own');
});

test('rate limiter allows a burst up to the limit, then recovers after the window', () => {
  let t = 1000;
  const lim = createLimiter({ max: 3, windowMs: 1000, now: () => t });
  assert.deepEqual([1, 2, 3, 4, 5].map(() => lim.hit('ip')), [true, true, true, false, false]);
  assert.equal(lim.hit('other'), true, 'keys are independent');
  t += 1001;
  assert.equal(lim.hit('ip'), true);
  lim.clear();
  assert.equal(lim.hit('ip'), true);
});

// ---------- the sync engine: a story with two devices ----------
function fakeStorage() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: (k) => m.delete(k), _m: m };
}
// Stands in for the server: same contract as POST /api/sync.
function fakeCloud(serverNow = () => Date.now()) {
  const buckets = new Map();
  const calls = { n: 0 };
  const post = async (body) => {
    calls.n++;
    const code = normalizeCode(body.code);
    if (!code) throw Object.assign(new Error('That sync code is not valid — check it for typos.'), { status: 400 });
    if (body.wipe) { buckets.delete(code); return { items: {}, serverTime: serverNow() }; }
    let b = buckets.get(code);
    if (!b) {
      if (!body.create) throw Object.assign(new Error('No cloud data was found for this sync code.'), { status: 404 });
      b = new Map();
      buckets.set(code, b);
    }
    for (const [k, it] of Object.entries(sanitizeItems(body.items))) {
      const cur = b.get(k);
      if (!cur || it.updatedAt > cur.updatedAt) b.set(k, it);
    }
    return { items: Object.fromEntries(b), serverTime: serverNow() };
  };
  return { post, calls };
}
// A "device": storage + engine, with a shared fake clock so the order of edits is deterministic.
function device(post, now) {
  const storage = fakeStorage();
  const engine = createEngine({ storage, post, now });
  // What the browser glue does when the user changes something: write, then touch().
  const edit = (key, value) => { storage.set(key, typeof value === 'string' ? value : J(value)); engine.touch(key); };
  return { storage, engine, edit, get: (k) => (storage.get(k) == null ? undefined : JSON.parse(storage.get(k))) };
}

// `time` = { now(), tick() }: a fake clock that jumps a second per tick, or the real clock (when the
// server is real, because it reports real time) where tick() just waits a few milliseconds.
const fakeTime = () => { let t = 1_700_000_000_000; return { now: () => t, tick: async () => { t += 1000; } }; };
const realTime = () => ({ now: () => Date.now(), tick: () => new Promise((r) => setTimeout(r, 6)) });

async function story(newPost, { time, calls } = {}) {
  const tick = () => time.tick();
  const A = device(newPost(), time.now);
  const B = device(newPost(), time.now);

  // Device A already has data (created before sync existed, so nothing is stamped), plus a device-only setting.
  A.storage.set('ss.watch', J(['TCS.NS', 'INFY.NS']));
  A.storage.set('ss.paper.IN', J(ACCOUNT));
  A.storage.set('ss.theme', '"dark"');
  assert.equal(A.engine.describeLocal().hasData, true);
  assert.equal(A.engine.describeLocal().paper.IN.trades, 1);
  const blank = createEngine({ storage: fakeStorage(), post: async () => ({}) });
  assert.equal(blank.describeLocal().hasData, false, 'a new browser has nothing to upload');

  const code = await A.engine.create(randomBytes());
  assert.equal(normalizeCode(code), code);
  assert.equal(A.engine.code(), code, 'the code is remembered on this device');
  assert.ok(A.engine.lastSync());

  // Device B has its own older watchlist, then joins by typing the code carelessly.
  B.storage.set('ss.watch', J(['OLD.NS']));
  B.storage.set('ss.theme', '"light"');
  await tick();
  const joined = await B.engine.join(`  ${code.toLowerCase().replace(/-/g, ' ')}  `);
  assert.deepEqual(joined.applied.sort(), ['ss.paper.IN', 'ss.watch']);
  assert.deepEqual(B.get('ss.watch'), ['TCS.NS', 'INFY.NS'], 'cloud copy replaces the older local watchlist');
  assert.deepEqual(B.get('ss.paper.IN'), ACCOUNT, 'paper-trading account arrives intact');
  assert.deepEqual(JSON.parse(B.storage.get('ss.sync.prev'))['ss.watch'], J(['OLD.NS']), 'what was replaced is kept for recovery');
  assert.equal(B.storage.get('ss.theme'), '"light"', 'device-only settings are left alone');
  assert.equal(A.storage.get('ss.theme'), '"dark"');

  // B edits; A picks it up.
  await tick();
  B.edit('ss.watch', ['TCS.NS', 'INFY.NS', 'AAPL']);
  await B.engine.sync();
  await tick();
  const gotB = await A.engine.sync();
  assert.deepEqual(gotB.applied, ['ss.watch']);
  assert.deepEqual(A.get('ss.watch'), ['TCS.NS', 'INFY.NS', 'AAPL']);

  // Syncing with nothing changed does nothing.
  await tick();
  const idle = await A.engine.sync();
  assert.deepEqual(idle.applied, []);
  assert.equal(idle.inSync, 2);

  // Offline conflict: both edit the same list; the LATER edit wins everywhere, nothing newer is overwritten.
  await tick();
  A.edit('ss.watch', ['A-ONLY.NS']);
  await tick();
  B.edit('ss.watch', ['B-LATER.NS']);
  await tick();
  await A.engine.sync(); // A uploads its older edit...
  await B.engine.sync(); // ...B's newer edit beats it
  await tick();
  await A.engine.sync();
  assert.deepEqual(A.get('ss.watch'), ['B-LATER.NS']);
  assert.deepEqual(B.get('ss.watch'), ['B-LATER.NS']);

  // Different keys edited on different devices both survive.
  await tick();
  A.edit('ss.capital', '250000');
  await tick();
  B.edit('ss.academy.done', ['c1', 'c2']);
  await A.engine.sync();
  await B.engine.sync();
  await A.engine.sync();
  assert.equal(A.storage.get('ss.capital'), '250000');
  assert.equal(B.storage.get('ss.capital'), '250000');
  assert.deepEqual(A.get('ss.academy.done'), ['c1', 'c2']);

  // A device whose clock is 3 hours slow still orders its edits correctly: it measures its clock
  // against the server's when it syncs, so its later edit beats everything earlier.
  const skew = 3 * 3600 * 1000;
  const C = device(newPost(), () => time.now() - skew);
  await C.engine.join(code);
  assert.deepEqual(C.get('ss.watch'), ['B-LATER.NS']);
  await tick();
  C.edit('ss.watch', ['FROM-C.NS']);
  await C.engine.sync();
  await tick();
  await A.engine.sync();
  assert.deepEqual(A.get('ss.watch'), ['FROM-C.NS'], 'the slow-clock device\'s newer edit won');
  await tick();
  B.edit('ss.watch', ['B-AFTER-C.NS']); // and a real later edit elsewhere still beats it
  await B.engine.sync();
  await C.engine.sync();
  assert.deepEqual(C.get('ss.watch'), ['B-AFTER-C.NS']);
  await A.engine.sync();

  // Mistakes are refused clearly, and leave nothing behind.
  const D = device(newPost(), time.now);
  const before = calls?.n;
  await assert.rejects(D.engine.join(code.replace(/^./, (c) => (c === '1' ? '2' : '1'))), /not valid/);
  if (calls) assert.equal(calls.n, before, 'a typo is caught on the device, without asking the server');
  assert.equal(D.engine.code(), null);
  const unknown = generateCode(randomBytes()); // well-formed but nobody created it
  await assert.rejects(D.engine.join(unknown), (e) => e.status === 404);
  assert.equal(D.engine.code(), null, 'a failed join is not remembered');
  await assert.rejects(D.engine.sync(), /not set up/);

  // Stopping on one device keeps its data; deleting the cloud copy ends it for everyone.
  await tick();
  B.engine.disconnect();
  assert.equal(B.engine.code(), null);
  assert.deepEqual(B.get('ss.watch'), ['B-AFTER-C.NS'], 'local data stays');
  await A.engine.wipeCloud();
  assert.equal(A.engine.code(), null);
  assert.ok(A.get('ss.paper.IN'), 'wiping the cloud never deletes what is on the device');
  await assert.rejects(C.engine.sync(), (e) => e.status === 404, 'the code no longer works');
  return code;
}

test('two devices: create, join, edit both ways, resolve conflicts, stop and delete (in-memory cloud)', async () => {
  const time = fakeTime();
  const cloud = fakeCloud(time.now);
  await story(() => cloud.post, { time, calls: cloud.calls });
});

test('creating a code on an empty device works, and an upload failure leaves no half-set-up sync', async () => {
  const ok = device(fakeCloud().post, () => 5000);
  assert.equal(ok.engine.describeLocal().hasData, false);
  await ok.engine.create(randomBytes());
  assert.ok(ok.engine.code());
  const down = device(async () => { throw Object.assign(new Error('offline'), { status: 0 }); }, () => 5000);
  await assert.rejects(down.engine.create(randomBytes()), /offline/);
  assert.equal(down.engine.code(), null);
});

// ---------- the real server ----------
function start() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
const httpPost = (port, { body, headers = {}, raw } = {}) =>
  fetch(`http://127.0.0.1:${port}/api/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw ?? J(body) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const httpPostFn = (port) => async (body) => {
  const r = await httpPost(port, { body });
  if (r.status !== 200) throw Object.assign(new Error(r.json?.error || `HTTP ${r.status}`), { status: r.status });
  return r.json;
};
const withEnv = async (vars, fn) => {
  const keep = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  await closeDb();
  try { return await fn(); } finally {
    await closeDb();
    for (const [k, v] of Object.entries(keep)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
};

test('POST /api/sync refuses bad requests before touching any data (no database needed)', async () => {
  const { server, port } = await start();
  try {
    await withEnv({ MONGODB_URI: undefined }, async () => {
      resetSyncLimits();
      const code = generateCode(randomBytes());
      const r503 = await httpPost(port, { body: { code, items: {}, create: true } });
      assert.equal(r503.status, 503);
      assert.match(r503.json.error, /no database/i);
      assert.equal((await httpPost(port, { body: { code }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/sync`)).status, 404, 'there is no way to read via GET');
    });
    // with a database configured (it is never contacted for these):
    await withEnv({ MONGODB_URI: 'mongodb://127.0.0.1:1/', MONGODB_TIMEOUT_MS: '200' }, async () => {
      resetSyncLimits();
      assert.equal((await httpPost(port, { raw: '{broken' })).status, 400);
      const wrong = await httpPost(port, { body: { code: 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA' } });
      assert.equal(wrong.status, 400);
      assert.match(wrong.json.error, /not valid/);
      assert.equal((await httpPost(port, { body: {} })).status, 400);
      const huge = await httpPost(port, { raw: J({ code: 'x', pad: 'y'.repeat(3 * 1024 * 1024) }) });
      assert.equal(huge.status, 413, 'oversized requests get a readable answer');
      // Guessing codes is throttled: the 11th wrong code in a minute is refused.
      resetSyncLimits();
      const statuses = [];
      for (let i = 0; i < 12; i++) statuses.push((await httpPost(port, { body: { code: `BAD${i}` } })).status);
      assert.deepEqual(statuses.slice(0, 10), Array(10).fill(400));
      assert.deepEqual(statuses.slice(10), [429, 429]);
      resetSyncLimits();
      // A valid code with the database unreachable is a clear 503, not a crash.
      const down = await httpPost(port, { body: { code: generateCode(randomBytes()), create: true } });
      assert.equal(down.status, 503);
      assert.match(down.json.error, /not reachable/);
      assert.ok(!JSON.stringify(down.json).includes('mongodb://127'), 'no connection string in errors');
    });
  } finally {
    server.close();
  }
});

// ---------- real MongoDB (set TEST_MONGODB_URI to run) ----------
const URI = process.env.TEST_MONGODB_URI;
test('against a real MongoDB: the same two-device story, plus concurrency, isolation and limits', { skip: !URI && 'set TEST_MONGODB_URI to run' }, async () => {
  const dbName = `stocksense_sync_test_${Date.now()}`;
  const { server, port } = await start();
  try {
    await withEnv({ MONGODB_URI: URI, MONGODB_DB: dbName, MONGODB_TIMEOUT_MS: '3000', SYNC_MAX_BUCKETS: '3' }, async () => {
      resetSyncLimits();
      const post = httpPostFn(port);
      const code = await story(() => post, { time: realTime() });
      resetSyncLimits();
      const db = await getDb();

      // The raw code is never stored anywhere.
      const everything = JSON.stringify([...(await db.collection('sync_items').find({}).toArray()), ...(await db.collection('sync_buckets').find({}).toArray())]);
      assert.ok(!everything.includes(code.replace(/-/g, '')) && !everything.includes(code));
      assert.equal(await db.collection('sync_items').countDocuments(), 0, 'wipe removed everything for that code');
      assert.equal(await db.collection('sync_buckets').countDocuments(), 0);

      // Two different codes never see each other's data.
      const c1 = generateCode(randomBytes());
      const c2 = generateCode(randomBytes());
      const t0 = Date.now();
      await post({ code: c1, create: true, items: { 'ss.watch': { json: J(['ONE']), updatedAt: t0 } } });
      await post({ code: c2, create: true, items: { 'ss.watch': { json: J(['TWO']), updatedAt: t0 } } });
      assert.deepEqual(JSON.parse((await post({ code: c1 })).items['ss.watch'].json), ['ONE']);
      assert.deepEqual(JSON.parse((await post({ code: c2 })).items['ss.watch'].json), ['TWO']);

      // Many devices pushing at the same instant: the newest edit always wins, whatever the arrival order.
      const racers = Array.from({ length: 12 }, (_, i) => ({ json: J([`edit-${i}`]), updatedAt: t0 + 1000 * (i + 1) }));
      await Promise.all([...racers].sort(() => Math.random() - 0.5).map((it) => post({ code: c1, items: { 'ss.watch': it } })));
      const final = (await post({ code: c1 })).items['ss.watch'];
      assert.deepEqual([JSON.parse(final.json), final.updatedAt], [['edit-11'], t0 + 12000]);
      // An older edit arriving late is ignored, and re-sending the same data is harmless.
      const late = await post({ code: c1, items: { 'ss.watch': { json: J(['stale']), updatedAt: t0 + 5 } } });
      assert.deepEqual(JSON.parse(late.items['ss.watch'].json), ['edit-11']);
      await post({ code: c1, items: { 'ss.watch': racers[11] } });
      assert.equal(await db.collection('sync_items').countDocuments({ key: 'ss.watch' }), 2, 'one document per code and key');

      // Creating the same code twice (two devices at once) is fine; unknown codes are not.
      const c3 = generateCode(randomBytes());
      const both = await Promise.all([post({ code: c3, create: true }), post({ code: c3, create: true })]);
      assert.equal(both.length, 2);
      assert.equal(await db.collection('sync_buckets').countDocuments(), 3);
      await assert.rejects(post({ code: generateCode(randomBytes()) }), (e) => e.status === 404);
      // The cap on the number of codes protects a public deployment.
      await assert.rejects(post({ code: generateCode(randomBytes()), create: true }), (e) => e.status === 403 && /maximum/.test(e.message));
      // ...but existing codes keep working at the cap.
      assert.ok((await post({ code: c1 })).items['ss.watch']);

      // Wiping one code leaves the others alone.
      await post({ code: c2, wipe: true });
      await assert.rejects(post({ code: c2 }), (e) => e.status === 404);
      assert.ok((await post({ code: c1 })).items['ss.watch']);
      assert.ok((await db.collection('sync_items').indexes()).some((i) => i.name === 'bucket'));
      await db.dropDatabase();
    });
  } finally {
    server.close();
  }
});

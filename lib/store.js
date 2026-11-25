// What gets saved to MongoDB, and how.
//
//   scans  one snapshot of the whole intraday desk (all stocks, scenarios, market direction).
//          While the market is open: one per market per 5 minutes. After the close: one per session.
//          Expires automatically after SCAN_TTL_DAYS (default 30 days ≈ 1 MB per market per trading day; 0 = keep forever).
//   picks  every "best of the best" intraday BUY, saved the first time it qualifies with its buy zone,
//          stop-loss and targets frozen as first signalled (plus when it was last seen qualifying).
//          Only saved while the market is open. Kept forever — it is your track record.
//
// Writes are idempotent (fixed _id per bucket / per pick), so repeated page refreshes or several
// server instances never create duplicates. The document builders are pure so they can be tested
// without a database.
import { getDb, dbEnabled, safeError } from './db.js';

export const BUCKET_MS = 5 * 60 * 1000;
const DAY_S = 24 * 60 * 60;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function scanTtlDays() {
  const raw = process.env.SCAN_TTL_DAYS;
  if (raw === undefined || raw.trim() === '') return 30;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

// ---------- indexes ----------
const indexed = new WeakSet();

async function ttlIndex(coll, name, days) {
  if (!days) {
    await coll.dropIndex(name).catch(() => {}); // not there -> nothing to do
    return;
  }
  const opts = { name, expireAfterSeconds: Math.round(days * DAY_S) };
  try {
    await coll.createIndex({ ts: 1 }, opts);
  } catch (e) {
    // The retention setting changed since the index was created: rebuild it.
    if (e?.code !== 85 && e?.code !== 86) throw e;
    await coll.dropIndex(name);
    await coll.createIndex({ ts: 1 }, opts);
  }
}

export async function ensureIndexes(db) {
  if (indexed.has(db)) return;
  const scans = db.collection('scans');
  await scans.createIndex({ market: 1, ts: -1 }, { name: 'market_ts' });
  await ttlIndex(scans, 'ts_ttl', scanTtlDays());
  await db.collection('picks').createIndex({ market: 1, firstSeen: -1 }, { name: 'market_firstSeen' });
  indexed.add(db);
}

// ---------- document builders (pure) ----------
const planOf = (i) => {
  const p = i?.plan;
  if (!p) return null;
  return { action: p.action, entry: p.entry, stopLoss: p.stopLoss, target1: p.target1, target2: p.target2, riskReward: p.riskReward };
};

function itemRow(it) {
  const i = it.intraday;
  const live = i && !i.insufficient;
  return {
    symbol: it.symbol,
    name: it.name,
    price: it.price,
    dayChangePct: it.dayChangePct ?? null,
    intraday: live
      ? {
        score: i.score, verdict: i.verdict.key, scenario: i.scenario.key,
        vsVwapPct: i.stats.vsVwapPct, orb: i.stats.orb, rvol: i.stats.rvol, rsi: i.stats.rsi, gapPct: i.stats.gapPct,
        plan: planOf(i),
      }
      : null,
    daily: it.daily ? { score: it.daily.score, verdict: it.daily.verdict.key } : null,
    bestPassed: Boolean(it.best?.passed),
    bestPassCount: it.best?.passCount ?? 0,
  };
}

// `result` is the /api/intraday response.
export function scanDocument(result, now = Date.now()) {
  const ts = new Date(isNum(result.updated) ? result.updated : now);
  const open = Boolean(result.marketOpen);
  const bucket = Math.floor(ts.getTime() / BUCKET_MS);
  const mb = result.marketBias;
  return {
    _id: open ? `${result.market}:${bucket}` : `${result.market}:${result.sessionDate ?? 'unknown'}:closed`,
    market: result.market,
    ts,
    sessionDate: result.sessionDate ?? null,
    marketOpen: open,
    minutesLeft: result.minutesLeft ?? null,
    marketBias: mb ? { name: mb.name, bias: mb.bias, changePct: mb.changePct ?? null } : null,
    counts: result.counts ?? {},
    best: (result.best ?? []).map((x) => x.symbol),
    strongBuyDaily: (result.strongBuyDaily ?? []).map((x) => x.symbol),
    strongBuyIntraday: (result.strongBuyIntraday ?? []).map((x) => x.symbol),
    items: (result.items ?? []).map(itemRow),
  };
}

// bulkWrite operations for the featured picks. Levels are frozen the first time a stock qualifies
// ($setOnInsert); the "last seen" fields move forward ($set). The two never share a field.
export function pickOperations(result, now = Date.now()) {
  if (!result.marketOpen) return []; // after the close the list is just a replay of the last session
  const ts = new Date(isNum(result.updated) ? result.updated : now);
  return (result.best ?? []).map((it, idx) => {
    const i = it.intraday;
    const p = i.plan;
    return {
      updateOne: {
        filter: { _id: `${result.market}:${result.sessionDate}:${it.symbol}` },
        update: {
          $setOnInsert: {
            market: result.market,
            sessionDate: result.sessionDate,
            symbol: it.symbol,
            name: it.name,
            currency: it.currency,
            firstSeen: ts,
            firstPrice: it.price,
            entryLow: p.entryLow, entryHigh: p.entryHigh, entry: p.entry,
            stopLoss: p.stopLoss, target1: p.target1, target2: p.target2,
            riskReward: p.riskReward, riskPct: p.riskPct,
            scenario: i.scenario.key,
            signalScore: i.score,
            rvol: i.stats.rvol,
            rsi: i.stats.rsi,
            dailyVerdict: it.daily?.verdict?.key ?? null,
            checksPassed: it.best?.passCount ?? null,
            checksTotal: it.best?.total ?? null,
            marketBias: result.marketBias?.bias ?? null,
          },
          $set: { lastSeen: ts, lastPrice: it.price, lastScore: i.score, rank: idx + 1 },
        },
        upsert: true,
      },
    };
  });
}

// ---------- writing ----------
const recentlySaved = new Map(); // scan _id -> time, so refreshes inside one bucket write once
export function resetStoreCache() {
  recentlySaved.clear();
}

let lastLog = 0;
function logOnce(err) {
  if (Date.now() - lastLog < 60 * 1000) return;
  lastLog = Date.now();
  console.error(`[db] could not save: ${safeError(err)}`);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('The database took too long to respond.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Save the intraday desk. Never throws: a database problem must not break the page.
// Awaited by the API (with a short time limit) because serverless hosts can freeze the
// process the moment the response is sent.
export async function persistBoard(result, { now = Date.now(), timeoutMs = 2500, db: injected = null } = {}) {
  if (!injected && !dbEnabled()) return { saved: false, reason: 'disabled' };
  try {
    const run = async () => {
      const db = injected ?? (await getDb());
      await ensureIndexes(db);
      const doc = scanDocument(result, now);
      let scanSaved = false;
      if (!recentlySaved.has(doc._id)) {
        await db.collection('scans').replaceOne({ _id: doc._id }, doc, { upsert: true });
        recentlySaved.set(doc._id, now);
        if (recentlySaved.size > 200) recentlySaved.delete(recentlySaved.keys().next().value);
        scanSaved = true;
      }
      const ops = pickOperations(result, now);
      if (ops.length) await db.collection('picks').bulkWrite(ops, { ordered: false });
      return { saved: true, scan: doc._id, scanSaved, picks: ops.length };
    };
    return await withTimeout(run(), timeoutMs);
  } catch (err) {
    logOnce(err);
    return { saved: false, reason: 'error', error: safeError(err) };
  }
}

// ---------- reading ----------
const clean = ({ _id, ...rest }) => ({ id: _id, ...rest });

export async function listPicks(db, { market, limit = 30 } = {}) {
  const rows = await db.collection('picks').find({ market }).sort({ firstSeen: -1 }).limit(limit).toArray();
  return rows.map(clean);
}

export async function listScans(db, { market, limit = 20 } = {}) {
  const rows = await db.collection('scans').find({ market }, { projection: { items: 0 } }).sort({ ts: -1 }).limit(limit).toArray();
  return rows.map(clean);
}

export async function dbStats(db) {
  const [scans, picks] = await Promise.all([
    db.collection('scans').estimatedDocumentCount(),
    db.collection('picks').estimatedDocumentCount(),
  ]);
  return { scans, picks };
}

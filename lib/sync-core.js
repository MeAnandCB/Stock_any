// Cloud sync, shared by the server and the browser (the browser loads it from /lib/sync-core.js).
// Pure JavaScript: no Node or DOM APIs, so one set of tests covers both sides.
//
// How it works
//   * Your data is stored under a personal SYNC CODE. There are no accounts: whoever has the code can
//     read and change that data, and the server only ever stores a hash of it.
//   * Each synced item (watchlist, each paper-trading account, ...) carries an "updated at" time.
//     When two devices disagree, the newest item wins (per item). Nothing is ever merged field by field.
//   * Device-only settings (theme, chart timeframe, ...) are deliberately NOT synced.

// Only these browser-storage keys are synced. Anything else is ignored by the server.
export const SYNC_KEYS = ['ss.watch', 'ss.paper.IN', 'ss.paper.US', 'ss.academy.done', 'ss.academy.lang', 'ss.capital', 'ss.riskPct'];
export const MAX_ITEM_BYTES = 1.5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export class SyncError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
  }
}

// ---------- sync code ----------
// 24 random characters + 1 check character, shown as XXXXX-XXXXX-XXXXX-XXXXX-XXXXX (120 bits of
// randomness: not guessable). The alphabet has no I, L, O or U, so it is hard to misread. The check
// character catches any single mistyped character before the server is even asked.
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Odd weights are coprime with 32, so changing any one character always changes the sum.
const checkChar = (body) => {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += CODE_ALPHABET.indexOf(body[i]) * (2 * i + 1);
  return CODE_ALPHABET[sum % 32];
};
const groups = (raw) => raw.match(/.{5}/g).join('-');

// `bytes`: at least 24 cryptographically random bytes (crypto.getRandomValues in the browser).
export function generateCode(bytes) {
  if (!bytes || bytes.length < 24) throw new Error('generateCode needs 24 random bytes.');
  let body = '';
  for (let i = 0; i < 24; i++) body += CODE_ALPHABET[bytes[i] & 31]; // 256 is a multiple of 32, so no bias
  return groups(body + checkChar(body));
}

// Accepts what people actually type (lower case, spaces, missing dashes, O for 0, I/L for 1).
// Returns the canonical code, or null if it is not a valid code.
export function normalizeCode(input) {
  if (typeof input !== 'string' || input.length > 100) return null;
  const raw = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (raw.length !== 25 || ![...raw].every((c) => CODE_ALPHABET.includes(c))) return null;
  return checkChar(raw.slice(0, 24)) === raw[24] ? groups(raw) : null;
}

// ---------- items ----------
// items: { [key]: { json: '<the value exactly as stored in the browser>', updatedAt: <ms> } }
// Returns a clean copy containing only synced keys; throws SyncError on anything malformed or too large.
export function sanitizeItems(items) {
  if (items == null) return {};
  if (typeof items !== 'object' || Array.isArray(items)) throw new SyncError('The data to sync is not valid.');
  const out = {};
  let total = 0;
  for (const [key, it] of Object.entries(items)) {
    if (!SYNC_KEYS.includes(key)) continue;
    if (!it || typeof it.json !== 'string' || typeof it.updatedAt !== 'number' || !Number.isFinite(it.updatedAt) || it.updatedAt < 0) {
      throw new SyncError(`The value for "${key}" is not valid.`);
    }
    if (it.json.length > MAX_ITEM_BYTES) throw new SyncError('That is too much data to sync.', 413);
    total += it.json.length;
    if (total > MAX_TOTAL_BYTES) throw new SyncError('That is too much data to sync.', 413);
    try {
      JSON.parse(it.json);
    } catch {
      throw new SyncError(`The value for "${key}" is not valid.`);
    }
    out[key] = { json: it.json, updatedAt: Math.floor(it.updatedAt) };
  }
  return out;
}

// Decide, key by key, what to send and what to take. Newest "updated at" wins. If two devices somehow
// have the same time but different content, the cloud copy wins so every device ends up identical.
export function planSync(local, remote) {
  const push = [];
  const apply = [];
  for (const key of SYNC_KEYS) {
    const l = local[key];
    const r = remote[key];
    if (l && (!r || l.updatedAt > r.updatedAt)) push.push(key);
    else if (r && (!l || r.updatedAt > l.updatedAt || (r.updatedAt === l.updatedAt && r.json !== l.json))) apply.push(key);
  }
  return { push, apply };
}

// ---------- the sync engine (one per device) ----------
// storage: { get(key), set(key, value), remove(key) }   raw access: writes here do NOT count as user edits
// post:    async (body) => response   talks to POST /api/sync; must throw an Error with .status on failure
const K = { code: 'ss.sync.code', meta: 'ss.sync.meta', last: 'ss.sync.last', prev: 'ss.sync.prev' };

export function createEngine({ storage, post, now = () => Date.now() }) {
  let offset = 0; // server clock minus this device's clock, so devices with a wrong clock still order edits correctly
  const stamp = () => Math.round(now() + offset);
  const readJson = (key, fallback) => {
    try {
      const v = storage.get(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  };
  const meta = () => readJson(K.meta, {});

  function localItems() {
    const m = meta();
    const items = {};
    for (const key of SYNC_KEYS) {
      const json = storage.get(key);
      if (json != null) items[key] = { json, updatedAt: m[key] ?? 0 };
    }
    return items;
  }

  const engine = {
    code: () => storage.get(K.code) || null,
    lastSync: () => Number(storage.get(K.last)) || null,
    localItems,
    payload: () => ({ code: engine.code(), items: localItems() }),

    // Call whenever the user changes a synced key.
    touch(key) {
      if (!SYNC_KEYS.includes(key)) return false;
      const m = meta();
      m[key] = stamp();
      storage.set(K.meta, JSON.stringify(m));
      return true;
    },

    // What this device would upload: the keys that exist here.
    describeLocal() {
      const items = localItems();
      const get = (k) => {
        try {
          return JSON.parse(items[k]?.json);
        } catch {
          return undefined;
        }
      };
      const acct = (a) => (a && Array.isArray(a.orders) ? { orders: a.orders.length, trades: Array.isArray(a.trades) ? a.trades.length : 0, holdings: Array.isArray(a.holdings) ? a.holdings.length : 0, positions: Array.isArray(a.positions) ? a.positions.length : 0 } : null);
      const watch = get('ss.watch');
      const done = get('ss.academy.done');
      const paper = { IN: acct(get('ss.paper.IN')), US: acct(get('ss.paper.US')) };
      const used = (a) => Boolean(a) && a.orders + a.trades + a.holdings + a.positions > 0;
      return {
        watchlist: Array.isArray(watch) ? watch.length : 0,
        classesDone: Array.isArray(done) ? done.length : 0,
        paper,
        hasData: (Array.isArray(watch) && watch.length > 0) || (Array.isArray(done) && done.length > 0) || used(paper.IN) || used(paper.US),
      };
    },

    // Make a brand-new code on this device and upload what is here.
    async create(randomBytes) {
      const code = generateCode(randomBytes);
      const m = meta();
      const t = stamp();
      for (const key of Object.keys(localItems())) if (m[key] == null) m[key] = t; // this device's data is the source
      storage.set(K.meta, JSON.stringify(m));
      storage.set(K.code, code);
      try {
        await engine.sync({ create: true });
      } catch (e) {
        storage.remove(K.code);
        throw e;
      }
      return code;
    },

    // Attach this device to an existing code. The cloud copy wins over older data on this device
    // (the replaced value is kept in ss.sync.prev so it can be recovered).
    async join(input) {
      const code = normalizeCode(input);
      if (!code) throw new SyncError('That sync code is not valid — check it for typos.');
      storage.set(K.code, code);
      try {
        return await engine.sync();
      } catch (e) {
        storage.remove(K.code);
        throw e;
      }
    },

    // Send what changed here, take what changed elsewhere. Safe to call any time.
    async sync({ create = false } = {}) {
      const code = engine.code();
      if (!code) throw new SyncError('Sync is not set up on this device.');
      const local = localItems();
      const started = now();
      const res = await post({ code, items: local, create });
      if (typeof res.serverTime === 'number') offset = res.serverTime - Math.round((started + now()) / 2);
      const remote = res.items || {};
      const { apply } = planSync(local, remote); // `remote` already includes what we just sent
      const m = meta();
      const prev = readJson(K.prev, {});
      for (const key of apply) {
        const before = storage.get(key);
        if (before != null && before !== remote[key].json) prev[key] = before;
        storage.set(key, remote[key].json);
        m[key] = remote[key].updatedAt;
      }
      if (apply.length) {
        storage.set(K.prev, JSON.stringify(prev));
        storage.set(K.meta, JSON.stringify(m));
      }
      storage.set(K.last, String(stamp()));
      const inSync = Object.keys(local).filter((k) => remote[k] && remote[k].json === local[k].json).length;
      return { applied: apply, inSync, created: Boolean(res.created) };
    },

    // Stop syncing on this device. The data stays here and in the cloud.
    disconnect() {
      storage.remove(K.code);
      storage.remove(K.last);
    },

    // Delete the cloud copy for this code, then stop syncing here.
    async wipeCloud() {
      const code = engine.code();
      if (!code) throw new SyncError('Sync is not set up on this device.');
      await post({ code, wipe: true });
      engine.disconnect();
    },
  };
  return engine;
}

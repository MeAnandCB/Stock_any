// MongoDB connection. Entirely optional: with no MONGODB_URI the app behaves exactly as before
// and the `mongodb` package is never even loaded.
//
//   MONGODB_URI   connection string (Atlas "mongodb+srv://…" or local "mongodb://127.0.0.1:27017")
//   MONGODB_DB    database name (default: stocksense)
//   MONGODB_TIMEOUT_MS  optional, how long to wait for the database (default 5000)
//
// One shared client is kept for the life of the process (also across warm serverless
// invocations on Vercel). After a failed connect we wait a little before trying again so
// a dead database cannot slow every request down.

const RETRY_AFTER_MS = 30 * 1000;
const state = { promise: null, client: null, failedAt: 0, error: null };

export const dbEnabled = () => Boolean(process.env.MONGODB_URI?.trim());
export const dbName = () => process.env.MONGODB_DB?.trim() || 'stocksense';

// Error text that is safe to log or show: never contains a connection string / password.
export function safeError(err) {
  const msg = String(err?.message || err || 'Unknown database error');
  return msg
    .replace(/mongodb(?:\+srv)?:\/\/[^\s'"]+/gi, 'mongodb://***')
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//***:***@')
    .slice(0, 300);
}

async function connect() {
  let MongoClient;
  try {
    ({ MongoClient } = await import('mongodb'));
  } catch {
    throw new Error('The "mongodb" package is not installed. Run "npm install" in the project folder.');
  }
  const t = Number(process.env.MONGODB_TIMEOUT_MS);
  const timeout = Number.isFinite(t) && t >= 100 ? t : 5000; // how long to wait for the database before giving up
  const client = new MongoClient(process.env.MONGODB_URI.trim(), {
    serverSelectionTimeoutMS: timeout,
    connectTimeoutMS: timeout,
    maxPoolSize: 5,
    appName: 'StockSense',
  });
  await client.connect();
  state.client = client;
  return client.db(dbName());
}

// Resolves to a Db, or null when no database is configured. Rejects when it is configured but unreachable.
export async function getDb() {
  if (!dbEnabled()) return null;
  if (state.promise) return state.promise;
  if (state.error && Date.now() - state.failedAt < RETRY_AFTER_MS) throw state.error;
  state.promise = connect().then(
    (db) => {
      state.error = null;
      return db;
    },
    (err) => {
      state.promise = null;
      state.client = null;
      state.error = err;
      state.failedAt = Date.now();
      throw err;
    }
  );
  return state.promise;
}

export async function closeDb() {
  const c = state.client;
  state.promise = null;
  state.client = null;
  state.error = null;
  state.failedAt = 0;
  if (c) await c.close().catch(() => {});
}

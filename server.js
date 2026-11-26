import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { loadEnv } from './lib/env.js';
import { getDb, dbEnabled, safeError } from './lib/db.js';
import { persistBoard, ensureIndexes, listPicks, listScans, dbStats } from './lib/store.js';
import { getChart, search, AppError } from './lib/yahoo.js';
import { analyze, summarize, round } from './lib/analysis.js';
import { analyzeIntraday, buildItem, evaluateBest, SCENARIOS } from './lib/intraday.js';
import { runIntradayScan, intradayChart, minutesLeftIn, marketDirection } from './lib/scan.js';
import { scoreHeadline, aggregate } from './lib/sentiment.js';
import { getNews, newsNameFor } from './lib/news.js';
import { MARKETS } from './lib/universe.js';
import { mapLimit, cleanSymbol, readBody } from './lib/util.js';
import { normalizeCode, sanitizeItems, SyncError, MAX_TOTAL_BYTES } from './lib/sync-core.js';
import { syncExchange } from './lib/sync.js';
import { createLimiter } from './lib/ratelimit.js';
import { runDigest } from './lib/digest-job.js';
import { timingSafeEqual } from 'node:crypto';

if (!process.env.NODE_TEST_CONTEXT) loadEnv(); // optional .env file (MONGODB_URI etc.); real env vars win. Skipped under `node --test` so tests can never touch your real database.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST = process.env.HOST || '127.0.0.1';
const START_PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// Chart timeframes. `step` is the bar length in seconds (0 = daily).
const CANDLE_INTERVALS = {
  '1m': { yahoo: '1m', step: 60, range: '5d', ttl: 20000, liveRange: '1d', liveTtl: 4000 },
  '5m': { yahoo: '5m', step: 300, range: '5d', ttl: 20000, liveRange: '1d', liveTtl: 4000 },
  '15m': { yahoo: '15m', step: 900, range: '1mo', ttl: 30000, liveRange: '1d', liveTtl: 5000 },
  '1h': { yahoo: '60m', step: 3600, range: '3mo', ttl: 60000, liveRange: '5d', liveTtl: 8000 },
  '1d': { yahoo: '1d', step: 0, range: '2y', ttl: 3 * 60 * 1000, liveRange: '5d', liveTtl: 8000 },
};

// Files outside /public that the browser is allowed to load (the indicator
// maths is shared between server and browser).
const SHARED_FILES = {
  '/lib/indicators.js': path.join(__dirname, 'lib', 'indicators.js'),
  '/lib/paper.js': path.join(__dirname, 'lib', 'paper.js'),
  '/lib/sync-core.js': path.join(__dirname, 'lib', 'sync-core.js'),
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

const marketOf = (q) => {
  const m = String(q.get('market') || 'IN').toUpperCase();
  return MARKETS[m] ? m : 'IN';
};

function requireSymbol(raw) {
  const s = cleanSymbol(raw);
  if (!s) throw new AppError('Please enter a valid stock symbol (e.g. RELIANCE.NS, TCS.NS or AAPL).', 400);
  return s;
}

// For Indian users typing "RELIANCE", try RELIANCE.NS then RELIANCE.BO.
async function chartWithFallback(symbol, market) {
  try {
    return await getChart(symbol);
  } catch (e) {
    const canSuffix = e.status === 404 && market === 'IN' && !symbol.includes('.') && !symbol.startsWith('^');
    if (!canSuffix) throw e;
    for (const suffix of ['.NS', '.BO']) {
      try {
        return await getChart(symbol + suffix);
      } catch (e2) {
        if (e2.status !== 404) throw e2;
      }
    }
    throw new AppError(
      `No stock found for "${symbol}". Try searching by company name, or use the full symbol (e.g. RELIANCE.NS).`,
      404
    );
  }
}

function seriesForClient(series) {
  const r = (arr) => arr.map((v) => round(v, 4));
  return {
    sma20: r(series.sma20),
    sma50: r(series.sma50),
    sma200: r(series.sma200),
    bbUpper: r(series.bb.upper),
    bbLower: r(series.bb.lower),
    rsi: r(series.rsi),
    macd: r(series.macd.line),
    macdSignal: r(series.macd.signal),
    macdHist: r(series.macd.hist),
  };
}

async function summaries(symbols) {
  const results = await mapLimit(symbols, 4, async (s) => summarize(await getChart(s)));
  const items = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.ok) items.push(r.value);
    else failed.push({ symbol: symbols[i], error: r.error?.message || 'Failed' });
  });
  return { items, failed };
}

// Words a headline must contain to count as news about this company,
// e.g. TCS -> ["TCS", "Tata Consultancy"].
function newsKeywordsFor(chart) {
  const base = chart.symbol.replace(/^\^/, '').replace(/\.(NS|BO)$/i, '');
  const words = newsNameFor(chart.name).split(' ').filter(Boolean);
  const name = words.slice(0, words.length > 1 ? 2 : 1).join(' ');
  // "RELIANCE" would also match Reliance Power etc., so require the fuller name.
  const baseIsFirstWord = words.length > 1 && base.toLowerCase() === words[0].toLowerCase();
  return [...new Set([baseIsFirstWord ? '' : base, name].filter((k) => k && k.length >= 2))];
}

function newsQueryFor(chart) {
  const name = newsNameFor(chart.name) || chart.symbol;
  if (chart.symbol.startsWith('^')) return name;
  const base = chart.symbol.replace(/\.(NS|BO)$/i, '');
  const word = chart.currency === 'INR' ? 'share' : 'stock';
  return base.toLowerCase() === name.toLowerCase() ? `"${name}" ${word}` : `("${name}" OR ${base}) ${word}`;
}

function filterRelevant(items, keywords) {
  if (!keywords.length) return items;
  const res = keywords.map((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
  const hits = items.filter((n) => res.some((r) => r.test(n.title)));
  return hits.length >= 3 ? hits : items; // fall back if the filter is too strict
}

function withSentiment(news) {
  return news.map((n) => ({ ...n, sentiment: scoreHeadline(n.title) }));
}

// Fresh price for paper trading: 1-minute bars (short cache) so fills and P&L
// follow the market, falling back to the daily chart if intraday data is missing.
async function liveQuote(symbol) {
  let chart;
  try {
    chart = await getChart(symbol, '1d', '1m', { ttlMs: 5000, step: 60, tag: 'quote' });
  } catch (e) {
    if (e.status === 404 || e.status === 400) throw e;
    chart = await getChart(symbol);
  }
  let prevClose = null;
  try {
    prevClose = (await getChart(symbol)).prevClose;
  } catch {
    /* day change is optional */
  }
  const ok = typeof prevClose === 'number' && Number.isFinite(prevClose) && prevClose > 0;
  return {
    symbol: chart.symbol,
    name: chart.name,
    currency: chart.currency,
    price: chart.price,
    prevClose: ok ? prevClose : null,
    changePct: ok ? ((chart.price - prevClose) / prevClose) * 100 : null,
    marketState: chart.marketState,
    marketTime: chart.marketTime,
    stale: Boolean(chart.stale),
  };
}

// ---------- API ----------
const routes = {
  async '/api/health'() {
    return { ok: true, time: Date.now() };
  },

  async '/api/markets'() {
    return Object.fromEntries(Object.entries(MARKETS).map(([k, v]) => [k, { label: v.label, currency: v.currency }]));
  },

  async '/api/analyze'(q) {
    const market = marketOf(q);
    const symbol = requireSymbol(q.get('symbol'));
    const chart = await chartWithFallback(symbol, market);
    const a = analyze(chart);
    const { series, ...analysis } = a;
    return {
      quote: {
        symbol: chart.symbol,
        name: chart.name,
        currency: chart.currency,
        exchange: chart.exchange,
        instrumentType: chart.instrumentType,
        price: chart.price,
        prevClose: chart.prevClose,
        change: chart.change,
        changePct: chart.changePct,
        marketState: chart.marketState,
        marketTime: chart.marketTime,
        stale: Boolean(chart.stale),
        newsQuery: newsQueryFor(chart),
        newsKeywords: newsKeywordsFor(chart),
      },
      candles: chart.candles,
      series: series ? seriesForClient(series) : null,
      analysis,
    };
  },

  // Candles for the live chart. `live=1` asks for only the most recent bars
  // (small + very short cache) so the browser can poll it every few seconds.
  async '/api/candles'(q) {
    const symbol = requireSymbol(q.get('symbol'));
    const key = String(q.get('interval') || '1d');
    const iv = CANDLE_INTERVALS[key];
    if (!iv) throw new AppError('Unknown chart timeframe.', 400);
    const live = q.get('live') === '1';
    const chart = await getChart(symbol, live ? iv.liveRange : iv.range, iv.yahoo, {
      ttlMs: live ? iv.liveTtl : iv.ttl,
      step: iv.step,
      tag: live ? 'live' : '',
    });
    // "Change today" must be measured from the previous DAY's close, which
    // intraday bars can't tell us — take it from the (cached) daily chart.
    let prevClose = chart.prevClose;
    if (iv.step) {
      try {
        prevClose = (await getChart(symbol)).prevClose;
      } catch {
        prevClose = null;
      }
    }
    const ok = typeof prevClose === 'number' && Number.isFinite(prevClose) && prevClose > 0;
    const change = ok ? chart.price - prevClose : null;
    return {
      interval: key,
      quote: {
        symbol: chart.symbol,
        price: chart.price,
        prevClose: ok ? prevClose : null,
        change,
        changePct: ok ? (change / prevClose) * 100 : null,
        marketState: chart.marketState,
        marketTime: chart.marketTime,
        stale: Boolean(chart.stale),
      },
      candles: chart.candles,
    };
  },

  // Light-weight live prices for the paper-trading screens (up to 25 symbols).
  async '/api/quotes'(q) {
    const raw = String(q.get('symbols') || '').split(',').map(cleanSymbol).filter(Boolean);
    const symbols = [...new Set(raw)].slice(0, 25);
    if (!symbols.length) return { quotes: {}, failed: [] };
    const results = await mapLimit(symbols, 5, (s) => liveQuote(s));
    const quotes = {};
    const failed = [];
    results.forEach((r, i) => {
      if (r.ok) quotes[symbols[i]] = r.value;
      else failed.push({ symbol: symbols[i], error: r.error?.message || 'Failed' });
    });
    if (!Object.keys(quotes).length) throw new AppError(failed[0]?.error || 'Could not load prices.', 503);
    return { quotes, failed, time: Date.now() };
  },

  async '/api/summary'(q) {
    const raw = String(q.get('symbols') || '').split(',').map(cleanSymbol).filter(Boolean);
    const symbols = [...new Set(raw)].slice(0, 40);
    if (!symbols.length) return { items: [], failed: [] };
    return summaries(symbols);
  },

  async '/api/scan'(q) {
    const market = marketOf(q);
    const { items, failed } = await summaries(MARKETS[market].stocks);
    if (!items.length && failed.length) {
      throw new AppError(failed[0].error || 'Could not load market data.', 503);
    }
    return { market, updated: Date.now(), total: MARKETS[market].stocks.length, items, failed };
  },

  // Intraday desk: every large cap analysed on 5-minute candles, the scenario
  // each one is in, the "best of the best" buys and the Strong Buy lists.
  async '/api/intraday'(q) {
    const result = await runIntradayScan(marketOf(q));
    // Keep a history in MongoDB when it is configured. Never fails the request.
    await persistBoard(result);
    return result;
  },

  // The morning digest for Telegram. Called by the scheduler (Vercel Cron sends "Authorization: Bearer <CRON_SECRET>").
  // ?market=IN|US  ?dry=1 (build the message, send nothing)  ?force=1 (send even if already sent today)
  async '/api/cron/digest'(q, req) {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret) throw new AppError('The daily digest is not set up: set CRON_SECRET (and the Telegram variables) on the server.', 503);
    const got = Buffer.from(String(req?.headers?.authorization || ''));
    const want = Buffer.from(`Bearer ${secret}`);
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new AppError('Unauthorized.', 401);

    const requested = q.get('market') ? [q.get('market')] : String(process.env.DIGEST_MARKETS || 'IN').split(',');
    const markets = [...new Set(requested.map((m) => m.trim().toUpperCase()))].filter((m) => MARKETS[m]);
    if (!markets.length) throw new AppError('Unknown market.', 400);
    const dry = q.get('dry') === '1';
    const force = q.get('force') === '1';
    const results = [];
    for (const market of markets) {
      try {
        results.push(await runDigest({ market, dry, force }));
      } catch (e) {
        results.push({ market, sent: false, error: e instanceof AppError ? e.message : 'The digest failed.', status: e.status || 500 });
        if (!(e instanceof AppError)) console.error(e);
      }
    }
    if (results.every((r) => r.error)) throw new AppError(results[0].error, results[0].status || 502);
    return { ok: true, results };
  },

  // Saved history (needs MONGODB_URI): the latest best-of-the-best picks and scan snapshots.
  async '/api/history'(q) {
    const market = marketOf(q);
    if (!dbEnabled()) return { enabled: false, market };
    const limit = Math.min(100, Math.max(1, parseInt(q.get('limit'), 10) || 30));
    try {
      const db = await getDb();
      await ensureIndexes(db);
      const [picks, scans] = await Promise.all([listPicks(db, { market, limit }), listScans(db, { market, limit: Math.min(limit, 30) })]);
      return { enabled: true, ok: true, market, picks, scans };
    } catch (e) {
      return { enabled: true, ok: false, market, error: safeError(e) };
    }
  },

  // Is the database configured and reachable? (never shows the connection string)
  async '/api/db-status'() {
    if (!dbEnabled()) return { enabled: false };
    try {
      const db = await getDb();
      await db.command({ ping: 1 });
      return { enabled: true, ok: true, ...(await dbStats(db)) };
    } catch (e) {
      return { enabled: true, ok: false, error: safeError(e) };
    }
  },

  // One stock's intraday view (the card on the Analyse page).
  async '/api/intraday-stock'(q) {
    const market = marketOf(q);
    const symbol = requireSymbol(q.get('symbol'));
    const chart = await intradayChart(symbol);
    const minutesLeft = minutesLeftIn(chart);
    const intraday = analyzeIntraday(chart, { minutesLeft });
    let best = null;
    if (!intraday.insufficient && !symbol.startsWith('^')) {
      const [direction, daily] = await Promise.all([
        marketDirection(market),
        getChart(symbol).then((c) => buildItem(chart, c).daily).catch(() => null),
      ]);
      best = evaluateBest({ intraday, daily }, { marketBias: direction, marketOpen: chart.marketState === 'open', minutesLeft });
      best.marketBias = direction;
    }
    return { symbol: chart.symbol, marketState: chart.marketState, stale: Boolean(chart.stale), intraday, best, scenarios: SCENARIOS };
  },

  async '/api/indices'(q) {
    const market = marketOf(q);
    const list = MARKETS[market].indices;
    const results = await mapLimit(list, 4, async (ix) => {
      const s = summarize(await getChart(ix.symbol));
      return { ...s, name: ix.name, isVix: Boolean(ix.isVix) };
    });
    const items = results.map((r, i) => (r.ok ? r.value : { symbol: list[i].symbol, name: list[i].name, error: r.error?.message }));
    if (results.every((r) => !r.ok)) throw new AppError(results[0].error?.message || 'Could not load index data.', 503);
    return { market, items };
  },

  async '/api/search'(q) {
    const term = String(q.get('q') || '').trim();
    if (term.length < 1) return { quotes: [] };
    const { quotes } = await search(term, { quotesCount: 8, newsCount: 0 });
    return { quotes };
  },

  async '/api/news'(q) {
    const market = marketOf(q);
    let term = String(q.get('q') || '').trim().slice(0, 80);
    if (!term) term = MARKETS[market].newsQuery;
    const keywords = String(q.get('k') || '').split('|').map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 4);
    const items = withSentiment(filterRelevant(await getNews(term, market), keywords));
    return { query: term, items, sentiment: aggregate(items) };
  },
};

// ---------- static ----------
async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
    return;
  }
  if (rel.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
    return;
  }
  const file = SHARED_FILES[pathname] ?? path.resolve(PUBLIC_DIR, rel);
  if (!SHARED_FILES[pathname] && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

// ---------- cloud sync ----------
// POST /api/sync  { code, items?, create?, wipe? }  ->  { items, serverTime }
// The sync code is the only credential (120 random bits; only its hash is stored), so this endpoint
// is safe to expose on a public deployment. It is rate-limited, size-limited and needs a database.
const syncLimiter = createLimiter({ max: 90, windowMs: 60 * 1000 }); // all requests per IP
const syncFailLimiter = createLimiter({ max: 10, windowMs: 60 * 1000 }); // wrong / unknown codes per IP
export function resetSyncLimits() {
  syncLimiter.clear();
  syncFailLimiter.clear();
}
const clientIp = (req) =>
  (process.env.VERCEL ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket?.remoteAddress || 'unknown';

async function handleSync(req, res) {
  const ip = clientIp(req);
  try {
    if (!syncLimiter.hit(ip)) throw new AppError('Too many requests. Please wait a minute and try again.', 429);
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new AppError('Expected JSON.', 415);
    if (!dbEnabled()) throw new AppError('This server has no database connected, so cloud sync is not available. Set MONGODB_URI and restart.', 503);

    const raw = await readBody(req, MAX_TOTAL_BYTES + 128 * 1024);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new AppError('The request could not be read.', 400);
    }
    const code = normalizeCode(payload?.code);
    if (!code) {
      if (!syncFailLimiter.hit(ip)) throw new AppError('Too many wrong codes. Please wait a minute and try again.', 429);
      throw new AppError('That sync code is not valid — check it for typos.', 400);
    }
    const wipe = payload.wipe === true;
    const items = wipe ? {} : sanitizeItems(payload.items);
    let db;
    try {
      db = await getDb();
    } catch (e) {
      throw new AppError(`The database is not reachable right now: ${safeError(e)}`, 503);
    }
    await ensureIndexes(db);
    const result = await syncExchange(db, { code, items, create: payload.create === true, wipe });
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    const known = err instanceof AppError || err instanceof SyncError || Number.isInteger(err?.status);
    if (err instanceof SyncError && err.status === 404) syncFailLimiter.hit(ip); // guessing codes gets throttled
    if (!known) console.error(err);
    sendJson(res, known ? err.status || 400 : 500, { error: known ? err.message : 'Something went wrong on the server.' });
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'Bad request' });
    }
    if (req.method === 'POST' && url.pathname === '/api/sync') return handleSync(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });

    if (url.pathname.startsWith('/api/')) {
      const handler = routes[url.pathname];
      if (!handler) return sendJson(res, 404, { error: 'Unknown API endpoint' });
      const started = Date.now();
      try {
        const data = await handler(url.searchParams, req);
        sendJson(res, 200, data);
      } catch (err) {
        const status = err instanceof AppError ? err.status : 500;
        const message = err instanceof AppError ? err.message : 'Something went wrong on the server.';
        if (!(err instanceof AppError)) console.error(err);
        sendJson(res, status, { error: message });
      } finally {
        if (process.env.DEBUG) console.log(`${url.pathname}${url.search} ${Date.now() - started}ms`);
      }
      return;
    }
    try {
      await serveStatic(req, res, url.pathname);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500).end('Server error');
    }
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* opening the browser is optional */
  }
}

function listen(server, port, attemptsLeft = 10) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`Port ${port} is busy, trying ${port + 1}...`);
      listen(server, port + 1, attemptsLeft - 1);
    } else {
      console.error('Could not start server:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  StockSense is running at ${url}\n  (press Ctrl+C to stop)\n`);
    if (dbEnabled()) {
      getDb().then(
        () => console.log('  MongoDB: connected — intraday scans and best picks are being saved.\n'),
        (e) => console.log(`  MongoDB: NOT reachable (${safeError(e)})\n  The app still works; nothing is saved until the connection is fixed.\n`)
      );
    } else {
      console.log('  MongoDB: off (set MONGODB_URI in .env to save history).\n');
    }
    if (process.argv.includes('--open')) openBrowser(url);
  });
}

process.on('unhandledRejection', (err) => console.error('Unhandled error:', err));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  listen(createServer(), START_PORT);
}

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { getChart, search, AppError } from './lib/yahoo.js';
import { analyze, summarize, round } from './lib/analysis.js';
import { scoreHeadline, aggregate } from './lib/sentiment.js';
import { getNews, newsNameFor } from './lib/news.js';
import { MARKETS } from './lib/universe.js';
import { mapLimit, cleanSymbol } from './lib/util.js';

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
const SHARED_FILES = { '/lib/indicators.js': path.join(__dirname, 'lib', 'indicators.js') };

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

export function createServer() {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'Bad request' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });

    if (url.pathname.startsWith('/api/')) {
      const handler = routes[url.pathname];
      if (!handler) return sendJson(res, 404, { error: 'Unknown API endpoint' });
      const started = Date.now();
      try {
        const data = await handler(url.searchParams);
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
    if (process.argv.includes('--open')) openBrowser(url);
  });
}

process.on('unhandledRejection', (err) => console.error('Unhandled error:', err));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  listen(createServer(), START_PORT);
}

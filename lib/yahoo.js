// Data access for Yahoo Finance's public endpoints, with timeouts, retries,
// response caching, request de-duplication and stale-data fallback.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

export class AppError extends Error {
  constructor(message, status = 500, retryable = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- cache ----------
const cache = new Map(); // key -> { value, expires }
const inflight = new Map(); // key -> Promise
const MAX_CACHE = 600;

export async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.value;
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const value = await fn();
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    } catch (err) {
      // Network trouble: serve slightly old data rather than nothing (but never for "not found").
      if (hit && err.status !== 404 && err.status !== 400 && now - hit.expires < 60 * 60 * 1000) {
        return { ...hit.value, stale: true };
      }
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export function clearCache() {
  cache.clear();
}

// ---------- HTTP ----------
export async function fetchJson(path, { timeoutMs = 10000, retries = 2, fetchImpl = fetch } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const host = HOSTS[attempt % HOSTS.length];
    try {
      const res = await fetchImpl(host + path, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) throw new AppError('The data provider is rate-limiting requests. Please wait a minute and try again.', 503, true);
      if (res.status >= 500) throw new AppError(`The data provider is having problems (HTTP ${res.status}). Try again shortly.`, 502, true);
      let body;
      try {
        body = await res.json();
      } catch {
        throw new AppError('The data provider returned an unreadable response.', 502, true);
      }
      if (!res.ok && res.status !== 404) {
        throw new AppError(`The data provider rejected the request (HTTP ${res.status}).`, 502, false);
      }
      return { status: res.status, body };
    } catch (err) {
      lastErr = normalizeError(err);
      if (!lastErr.retryable || attempt === retries) break;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

function normalizeError(err) {
  if (err instanceof AppError) return err;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return new AppError('The data provider took too long to respond. Check your internet connection and try again.', 504, true);
  }
  return new AppError('Could not connect to the market data provider. Check your internet connection.', 503, true);
}

// ---------- chart / quote ----------
// `step` (seconds) > 0 means intraday bars: times become numeric timestamps
// shifted to exchange-local time (so the chart shows market hours), and bars
// are aligned to the session grid so the live, in-progress bar always lands
// on the same slot as the finished one.
export function normalizeChart(body, requested, { step = 0 } = {}) {
  const result = body?.chart?.result?.[0];
  if (!result) {
    throw new AppError(
      `No data found for "${requested}". Check the symbol (Indian stocks end in .NS or .BO, e.g. RELIANCE.NS).`,
      404
    );
  }
  const meta = result.meta ?? {};
  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const offset = Number(meta.gmtoffset) || 0;

  // Drop bars with missing values. Daily: keep the last bar per calendar day.
  // Intraday: merge bars that fall in the same time slot.
  const bars = new Map();
  const anchor = ts.find((t) => Number.isFinite(t)) ?? 0;
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (![o, h, l, c].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) continue;
    const volume = Number.isFinite(q.volume?.[i]) ? q.volume[i] : 0;
    const bar = { open: o, high: Math.max(h, o, c), low: Math.min(l, o, c), close: c, volume };
    if (step > 0) {
      const aligned = ts[i] - ((((ts[i] - anchor) % step) + step) % step);
      const time = aligned + offset;
      const prev = bars.get(time);
      if (prev) {
        prev.high = Math.max(prev.high, bar.high);
        prev.low = Math.min(prev.low, bar.low);
        prev.close = bar.close;
        prev.volume = Math.max(prev.volume, volume);
      } else {
        bars.set(time, { time, ...bar });
      }
    } else {
      const time = new Date((ts[i] + offset) * 1000).toISOString().slice(0, 10);
      bars.set(time, { time, ...bar });
    }
  }
  const candles = [...bars.values()].sort((a, b) => (a.time < b.time ? -1 : 1));
  if (!candles.length) {
    throw new AppError(`No price history available for "${requested}". It may be delisted or not traded yet.`, 404);
  }

  const last = candles[candles.length - 1];
  const price = Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : last.close;
  // Keep the latest candle in sync with the live quote.
  if (Math.abs(price - last.close) / last.close < 0.2) {
    last.close = price;
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
  }
  const prevClose = candles.length > 1 ? candles[candles.length - 2].close : meta.chartPreviousClose ?? null;
  const change = prevClose ? price - prevClose : null;

  const period = meta.currentTradingPeriod?.regular;
  const nowSec = Date.now() / 1000;
  const marketState = period && nowSec >= period.start && nowSec < period.end ? 'open' : 'closed';

  return {
    symbol: meta.symbol ?? requested,
    name: meta.longName || meta.shortName || meta.symbol || requested,
    currency: meta.currency || 'USD',
    exchange: meta.fullExchangeName || meta.exchangeName || '',
    instrumentType: meta.instrumentType || '',
    price,
    prevClose,
    change,
    changePct: prevClose ? (change / prevClose) * 100 : null,
    marketState,
    marketTime: meta.regularMarketTime ? meta.regularMarketTime * 1000 : null,
    sessionEnd: period?.end ? period.end * 1000 : null, // used for "minutes left" in the intraday view
    candles,
  };
}

export function getChart(symbol, range = '2y', interval = '1d', { ttlMs = 3 * 60 * 1000, step = 0, tag = '' } = {}) {
  return cached(`chart:${symbol}:${range}:${interval}:${tag}`, ttlMs, async () => {
    const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplit`;
    const { body } = await fetchJson(path, step ? { timeoutMs: 8000, retries: 1 } : undefined);
    return normalizeChart(body, symbol, { step });
  });
}

// ---------- search & news ----------
export function search(query, { quotesCount = 8, newsCount = 0 } = {}) {
  const q = query.trim().slice(0, 60);
  return cached(`search:${q.toLowerCase()}:${quotesCount}:${newsCount}`, 5 * 60 * 1000, async () => {
    const path = `/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=${quotesCount}&newsCount=${newsCount}&enableFuzzyQuery=true&listsCount=0`;
    const { body } = await fetchJson(path);
    const quotes = (body?.quotes ?? [])
      .filter((x) => x.symbol && ['EQUITY', 'ETF', 'INDEX', 'MUTUALFUND'].includes(x.quoteType))
      .map((x) => ({
        symbol: x.symbol,
        name: x.longname || x.shortname || x.symbol,
        exchange: x.exchDisp || x.exchange || '',
        type: x.typeDisp || x.quoteType,
      }));
    const news = (body?.news ?? [])
      .filter((x) => x.title && x.link)
      .map((x) => ({
        title: String(x.title),
        publisher: x.publisher || '',
        link: x.link,
        time: x.providerPublishTime ? x.providerPublishTime * 1000 : null,
        tickers: Array.isArray(x.relatedTickers) ? x.relatedTickers.slice(0, 5) : [],
      }));
    return { quotes, news };
  });
}

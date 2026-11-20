// StockSense front-end. Plain JS, no build step.
import { sma, rsi, macd, bollinger } from '/lib/indicators.js';
import { viewAcademy } from './academy.js';
import { initPaper, viewPaper, cleanupPaper, openOrder } from './paper.js';
import { initIntraday, viewIntraday, loadIntradayCard } from './intraday.js';

// ---------- utilities ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage may be disabled — app still works */
    }
  },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function safeUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : '#';
  } catch {
    return '#';
  }
}
const enc = encodeURIComponent;

function fmtNum(v, digits = 2) {
  if (!isNum(v)) return '—';
  return new Intl.NumberFormat(state.market === 'IN' ? 'en-IN' : 'en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
}
function fmtPrice(v, currency, symbol = '') {
  if (!isNum(v)) return '—';
  if (symbol.startsWith('^')) return fmtNum(v); // indices are points, not money
  const d = Math.abs(v) < 1 ? 4 : 2;
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency', currency: currency || 'USD', minimumFractionDigits: d, maximumFractionDigits: d,
    }).format(v);
  } catch {
    return fmtNum(v, d);
  }
}
function fmtPct(v, digits = 2) {
  if (!isNum(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}
function fmtCompact(v) {
  if (!isNum(v)) return '—';
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}
const cls = (v) => (isNum(v) ? (v > 0 ? 'up' : v < 0 ? 'down' : 'muted') : 'muted');
function timeAgo(ms) {
  if (!isNum(ms)) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
function verdictClass(key) {
  return key === 'buy' || key === 'strong_buy' ? 'bull' : key === 'hold' ? 'warn' : key ? 'bear' : 'neutral';
}
function verdictPill(v) {
  if (!v) return '<span class="pill neutral">No signal</span>';
  return `<span class="pill ${verdictClass(v.key)}">${esc(v.label)}</span>`;
}

function spark(values, w = 110, h = 34) {
  const v = (values || []).filter(isNum);
  if (v.length < 2) return '';
  const min = Math.min(...v), max = Math.max(...v), range = max - min || 1;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - 2 - ((x - min) / range) * (h - 4)).toFixed(1)}`).join(' ');
  const color = v[v.length - 1] >= v[0] ? 'var(--up)' : 'var(--down)';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" points="${pts}"/></svg>`;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

async function api(path, { timeout = 45000, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(path, { signal: ctrl.signal });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON response */
    }
    if (!res.ok) throw new Error(body?.error || `Request failed (HTTP ${res.status}).`);
    return body;
  } catch (e) {
    if (e.name === 'AbortError') {
      if (signal?.aborted) throw e;
      throw new Error('The request took too long. Please check your internet connection and try again.');
    }
    if (e instanceof TypeError) throw new Error('Cannot reach the StockSense server. Make sure it is still running.');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const errorBox = (msg, retryId) =>
  `<div class="error-box">⚠ ${esc(msg)}${retryId ? `<br><button class="btn" id="${retryId}">Try again</button>` : ''}</div>`;
const skel = (h = 80) => `<div class="skeleton" style="height:${h}px"></div>`;
const loading = (text = 'Loading…') => `<div class="empty"><span class="spinner"></span> ${esc(text)}</div>`;

// ---------- state ----------
const state = {
  market: store.get('ss.market', 'IN') === 'US' ? 'US' : 'IN',
  watch: (Array.isArray(store.get('ss.watch', null)) ? store.get('ss.watch', []) : []).filter((s) => typeof s === 'string' && s.length <= 25),
  capital: store.get('ss.capital', 100000),
  riskPct: store.get('ss.riskPct', 1),
  viewId: 0,
  charts: [],
  timers: [],
  controllers: [],
  lastAnalysis: null,
  chartInterval: ['1m', '5m', '15m', '1h', '1d'].includes(store.get('ss.interval', '1d')) ? store.get('ss.interval', '1d') : '1d',
  picksMode: 'short',
  picksFilter: 'all',
};
const POPULAR = {
  IN: ['RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'INFY.NS', 'ITC.NS', 'SBIN.NS', 'TATASTEEL.NS', '^NSEI'],
  US: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'META', '^GSPC'],
};
const marketLabel = () => (state.market === 'IN' ? 'Indian' : 'US');

function cleanupView() {
  cleanupPaper();
  stopLive();
  live.handle = null;
  destroyCharts();
  document.title = 'StockSense — Beginner Stock Analyser';
  state.timers.forEach(clearInterval);
  state.timers = [];
  state.controllers.forEach((c) => c.abort());
  state.controllers = [];
}
function newController() {
  const c = new AbortController();
  state.controllers.push(c);
  return c;
}

// ---------- router ----------
const views = { dashboard: viewDashboard, analyze: viewAnalyze, picks: viewPicks, intraday: viewIntraday, watchlist: viewWatchlist, paper: viewPaper, news: viewNews, academy: viewAcademy, learn: viewLearn };

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const tab = views[parts[0]] ? parts[0] : 'dashboard';
  let param = '';
  try {
    param = parts.slice(1).join('/') ? decodeURIComponent(parts.slice(1).join('/')) : '';
  } catch {
    param = '';
  }
  return { tab, param };
}

async function route() {
  cleanupView();
  const id = ++state.viewId;
  const alive = () => id === state.viewId;
  const { tab, param } = parseHash();
  $$('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  window.scrollTo(0, 0);
  try {
    await views[tab](param, alive);
  } catch (e) {
    if (e.name === 'AbortError' || !alive()) return;
    console.error(e);
    view.innerHTML = errorBox(e.message || 'Something went wrong.', 'retryView');
    $('#retryView')?.addEventListener('click', route);
  }
}
const goAnalyze = (symbol) => (location.hash = `#/analyze/${enc(symbol)}`);

// ---------- dashboard ----------
async function viewDashboard(_, alive) {
  view.innerHTML = `<div id="dash">
    <div class="section-head">
      <h2>${marketLabel()} market today</h2>
      <div class="small muted"><span id="dUpdated"></span> <button class="btn small" id="dRefresh">↻ Refresh</button></div>
    </div>
    <div id="dIndices" class="grid cols-4">${[1, 2, 3, 4].map(() => `<div class="card">${skel(70)}</div>`).join('')}</div>
    <div class="grid split section">
      <div class="card"><div class="section-head"><h3>Best setups right now</h3><a href="#/picks" class="small">All picks →</a></div><div id="dSetups">${skel(180)}</div></div>
      <div class="card" id="dMood">${skel(180)}</div>
    </div>
    <div class="grid cols-2 section">
      <div class="card"><h3>Top gainers today</h3><div id="dGainers">${skel(150)}</div></div>
      <div class="card"><h3>Top losers today</h3><div id="dLosers">${skel(150)}</div></div>
    </div>
    <div class="card section"><div class="section-head"><h3>Market news</h3><a href="#/news" class="small">More news →</a></div><div id="dNews">${skel(150)}</div></div>
  </div>`;
  // One delegated click handler for every stock row / index card on the dashboard.
  $('#dash').addEventListener('click', (e) => {
    const el = e.target.closest('[data-sym]');
    if (el) goAnalyze(el.dataset.sym);
  });

  const ctrl = newController();
  const load = () => {
    loadIndices(alive, ctrl.signal);
    loadScan(alive, ctrl.signal);
    loadNewsInto($('#dNews'), '', alive, ctrl.signal, 6);
  };
  $('#dRefresh').addEventListener('click', load);
  load();
  // Auto-refresh every 5 minutes while the tab is visible.
  state.timers.push(setInterval(() => { if (!document.hidden && alive()) load(); }, 5 * 60 * 1000));
}

let indicesCache = null;
async function loadIndices(alive, signal) {
  const box = $('#dIndices');
  try {
    const data = await api(`/api/indices?market=${state.market}`, { signal });
    if (!alive()) return;
    indicesCache = data;
    box.innerHTML = data.items.map(indexCard).join('');
    renderMood();
  } catch (e) {
    if (!alive() || e.name === 'AbortError') return;
    box.innerHTML = `<div class="card" style="grid-column:1/-1">${errorBox(e.message, 'rIdx')}</div>`;
    $('#rIdx')?.addEventListener('click', () => loadIndices(alive, signal));
  }
}

function vixMood(v, market) {
  if (!isNum(v)) return '';
  const hi = market === 'IN' ? 22 : 25;
  if (v < 15) return 'Calm — low fear';
  if (v < hi) return 'Normal — some nervousness';
  return 'High fear — expect big swings';
}

function indexCard(ix) {
  if (ix.error) return `<div class="card index-card"><div class="name">${esc(ix.name)}</div><div class="muted small">Unavailable: ${esc(ix.error)}</div></div>`;
  const extra = ix.isVix
    ? `<span class="pill ${ix.price >= (state.market === 'IN' ? 22 : 25) ? 'bear' : ix.price < 15 ? 'bull' : 'warn'}">${esc(vixMood(ix.price, state.market))}</span>`
    : verdictPill(ix.verdict);
  return `
    <div class="card index-card click" data-sym="${esc(ix.symbol)}" title="Click to analyse ${esc(ix.name)}">
      <div class="row"><span class="name">${esc(ix.name)}</span><span class="pill ${ix.marketState === 'open' ? 'open' : 'closed'}">${ix.marketState === 'open' ? '● Open' : 'Closed'}</span></div>
      <div class="row">
        <div>
          <div class="price num">${fmtNum(ix.price)}</div>
          <div class="num ${cls(ix.changePct)}">${fmtNum(ix.change)} (${fmtPct(ix.changePct)})</div>
        </div>
        ${spark(ix.spark)}
      </div>
      <div style="margin-top:8px">${extra}</div>
    </div>`;
}

let scanCache = null;
async function loadScan(alive, signal) {
  try {
    const data = await api(`/api/scan?market=${state.market}`, { signal, timeout: 90000 });
    if (!alive()) return;
    scanCache = data;
    const items = data.items.filter((i) => !i.insufficient);
    $('#dUpdated').textContent = `Updated ${new Date(data.updated).toLocaleTimeString()}`;

    const setups = [...items].sort((a, b) => b.score - a.score).slice(0, 6);
    $('#dSetups').innerHTML = setups.length ? `<div class="list">${setups.map(setupRow).join('')}</div>` : '<div class="empty">No data.</div>';

    const byChange = items.filter((i) => isNum(i.changePct)).sort((a, b) => b.changePct - a.changePct);
    const gainers = byChange.filter((i) => i.changePct > 0).slice(0, 5);
    $('#dGainers').innerHTML = gainers.length
      ? `<div class="list">${gainers.map(moverRow).join('')}</div>`
      : '<div class="empty">No stocks are up today.</div>';
    const losers = byChange.filter((i) => i.changePct < 0).slice(-5).reverse();
    $('#dLosers').innerHTML = losers.length
      ? `<div class="list">${losers.map(moverRow).join('')}</div>`
      : '<div class="empty">No stocks are down today.</div>';
    renderMood();
  } catch (e) {
    if (!alive() || e.name === 'AbortError') return;
    for (const id of ['#dSetups', '#dGainers', '#dLosers']) $(id).innerHTML = errorBox(e.message);
    $('#dMood').innerHTML = errorBox(e.message);
  }
}

function setupRow(s) {
  return `<div class="list-row" data-sym="${esc(s.symbol)}">
    <div><div class="nm">${esc(s.name)}</div><div class="sub">${esc(s.symbol)} · RSI ${fmtNum(s.rsi, 0)} · 1M ${fmtPct(s.ret1m, 1)}</div></div>
    <div class="num" style="text-align:right">${fmtPrice(s.price, s.currency, s.symbol)}<div class="small ${cls(s.changePct)}">${fmtPct(s.changePct)}</div></div>
    ${verdictPill(s.verdict)}
  </div>`;
}
function moverRow(s) {
  return `<div class="list-row" data-sym="${esc(s.symbol)}">
    <div><div class="nm">${esc(s.name)}</div><div class="sub">${esc(s.symbol)}</div></div>
    <div class="num">${fmtPrice(s.price, s.currency, s.symbol)}</div>
    <div class="num ${cls(s.changePct)}" style="min-width:64px;text-align:right;font-weight:700">${fmtPct(s.changePct)}</div>
  </div>`;
}

function renderMood() {
  const box = $('#dMood');
  if (!box || !scanCache) return;
  const items = scanCache.items.filter((i) => !i.insufficient);
  if (!items.length) return;
  const avg = items.reduce((t, i) => t + i.score, 0) / items.length;
  const rising = items.filter((i) => i.changePct > 0).length;
  const above50 = items.filter((i) => i.aboveSma50).length;
  const label = avg >= 20 ? 'Bullish' : avg <= -20 ? 'Bearish' : 'Neutral';
  const color = avg >= 20 ? 'up' : avg <= -20 ? 'down' : '';
  const vix = indicesCache?.items.find((i) => i.isVix && !i.error);
  const advice =
    label === 'Bullish' ? 'Most big stocks are in good shape. A good environment for buying quality stocks with a stop-loss.'
    : label === 'Bearish' ? 'Most big stocks are weak. Be careful — protect your capital and avoid rushing in.'
    : 'The market is mixed. Be selective and only buy strong setups.';
  box.innerHTML = `
    <h3>Market mood</h3>
    <div class="mood"><div class="big ${color}">${label}</div></div>
    <div class="meter" aria-label="Market mood meter"><span class="needle" style="left:${Math.min(98, Math.max(2, (avg + 100) / 2))}%"></span></div>
    <div class="meter-labels"><span>Bearish</span><span>Neutral</span><span>Bullish</span></div>
    <p class="small">${advice}</p>
    <ul class="notes small">
      <li><b>${rising}</b> of ${items.length} large stocks are up today.</li>
      <li><b>${Math.round((above50 / items.length) * 100)}%</b> are above their 50-day average (healthy trend).</li>
      ${vix ? `<li>Fear gauge (${esc(vix.name.split(' ')[0])}): <b>${fmtNum(vix.price)}</b> — ${esc(vixMood(vix.price, state.market))}.</li>` : ''}
    </ul>`;
}

// ---------- news ----------
function newsItem(n) {
  const s = n.sentiment?.label || 'neutral';
  const pill = s === 'positive' ? '<span class="pill bull">Positive</span>' : s === 'negative' ? '<span class="pill bear">Negative</span>' : '<span class="pill neutral">Neutral</span>';
  return `<a class="news-item" href="${esc(safeUrl(n.link))}" target="_blank" rel="noopener noreferrer">
    <div class="title">${esc(n.title)}</div>
    <div class="meta">${pill}<span>${esc(n.publisher)}</span>${n.time ? `<span>· ${esc(timeAgo(n.time))}</span>` : ''}</div>
  </a>`;
}
async function loadNewsInto(box, query, alive, signal, limit = 20, keywords = []) {
  if (!box) return;
  try {
    const data = await api(`/api/news?market=${state.market}&q=${enc(query)}&k=${enc(keywords.join('|'))}`, { signal });
    if (!alive()) return;
    const items = data.items.slice(0, limit);
    if (!items.length) {
      box.innerHTML = '<div class="empty">No recent news found.</div>';
      return data;
    }
    const s = data.sentiment;
    const moodPill = s.mood === 'positive' ? 'bull' : s.mood === 'negative' ? 'bear' : 'neutral';
    box.innerHTML = `<div class="small muted" style="margin-bottom:4px">Headline mood: <span class="pill ${moodPill}">${esc(s.mood)}</span> · ${s.positive} positive, ${s.negative} negative, ${s.neutral} neutral</div>
      ${items.map(newsItem).join('')}`;
    return data;
  } catch (e) {
    if (!alive() || e.name === 'AbortError') return;
    box.innerHTML = errorBox(e.message);
  }
}

async function viewNews(param, alive) {
  view.innerHTML = `
    <div class="section-head"><h2>News</h2></div>
    <form class="card" id="newsForm" style="display:flex;gap:8px;flex-wrap:wrap">
      <input id="newsQ" type="search" placeholder="Search news (e.g. Infosys results, RBI policy, oil prices)" value="${esc(param)}"
        style="flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2)" maxlength="80" />
      <button class="btn primary" type="submit">Search</button>
    </form>
    <div class="card section"><h3 id="newsTitle">${param ? `News: ${esc(param)}` : `${marketLabel()} market headlines`}</h3><div id="newsList">${skel(300)}</div></div>
    <p class="small muted">"Positive / Negative" is an automatic guess from headline words. Always read the full article before making decisions.</p>`;
  $('#newsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#newsQ').value.trim();
    location.hash = q ? `#/news/${enc(q)}` : '#/news';
  });
  await loadNewsInto($('#newsList'), param, alive, newController().signal, 20);
}

// ---------- analyse ----------
async function viewAnalyze(param, alive) {
  if (!param) {
    const chips = POPULAR[state.market].map((s) => `<button class="btn" data-sym="${esc(s)}">${esc(s)}</button>`).join('');
    view.innerHTML = `<div class="card hero-empty">
      <h2>Analyse any stock</h2>
      <p class="muted">Type a company name in the search box above — for example <b>Reliance</b>, <b>Infosys</b> or <b>Apple</b>.<br>
      You'll get a simple Buy / Hold / Sell signal, entry price, stop-loss and targets, with plain-English explanations.</p>
      <div class="chips">${chips}</div></div>`;
    $$('[data-sym]', view).forEach((b) => b.addEventListener('click', () => goAnalyze(b.dataset.sym)));
    return;
  }
  view.innerHTML = loading(`Analysing ${param}…`);
  const data = await api(`/api/analyze?symbol=${enc(param)}&market=${state.market}`, { signal: newController().signal });
  if (!alive()) return;
  // Server may have resolved e.g. RELIANCE -> RELIANCE.NS
  if (data.quote.symbol !== param) history.replaceState(null, '', `#/analyze/${enc(data.quote.symbol)}`);
  state.lastAnalysis = data;
  renderAnalyze(data, alive);
}

function renderAnalyze(data, alive) {
  const { quote: q, analysis: a } = data;
  const inWatch = state.watch.includes(q.symbol);
  const head = `
    <div class="stock-head">
      <div>
        <h1>${esc(q.name)}</h1>
        <div class="muted small">${esc(q.symbol)}${q.exchange ? ` · ${esc(q.exchange)}` : ''} · <span id="hdrState" class="pill ${q.marketState === 'open' ? 'open' : 'closed'}">${q.marketState === 'open' ? '● Market open' : 'Market closed'}</span><span id="hdrAsOf">${q.marketTime ? ` · as of ${esc(new Date(q.marketTime).toLocaleString())}` : ''}</span></div>
      </div>
      <div style="text-align:right">
        <div class="price num" id="hdrPrice" data-v="${isNum(q.price) ? q.price : ''}">${fmtPrice(q.price, q.currency, q.symbol)}</div>
        <div id="hdrChange" class="num ${cls(q.changePct)}" style="font-weight:700">${fmtNum(q.change)} (${fmtPct(q.changePct)}) today</div>
        <div class="stock-actions">
          <button class="star ${inWatch ? 'on' : ''}" id="starBtn">${inWatch ? '★ In watchlist' : '☆ Add to watchlist'}</button>
          ${q.symbol.startsWith('^') ? '' : `<button class="btn buy" id="ptBuy" title="Practise with virtual money — no real order is placed">Paper Buy</button><button class="btn sell" id="ptSell" title="Practise with virtual money — no real order is placed">Paper Sell</button>`}
        </div>
      </div>
    </div>
    ${q.stale ? '<div class="disclaimer" style="width:100%;margin:12px 0 0">The data provider is not responding — showing the last saved data.</div>' : ''}`;

  if (a.insufficient) {
    view.innerHTML = `${head}<div class="card section">${esc(a.message)}</div>${chartCardHtml()}`;
    bindStar(q);
    bindChartToolbar(data, alive);
    mountChart(data, alive);
    return;
  }

  view.innerHTML = `
    ${head}
    <div class="grid split section" style="align-items:start">
      ${verdictCard(a)}
      ${planCard(a, q)}
    </div>
    <div class="card section" id="aIntraday">${skel(120)}</div>
    <div class="section">${chartCardHtml()}</div>
    <div class="grid cols-2 section">
      <div class="card"><h3>What the chart is telling you</h3>${a.factors.map(factorRow).join('')}</div>
      <div class="grid" style="align-content:start">
        ${calcCard(a, q)}
        ${statsCard(a, q)}
      </div>
    </div>
    <div class="card section"><h3>Latest news about ${esc(q.name)}</h3><div id="aNews">${skel(160)}</div></div>`;

  bindStar(q);
  bindCalc(a, q);
  bindChartToolbar(data, alive);
  mountChart(data, alive);
  loadNewsInto($('#aNews'), q.newsQuery || q.name, alive, newController().signal, 8, q.newsKeywords || []);
  loadIntradayCard(q, alive, newController().signal);
}

function bindStar(q) {
  $('#ptBuy')?.addEventListener('click', () => openOrder({ symbol: q.symbol, name: q.name, side: 'BUY' }));
  $('#ptSell')?.addEventListener('click', () => openOrder({ symbol: q.symbol, name: q.name, side: 'SELL' }));
  $('#starBtn')?.addEventListener('click', (e) => {
    const on = state.watch.includes(q.symbol);
    state.watch = on ? state.watch.filter((s) => s !== q.symbol) : [...state.watch, q.symbol].slice(-40);
    store.set('ss.watch', state.watch);
    e.currentTarget.classList.toggle('on', !on);
    e.currentTarget.textContent = on ? '☆ Add to watchlist' : '★ In watchlist';
    toast(on ? `Removed ${q.symbol} from watchlist` : `Added ${q.symbol} to watchlist`);
  });
}

function verdictCard(a) {
  const s = a.score;
  const bar = s >= 0
    ? `<span style="left:50%;width:${s / 2}%;background:var(--up)"></span>`
    : `<span style="left:${50 + s / 2}%;width:${-s / 2}%;background:var(--down)"></span>`;
  return `<div class="card verdict ${esc(a.verdict.key)}">
    <div class="muted small" style="font-weight:600">SIGNAL</div>
    <div class="label ${verdictClass(a.verdict.key) === 'bull' ? 'up' : verdictClass(a.verdict.key) === 'bear' ? 'down' : ''}" style="${a.verdict.key === 'hold' ? 'color:var(--warn)' : ''}">${esc(a.verdict.label)}</div>
    <div class="score-bar" title="Score ${s} out of ±100">${bar}<span style="left:50%;width:2px;background:var(--muted)"></span></div>
    <div class="small muted num">Score ${s > 0 ? '+' : ''}${s} / 100 · Confidence: <b>${esc(a.confidence)}</b> · ${a.bullishCount} positive, ${a.bearishCount} negative signals</div>
    <p style="margin:4px 0 0">${esc(a.verdict.summary)}</p>
    ${a.pattern ? `<div class="small"><span class="pill ${a.pattern.bias === 'bullish' ? 'bull' : a.pattern.bias === 'bearish' ? 'bear' : 'neutral'}">Candle: ${esc(a.pattern.name)}</span></div>` : ''}
  </div>`;
}

function planCard(a, q) {
  const p = a.plan;
  const P = (v) => fmtPrice(v, q.currency, q.symbol);
  let items = '';
  if (p.action === 'buy' || p.action === 'wait') {
    items = `
      <div class="plan-item entry"><div class="k">${p.action === 'buy' ? 'ENTRY ZONE' : 'BETTER ENTRY ZONE'}</div><div class="v num">${P(p.entryLow)} – ${P(p.entryHigh)}</div></div>
      <div class="plan-item stop"><div class="k">STOP-LOSS (exit if below)</div><div class="v num">${P(p.stopLoss)}</div></div>
      <div class="plan-item target"><div class="k">TARGET 1</div><div class="v num">${P(p.target1)}</div></div>
      <div class="plan-item target"><div class="k">TARGET 2</div><div class="v num">${P(p.target2)}</div></div>`;
  } else {
    items = `
      <div class="plan-item stop"><div class="k">EXIT LEVEL (if you own it)</div><div class="v num">${P(p.exitLevel)}</div></div>
      <div class="plan-item"><div class="k">NEAREST SUPPORT</div><div class="v num">${P(a.levels.supports[0])}</div></div>
      <div class="plan-item"><div class="k">NEAREST RESISTANCE</div><div class="v num">${P(a.levels.resistances[0])}</div></div>
      <div class="plan-item"><div class="k">50-DAY AVERAGE</div><div class="v num">${P(a.stats.sma50)}</div></div>`;
  }
  const rr = p.action !== 'avoid' && isNum(p.riskReward)
    ? `<div class="small muted">Risk : Reward = <b>1 : ${p.riskReward.toFixed(1)}</b> · risk ${fmtNum(p.riskPct, 1)}% per share ${p.riskReward >= 2 ? '<span class="pill bull">Good</span>' : p.riskReward >= 1.5 ? '<span class="pill warn">OK</span>' : '<span class="pill bear">Poor</span>'}</div>`
    : '';
  const head = p.action === 'buy' ? 'up' : p.action === 'wait' ? '' : 'down';
  return `<div class="card">
    <div class="muted small" style="font-weight:600">TRADE PLAN</div>
    <h2 class="${head}" style="${p.action === 'wait' ? 'color:var(--warn)' : ''}">${esc(p.headline)}</h2>
    <div class="plan-grid">${items}</div>
    ${rr}
    <ul class="notes small">${p.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
  </div>`;
}

function factorRow(f) {
  const icon = f.verdict === 'bullish' ? '↑' : f.verdict === 'bearish' ? '↓' : '•';
  return `<div class="factor"><div class="ic ${f.verdict}">${icon}</div><div><div class="t">${esc(f.label)}</div><div class="d">${esc(f.text)}</div></div></div>`;
}

function statsCard(a, q) {
  const s = a.stats;
  const P = (v) => fmtPrice(v, q.currency, q.symbol);
  const vol = s.volatility;
  const volText = !isNum(vol) ? '' : vol < 20 ? 'Low' : vol < 35 ? 'Medium' : 'High';
  return `<div class="card">
    <h3>Key numbers</h3>
    <div class="small muted">52-week range</div>
    <div class="range52"><i style="left:${isNum(s.rangePos) ? Math.min(100, Math.max(0, s.rangePos)) : 50}%"></i></div>
    <div class="small num" style="display:flex;justify-content:space-between"><span>${P(s.low52)}</span><span>${P(s.high52)}</span></div>
    <div class="stats section" style="margin-top:12px">
      <div><span>1 week</span><span class="num ${cls(s.ret1w)}">${fmtPct(s.ret1w)}</span></div>
      <div><span>1 month</span><span class="num ${cls(s.ret1m)}">${fmtPct(s.ret1m)}</span></div>
      <div><span>3 months</span><span class="num ${cls(s.ret3m)}">${fmtPct(s.ret3m)}</span></div>
      <div><span>6 months</span><span class="num ${cls(s.ret6m)}">${fmtPct(s.ret6m)}</span></div>
      <div><span>1 year</span><span class="num ${cls(s.ret1y)}">${fmtPct(s.ret1y)}</span></div>
      <div><span>From 52w high</span><span class="num ${cls(s.fromHigh52)}">${fmtPct(s.fromHigh52)}</span></div>
      <div><span title="How much the price swings in a year">Volatility</span><span class="num">${isNum(vol) ? `${vol.toFixed(0)}% (${volText})` : '—'}</span></div>
      <div><span title="Average daily price move (ATR)">Avg daily move</span><span class="num">${P(s.atr)}</span></div>
      <div><span>RSI (14)</span><span class="num">${fmtNum(s.rsi, 0)}</span></div>
      <div><span>Avg volume</span><span class="num">${fmtCompact(s.avgVolume)}</span></div>
      <div><span>20-day avg</span><span class="num">${P(s.sma20)}</span></div>
      <div><span>50-day avg</span><span class="num">${P(s.sma50)}</span></div>
      <div><span>200-day avg</span><span class="num">${P(s.sma200)}</span></div>
      <div><span>Supports</span><span class="num">${a.levels.supports.map(P).join(', ')}</span></div>
      <div><span>Resistances</span><span class="num">${a.levels.resistances.map(P).join(', ')}</span></div>
    </div>
  </div>`;
}

function calcCard(a, q) {
  const p = a.plan;
  const entry = p.action === 'buy' ? q.price : isNum(p.entry) ? p.entry : q.price;
  return `<div class="card">
    <h3>How many shares should I buy?</h3>
    <p class="small muted" style="margin:0 0 10px">Professional traders risk only 1–2% of their money on one trade. Enter your numbers:</p>
    <form class="calc" id="calcForm" onsubmit="return false">
      <label>Total capital (${esc(q.currency)})<input id="cCap" type="number" min="0" step="any" inputmode="decimal" value="${esc(state.capital)}"></label>
      <label>Risk per trade (%)<input id="cRisk" type="number" min="0.1" max="10" step="0.1" inputmode="decimal" value="${esc(state.riskPct)}"></label>
      <label>Entry price<input id="cEntry" type="number" min="0" step="any" inputmode="decimal" value="${isNum(entry) ? +entry.toFixed(2) : ''}"></label>
      <label>Stop-loss price<input id="cStop" type="number" min="0" step="any" inputmode="decimal" value="${isNum(p.stopLoss) ? +p.stopLoss.toFixed(2) : ''}"></label>
    </form>
    <div class="calc-out" id="calcOut"></div>
  </div>`;
}

function bindCalc(a, q) {
  const out = $('#calcOut');
  if (!out) return;
  const P = (v) => fmtPrice(v, q.currency, q.symbol);
  const update = () => {
    const cap = parseFloat($('#cCap').value);
    const risk = parseFloat($('#cRisk').value);
    const entry = parseFloat($('#cEntry').value);
    const stop = parseFloat($('#cStop').value);
    if (isNum(cap) && cap >= 0) store.set('ss.capital', (state.capital = cap));
    if (isNum(risk) && risk > 0 && risk <= 10) store.set('ss.riskPct', (state.riskPct = risk));
    if (![cap, risk, entry, stop].every(isNum) || cap <= 0 || entry <= 0 || stop <= 0) {
      out.innerHTML = 'Fill in all four numbers (all must be greater than zero).';
      return;
    }
    if (risk > 10) { out.innerHTML = '⚠ Risking more than 10% on one trade is very dangerous. Use 1–2%.'; return; }
    if (stop >= entry) { out.innerHTML = '⚠ The stop-loss must be <b>below</b> the entry price.'; return; }
    const perShare = entry - stop;
    const maxLoss = (cap * risk) / 100;
    const qty = Math.min(Math.floor(maxLoss / perShare), Math.floor(cap / entry));
    if (qty < 1) {
      out.innerHTML = `Your risk budget (${P(maxLoss)}) is smaller than the risk on one share (${P(perShare)}). Increase capital/risk or choose a cheaper stock.`;
      return;
    }
    const t1 = a.plan.action !== 'avoid' ? a.plan.target1 : null;
    out.innerHTML = `Buy about <b class="num">${qty.toLocaleString()}</b> shares
      <div class="small">Money needed: <b class="num">${P(qty * entry)}</b> · Max loss if stop-loss hits: <b class="num down">${P(qty * perShare)}</b>
      ${isNum(t1) && t1 > entry ? ` · Profit at Target 1: <b class="num up">${P(qty * (t1 - entry))}</b>` : ''}</div>`;
  };
  $$('#calcForm input').forEach((i) => i.addEventListener('input', update));
  update();
}

// ---------- charts (live) ----------
const TIMEFRAMES = [['1m', '1 min'], ['5m', '5 min'], ['15m', '15 min'], ['1h', '1 hour'], ['1d', 'Daily']];
const live = { timer: null, handle: null, interval: '1d', paused: false, errors: 0, open: false, gen: 0 };

function chartBodyHtml() {
  return `<div class="chart-main" id="chartMain"></div>
    <div class="chart-sub" id="chartRsi"><span class="tag">RSI — above 70 overbought, below 30 oversold</span></div>
    <div class="chart-sub" id="chartMacd"><span class="tag">MACD — green bars = rising momentum, red = falling</span></div>`;
}

function chartCardHtml() {
  const iv = state.chartInterval;
  return `<div class="card chart-card">
    <div class="chart-toolbar">
      <div class="filters" id="ivBtns" aria-label="Candle timeframe">
        ${TIMEFRAMES.map(([k, l]) => `<button type="button" data-iv="${k}" class="${k === iv ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <div class="live-wrap">
        <span id="liveBadge" class="live-badge off">Connecting…</span>
        <button type="button" class="btn small" id="livePause">${live.paused ? '▶ Resume' : '❚❚ Pause'}</button>
      </div>
    </div>
    <div class="chart-toolbar">
      <div class="filters" id="rangeBtns" ${iv === '1d' ? '' : 'hidden'}>
        ${[['1M', 21], ['3M', 63], ['6M', 126], ['1Y', 252], ['2Y', 9999]].map(([l, n]) => `<button type="button" data-bars="${n}" class="${l === '6M' ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <div class="toggles">
        <label title="Average of the last 20 candles"><input type="checkbox" data-t="sma20" checked><span class="swatch" style="background:#e0a100"></span>Avg 20</label>
        <label title="Average of the last 50 candles"><input type="checkbox" data-t="sma50" checked><span class="swatch" style="background:#2c7be5"></span>Avg 50</label>
        <label title="Average of the last 200 candles"><input type="checkbox" data-t="sma200" checked><span class="swatch" style="background:#9b51e0"></span>Avg 200</label>
        <label><input type="checkbox" data-t="bb"><span class="swatch" style="background:#8a96a3"></span>Bollinger</label>
        <label><input type="checkbox" data-t="levels" checked>Support/Resistance</label>
        <label><input type="checkbox" data-t="plan" checked>Trade plan</label>
      </div>
    </div>
    <div class="small muted num" id="ohlc" style="min-height:20px"></div>
    <div class="chart-body">${chartBodyHtml()}</div>
  </div>`;
}

function hexAlpha(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function clientSeries(candles) {
  const closes = candles.map((c) => c.close);
  const bb = bollinger(closes, 20, 2);
  const m = macd(closes);
  return {
    sma20: sma(closes, 20), sma50: sma(closes, 50), sma200: sma(closes, 200),
    bbUpper: bb.upper, bbLower: bb.lower, rsi: rsi(closes, 14),
    macd: m.line, macdSignal: m.signal, macdHist: m.hist,
  };
}

function destroyCharts() {
  state.charts.forEach((c) => {
    try { c.remove(); } catch { /* already removed */ }
  });
  state.charts = [];
}

function stopLive() {
  clearTimeout(live.timer);
  live.timer = null;
  live.gen++; // invalidates any poll that is still in flight
}

function setLiveBadge() {
  const el = $('#liveBadge');
  if (!el) return;
  let cls = 'off', text = 'Market closed — showing last session';
  if (live.paused) { cls = 'paused'; text = 'Paused'; }
  else if (live.errors >= 2) { cls = 'warn'; text = '⚠ Reconnecting…'; }
  else if (live.open) { cls = 'on'; text = 'LIVE'; }
  el.className = `live-badge ${cls}`;
  el.textContent = text;
  el.title = live.open ? 'Candles update automatically every few seconds (data may be slightly delayed).' : 'The chart will start updating automatically when the market opens.';
}

// Update the page header (price, change, market status) from a live quote.
function applyLiveQuote(qt, data) {
  if (!qt || !isNum(qt.price)) return;
  const q = data.quote;
  const priceEl = $('#hdrPrice');
  if (priceEl) {
    const old = Number(priceEl.dataset.v);
    priceEl.textContent = fmtPrice(qt.price, q.currency, q.symbol);
    priceEl.dataset.v = qt.price;
    if (isNum(old) && old !== qt.price) {
      priceEl.classList.remove('flash-up', 'flash-down');
      void priceEl.offsetWidth; // restart the animation
      priceEl.classList.add(qt.price > old ? 'flash-up' : 'flash-down');
    }
  }
  const chEl = $('#hdrChange');
  if (chEl && isNum(qt.changePct)) {
    chEl.className = `num ${cls(qt.changePct)}`;
    chEl.textContent = `${fmtNum(qt.change)} (${fmtPct(qt.changePct)}) today`;
  }
  const stEl = $('#hdrState');
  if (stEl) {
    stEl.className = `pill ${qt.marketState === 'open' ? 'open' : 'closed'}`;
    stEl.textContent = qt.marketState === 'open' ? '● Market open' : 'Market closed';
  }
  const asOf = $('#hdrAsOf');
  if (asOf && qt.marketTime) asOf.textContent = ` · as of ${new Date(qt.marketTime).toLocaleString()}`;
  live.open = qt.marketState === 'open';
  document.title = `${q.symbol} ${fmtNum(qt.price)} — StockSense`;
}

// Load candles for the selected timeframe, draw the chart and start live updates.
async function mountChart(data, alive) {
  stopLive();
  destroyCharts();
  live.handle = null;
  const body = $('.chart-body');
  if (!body) return;
  const iv = state.chartInterval;
  const gen = live.gen;
  const sym = data.quote.symbol;
  const current = () => alive() && gen === live.gen && state.chartInterval === iv;
  const rangeBtns = $('#rangeBtns');
  if (rangeBtns) rangeBtns.hidden = iv !== '1d';
  live.interval = iv;
  live.errors = 0;
  live.open = data.quote.marketState === 'open';

  let candles;
  if (iv === '1d') {
    candles = data.candles.map((c) => ({ ...c }));
    body.innerHTML = chartBodyHtml();
  } else {
    body.innerHTML = `<div class="chart-fallback"><span><span class="spinner"></span> Loading ${esc(iv)} candles…</span></div>`;
    try {
      const r = await api(`/api/candles?symbol=${enc(sym)}&interval=${iv}`, { timeout: 30000 });
      if (!current()) return;
      candles = r.candles;
      applyLiveQuote(r.quote, data);
    } catch (e) {
      if (!current()) return;
      body.innerHTML = errorBox(e.message, 'ivRetry');
      $('#ivRetry')?.addEventListener('click', () => mountChart(data, alive));
      setLiveBadge();
      return;
    }
    body.innerHTML = chartBodyHtml();
  }
  if (!candles?.length) {
    body.innerHTML = '<div class="chart-fallback">No candles for this timeframe yet. Try another timeframe.</div>';
    return;
  }
  live.handle = buildCharts(data, candles, iv);
  setLiveBadge();
  scheduleLive(data, alive);
}

function scheduleLive(data, alive) {
  clearTimeout(live.timer);
  live.timer = null;
  setLiveBadge();
  if (!alive() || live.paused || !live.handle) return;
  const gen = live.gen;
  const iv = live.interval;
  // Fast while the market is open; a slow heartbeat when closed so the chart
  // wakes up by itself at the opening bell.
  const base = live.open ? (iv === '1d' || iv === '1h' ? 10000 : 5000) : 60000;
  const delay = live.errors ? Math.min(60000, base * 2 ** Math.min(live.errors, 3)) : base;
  live.timer = setTimeout(async () => {
    const current = () => alive() && gen === live.gen && live.handle;
    if (!current()) return;
    if (document.hidden) return scheduleLive(data, alive); // don't poll in a background tab
    try {
      const r = await api(`/api/candles?symbol=${enc(data.quote.symbol)}&interval=${iv}&live=1`, { timeout: 15000 });
      if (!current()) return;
      live.handle.update(r.candles);
      applyLiveQuote(r.quote, data);
      live.errors = 0;
    } catch {
      if (!current()) return;
      live.errors++;
    }
    scheduleLive(data, alive);
  }, delay);
}

// Wire up the chart toolbar once per page; handlers always act on the current chart.
function bindChartToolbar(data, alive) {
  $$('#ivBtns button').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.iv === state.chartInterval) return;
      state.chartInterval = b.dataset.iv;
      store.set('ss.interval', state.chartInterval);
      $$('#ivBtns button').forEach((x) => x.classList.toggle('active', x === b));
      mountChart(data, alive);
    })
  );
  $('#livePause')?.addEventListener('click', (e) => {
    live.paused = !live.paused;
    e.currentTarget.textContent = live.paused ? '▶ Resume' : '❚❚ Pause';
    scheduleLive(data, alive);
  });
  $$('#rangeBtns button').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#rangeBtns button').forEach((x) => x.classList.toggle('active', x === b));
      live.handle?.setRange(Number(b.dataset.bars));
    })
  );
  $$('.toggles input').forEach((inp) => inp.addEventListener('change', () => live.handle?.toggle(inp.dataset.t, inp.checked)));
}

// Rebuild the chart in place (used when the colour theme changes).
function rebuildChart() {
  const body = $('.chart-body');
  if (!body || !live.handle || !state.lastAnalysis) return;
  const candles = live.handle.candles();
  destroyCharts();
  body.innerHTML = chartBodyHtml();
  live.handle = buildCharts(state.lastAnalysis, candles, live.interval);
}

function buildCharts(data, candlesIn, iv) {
  const L = window.LightweightCharts;
  const body = $('.chart-body');
  if (!body) return null;
  if (!L) {
    body.innerHTML = '<div class="chart-fallback">The chart library could not be loaded (it needs an internet connection to unpkg.com).<br>All the analysis on this page still works.</div>';
    return null;
  }
  const intraday = iv !== '1d';
  const candles = candlesIn.slice();
  let s = clientSeries(candles);
  const a = data.analysis;
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();
  const up = col('--up'), down = col('--down');
  const base = {
    autoSize: true,
    layout: { background: { type: L.ColorType.Solid, color: col('--surface') }, textColor: col('--muted'), fontSize: 11 },
    grid: { vertLines: { color: col('--surface-2') }, horzLines: { color: col('--surface-2') } },
    rightPriceScale: { borderColor: col('--border'), minimumWidth: 76 },
    timeScale: { borderColor: col('--border'), rightOffset: 4, timeVisible: intraday, secondsVisible: false },
    crosshair: { mode: L.CrosshairMode.Normal },
    handleScale: { axisPressedMouseMove: true },
  };
  const P = (v) => fmtPrice(v, data.quote.currency, data.quote.symbol);
  const isOn = (t, fallback) => $(`.toggles input[data-t="${t}"]`)?.checked ?? fallback;

  // Point builders (index -> chart data point). Whitespace points ({time})
  // keep every series aligned bar-for-bar so the three panes stay in sync.
  const ohlcAt = (i) => { const c = candles[i]; return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }; };
  const volAt = (i) => { const c = candles[i]; return { time: c.time, value: c.volume, color: hexAlpha(c.close >= c.open ? up : down, 0.35) }; };
  const valAt = (key) => (i) => (isNum(s[key][i]) ? { time: candles[i].time, value: s[key][i] } : { time: candles[i].time });
  const histAt = (i) => (isNum(s.macdHist[i]) ? { time: candles[i].time, value: s.macdHist[i], color: hexAlpha(s.macdHist[i] >= 0 ? up : down, 0.6) } : { time: candles[i].time });
  const all = (fn) => candles.map((_, i) => fn(i));

  // Every series is registered with its point builder so live updates can
  // refresh them all the same way.
  const feeds = [];
  const overlay = {};
  const feed = (ser, fn, key) => {
    ser.setData(all(fn));
    feeds.push({ ser, fn });
    if (key) overlay[key] = [...(overlay[key] || []), ser];
    return ser;
  };
  const lineOpts = (color, extra) => ({ color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra });

  // --- main pane: candles, volume, averages
  const main = L.createChart($('#chartMain'), base);
  state.charts.push(main);
  const candle = feed(main.addCandlestickSeries({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false }), ohlcAt);
  candle.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.22 } });
  const volume = main.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  main.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  feed(volume, volAt);

  feed(main.addLineSeries(lineOpts('#e0a100', { lineWidth: 1, visible: isOn('sma20', true) })), valAt('sma20'), 'sma20');
  feed(main.addLineSeries(lineOpts('#2c7be5', { visible: isOn('sma50', true) })), valAt('sma50'), 'sma50');
  feed(main.addLineSeries(lineOpts('#9b51e0', { visible: isOn('sma200', true) })), valAt('sma200'), 'sma200');
  const bbOpts = lineOpts('#8a96a3', { lineWidth: 1, lineStyle: L.LineStyle.Dotted, visible: isOn('bb', false) });
  feed(main.addLineSeries(bbOpts), valAt('bbUpper'), 'bb');
  feed(main.addLineSeries(bbOpts), valAt('bbLower'), 'bb');

  // --- price-line groups (support/resistance and the trade plan)
  const groups = { levels: [], plan: [] };
  const defs = { levels: [], plan: [] };
  if (a && !a.insufficient) {
    a.levels.supports.forEach((v, i) => defs.levels.push({ price: v, color: hexAlpha(up, 0.8), title: `Support ${i + 1}`, lineStyle: L.LineStyle.Dashed }));
    a.levels.resistances.forEach((v, i) => defs.levels.push({ price: v, color: hexAlpha(down, 0.8), title: `Resistance ${i + 1}`, lineStyle: L.LineStyle.Dashed }));
    const p = a.plan;
    if (p.action !== 'avoid') {
      if (isNum(p.entryHigh) && isNum(p.entryLow)) defs.plan.push({ price: (p.entryLow + p.entryHigh) / 2, color: col('--info'), title: 'Entry', lineStyle: L.LineStyle.Solid });
      if (isNum(p.target1)) defs.plan.push({ price: p.target1, color: up, title: 'Target 1', lineStyle: L.LineStyle.Solid });
      if (isNum(p.target2)) defs.plan.push({ price: p.target2, color: up, title: 'Target 2', lineStyle: L.LineStyle.Solid });
    }
    if (isNum(p.stopLoss)) defs.plan.push({ price: p.stopLoss, color: down, title: p.action === 'avoid' ? 'Exit level' : 'Stop-loss', lineStyle: L.LineStyle.Solid });
  }
  const showGroup = (g, on) => {
    groups[g].forEach((pl) => candle.removePriceLine(pl));
    groups[g] = on ? defs[g].filter((d) => isNum(d.price)).map((d) => candle.createPriceLine({ ...d, lineWidth: 1, axisLabelVisible: true })) : [];
  };
  showGroup('levels', isOn('levels', true));
  showGroup('plan', isOn('plan', true));

  // --- RSI pane
  const rsiChart = L.createChart($('#chartRsi'), { ...base, timeScale: { ...base.timeScale, visible: false } });
  state.charts.push(rsiChart);
  const rsiSer = feed(rsiChart.addLineSeries(lineOpts(col('--info'), { lastValueVisible: true, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) })), valAt('rsi'));
  rsiSer.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });
  rsiSer.createPriceLine({ price: 70, color: hexAlpha(down, 0.7), lineWidth: 1, lineStyle: L.LineStyle.Dashed, axisLabelVisible: false, title: '' });
  rsiSer.createPriceLine({ price: 30, color: hexAlpha(up, 0.7), lineWidth: 1, lineStyle: L.LineStyle.Dashed, axisLabelVisible: false, title: '' });

  // --- MACD pane
  const macdChart = L.createChart($('#chartMacd'), base);
  state.charts.push(macdChart);
  feed(macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false }), histAt);
  feed(macdChart.addLineSeries(lineOpts(col('--info'), { lineWidth: 1 })), valAt('macd'));
  feed(macdChart.addLineSeries(lineOpts('#e0a100', { lineWidth: 1 })), valAt('macdSignal'));

  // --- keep the three panes scrolled / zoomed together
  const charts = [main, rsiChart, macdChart];
  let syncing = false;
  charts.forEach((c) =>
    c.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (syncing || !r) return;
      syncing = true;
      charts.forEach((o) => o !== c && o.timeScale().setVisibleLogicalRange(r));
      syncing = false;
    })
  );
  const setRange = (bars) => {
    const n = candles.length;
    main.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - bars) - 0.5, to: n + 3 });
  };
  if (intraday) setRange(150);
  else setRange(Number($('#rangeBtns button.active')?.dataset.bars) || 126);

  // --- OHLC readout under the cursor (defaults to the latest candle)
  const ohlc = $('#ohlc');
  const timeLabel = (t) => (typeof t === 'number' ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') : String(t));
  const byTime = new Map(candles.map((c) => [c.time, c]));
  let hovering = false;
  const show = (c) => {
    if (!c || !ohlc) return;
    const ch = c.open ? ((c.close - c.open) / c.open) * 100 : null;
    ohlc.innerHTML = `${esc(timeLabel(c.time))} · Open ${P(c.open)} · High ${P(c.high)} · Low ${P(c.low)} · Close <b>${P(c.close)}</b> <span class="${cls(ch)}">${fmtPct(ch)}</span>${c.volume ? ` · Vol ${fmtCompact(c.volume)}` : ''}`;
  };
  const lastCandle = () => candles[candles.length - 1];
  show(lastCandle());
  main.subscribeCrosshairMove((param) => {
    hovering = Boolean(param.time);
    if (!param.time) return show(lastCandle());
    const t = param.time;
    const key = typeof t === 'object' ? `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}` : t;
    show(byTime.get(key) || lastCandle());
  });

  // --- live updates: merge fresh candles and redraw only what changed
  const update = (fresh) => {
    if (!Array.isArray(fresh) || !fresh.length) return;
    const lastTime = lastCandle().time;
    let from = candles.length;
    for (const b of fresh) {
      if (typeof b.time !== typeof lastTime || b.time < lastTime) continue; // finished candles never change
      if (![b.open, b.high, b.low, b.close].every(isNum)) continue;
      if (b.time === lastCandle().time) {
        candles[candles.length - 1] = b;
        from = Math.min(from, candles.length - 1);
      } else if (b.time > lastCandle().time) {
        candles.push(b);
        from = Math.min(from, candles.length - 1);
      }
      byTime.set(b.time, b);
    }
    if (from >= candles.length) return;
    s = clientSeries(candles);
    for (let i = from; i < candles.length; i++) for (const f of feeds) f.ser.update(f.fn(i));
    if (!hovering) show(lastCandle());
  };

  return {
    update,
    setRange,
    candles: () => candles.slice(),
    toggle(t, on) {
      if (groups[t]) showGroup(t, on);
      else (overlay[t] || []).forEach((ser) => ser.applyOptions({ visible: on }));
    },
  };
}

// ---------- top picks ----------
async function viewPicks(_, alive) {
  view.innerHTML = `
    <div class="section-head">
      <h2>Top picks — ${marketLabel()} large caps</h2>
      <div class="small muted"><span id="pUpdated"></span> <button class="btn small" id="pRefresh">↻ Refresh</button></div>
    </div>
    <div class="card">
      <div class="section-head" style="margin-bottom:0">
        <div class="filters" id="pMode">
          <button data-m="short" class="${state.picksMode === 'short' ? 'active' : ''}">📈 Short-term setups (weeks)</button>
          <button data-m="long" class="${state.picksMode === 'long' ? 'active' : ''}">🌱 Long-term trend (months+)</button>
        </div>
        <div class="filters" id="pFilter">
          ${[['all', 'All'], ['strong', '⭐ Strong Buy'], ['buy', 'Buy signals'], ['hold', 'Hold'], ['avoid', 'Avoid']].map(([k, l]) => `<button data-f="${k}" class="${state.picksFilter === k ? 'active' : ''}">${l}</button>`).join('')}
        </div>
      </div>
      <p class="small muted" id="pExplain"></p>
      <div id="pTable">${loading('Scanning stocks… this can take up to 20 seconds the first time.')}</div>
    </div>
    <p class="small muted">Rankings use only price trends and momentum — they don't know about company profits, debt or valuation. Use them as a starting point for your own research, and diversify across several stocks and sectors.</p>`;

  const render = () => {
    if (!scanCache || scanCache.market !== state.market) return;
    const explain = state.picksMode === 'short'
      ? 'Ranked by the signal score: trend, momentum (RSI/MACD), volume and recent performance. Good for swing trades lasting a few weeks.'
      : 'Ranked by long-term trend strength: price above its 200-day average, 1-year performance and steadiness (lower volatility ranks higher). Better for investors who hold for months.';
    $('#pExplain').textContent = explain;
    let items = scanCache.items.filter((i) => !i.insufficient);
    const f = state.picksFilter;
    if (f === 'strong') items = items.filter((i) => i.verdict.key === 'strong_buy');
    if (f === 'buy') items = items.filter((i) => ['buy', 'strong_buy'].includes(i.verdict.key));
    if (f === 'hold') items = items.filter((i) => i.verdict.key === 'hold');
    if (f === 'avoid') items = items.filter((i) => ['sell', 'strong_sell'].includes(i.verdict.key));
    const key = state.picksMode === 'short' ? 'score' : 'longTermScore';
    items.sort((a, b) => b[key] - a[key]);
    const failed = scanCache.failed?.length ? `<p class="small muted">Could not load: ${scanCache.failed.map((x) => esc(x.symbol)).join(', ')}</p>` : '';
    if (!items.length) {
      $('#pTable').innerHTML = `<div class="empty">${f === 'strong' ? 'No stock is rated Strong Buy right now — it needs a score of +50 or more, so it is rare. Try “Buy signals”, or open the <a href="#/intraday">Intraday</a> tab.' : 'No stocks match this filter right now.'}</div>${failed}`;
      return;
    }
    $('#pTable').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Stock</th><th class="r">Price</th><th class="r">Today</th><th>Signal</th><th class="r">${state.picksMode === 'short' ? 'Score' : 'Trend score'}</th><th class="r">RSI</th><th class="r">1M</th><th class="r">1Y</th><th class="r">Stop-loss</th><th class="r">Target</th><th>30 days</th></tr></thead>
      <tbody>${items.map((s, i) => `<tr data-sym="${esc(s.symbol)}">
        <td class="muted">${i + 1}</td>
        <td><b>${esc(s.name)}</b><div class="small muted">${esc(s.symbol)}</div></td>
        <td class="r num">${fmtPrice(s.price, s.currency, s.symbol)}</td>
        <td class="r num ${cls(s.changePct)}">${fmtPct(s.changePct)}</td>
        <td>${verdictPill(s.verdict)}</td>
        <td class="r num"><b>${s[key] > 0 ? '+' : ''}${s[key]}</b></td>
        <td class="r num">${fmtNum(s.rsi, 0)}</td>
        <td class="r num ${cls(s.ret1m)}">${fmtPct(s.ret1m, 1)}</td>
        <td class="r num ${cls(s.ret1y)}">${fmtPct(s.ret1y, 1)}</td>
        <td class="r num">${fmtPrice(s.plan?.stopLoss, s.currency, s.symbol)}</td>
        <td class="r num">${s.plan?.action !== 'avoid' ? fmtPrice(s.plan?.target1, s.currency, s.symbol) : '—'}</td>
        <td>${spark(s.spark, 90, 28)}</td>
      </tr>`).join('')}</tbody></table></div>${failed}`;
    $$('tr[data-sym]', view).forEach((tr) => tr.addEventListener('click', () => goAnalyze(tr.dataset.sym)));
  };

  $$('#pMode button').forEach((b) => b.addEventListener('click', () => {
    state.picksMode = b.dataset.m;
    $$('#pMode button').forEach((x) => x.classList.toggle('active', x === b));
    render();
  }));
  $$('#pFilter button').forEach((b) => b.addEventListener('click', () => {
    state.picksFilter = b.dataset.f;
    $$('#pFilter button').forEach((x) => x.classList.toggle('active', x === b));
    render();
  }));

  const load = async () => {
    try {
      const data = await api(`/api/scan?market=${state.market}`, { signal: newController().signal, timeout: 90000 });
      if (!alive()) return;
      scanCache = data;
      $('#pUpdated').textContent = `Updated ${new Date(data.updated).toLocaleTimeString()} · ${data.items.length}/${data.total} stocks`;
      render();
    } catch (e) {
      if (!alive() || e.name === 'AbortError') return;
      $('#pTable').innerHTML = errorBox(e.message, 'pRetry');
      $('#pRetry')?.addEventListener('click', load);
    }
  };
  $('#pRefresh').addEventListener('click', load);
  if (scanCache && scanCache.market === state.market) render();
  await load();
}

// ---------- watchlist ----------
async function viewWatchlist(_, alive) {
  if (!state.watch.length) {
    view.innerHTML = `<div class="card hero-empty"><h2>Your watchlist is empty</h2>
      <p class="muted">Search for a stock and press <b>☆ Add to watchlist</b> to track it here.</p></div>`;
    return;
  }
  view.innerHTML = `<div class="section-head"><h2>Watchlist</h2><button class="btn small" id="wRefresh">↻ Refresh</button></div>
    <div id="wList" class="grid cols-3">${state.watch.map(() => `<div class="card">${skel(110)}</div>`).join('')}</div>`;
  const load = async () => {
    try {
      const data = await api(`/api/summary?symbols=${enc(state.watch.join(','))}`, { signal: newController().signal, timeout: 90000 });
      if (!alive()) return;
      const bySym = new Map(data.items.map((i) => [i.symbol, i]));
      const failed = new Map(data.failed.map((f) => [f.symbol, f.error]));
      $('#wList').innerHTML = state.watch.map((sym) => {
        const s = bySym.get(sym);
        if (!s) return `<div class="card"><b>${esc(sym)}</b><div class="small down">${esc(failed.get(sym) || 'Unavailable')}</div><button class="btn small" data-rm="${esc(sym)}" style="margin-top:8px">Remove</button></div>`;
        return `<div class="card click" data-sym="${esc(sym)}">
          <div class="row" style="display:flex;justify-content:space-between;gap:8px"><div style="min-width:0"><b>${esc(s.name)}</b><div class="small muted">${esc(sym)}</div></div>${verdictPill(s.verdict)}</div>
          <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:8px">
            <div><div class="num" style="font-size:20px;font-weight:700">${fmtPrice(s.price, s.currency, sym)}</div><div class="num small ${cls(s.changePct)}">${fmtPct(s.changePct)} today</div></div>
            ${spark(s.spark)}
          </div>
          <div class="small muted" style="margin-top:6px">RSI ${fmtNum(s.rsi, 0)} · 1M ${fmtPct(s.ret1m, 1)} · Stop ${fmtPrice(s.plan?.stopLoss, s.currency, sym)}</div>
          <button class="btn small" data-rm="${esc(sym)}" style="margin-top:8px">Remove</button>
        </div>`;
      }).join('');
      $$('[data-rm]', view).forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        state.watch = state.watch.filter((x) => x !== b.dataset.rm);
        store.set('ss.watch', state.watch);
        route();
      }));
      $$('.card[data-sym]', view).forEach((c) => c.addEventListener('click', () => goAnalyze(c.dataset.sym)));
    } catch (e) {
      if (!alive() || e.name === 'AbortError') return;
      $('#wList').innerHTML = `<div class="card" style="grid-column:1/-1">${errorBox(e.message, 'wRetry')}</div>`;
      $('#wRetry')?.addEventListener('click', load);
    }
  };
  $('#wRefresh').addEventListener('click', load);
  await load();
}

// ---------- learn ----------
function viewLearn() {
  const terms = [
    ['Stock / Share', 'A small piece of ownership in a company. If the company grows and earns more, the share price usually rises over time.'],
    ['Index (NIFTY, SENSEX, S&P 500)', 'A basket of top companies that shows how the overall market is doing. If the index is up, most big stocks are up.'],
    ['Candlestick', 'Each candle shows one day: the body is from open to close price, the thin lines (wicks) show the day\'s high and low. Green = closed higher than it opened, red = closed lower.'],
    ['Support', 'A price level where the stock has stopped falling before — buyers tend to step in there. Like a floor.'],
    ['Resistance', 'A price level where the stock has stopped rising before — sellers tend to appear. Like a ceiling. A break above it is often bullish.'],
    ['Moving average (20 / 50 / 200-day)', 'The average closing price over the last N days. Price above the line = uptrend; below = downtrend. The 200-day is the long-term trend.'],
    ['Golden cross / Death cross', 'When the 50-day average crosses above the 200-day it\'s called a golden cross (bullish). Crossing below is a death cross (bearish).'],
    ['RSI (Relative Strength Index)', 'Measures speed of price moves from 0 to 100. Above 70 = "overbought" (rose too fast), below 30 = "oversold" (fell too fast).'],
    ['MACD', 'A momentum indicator. When the MACD line crosses above its signal line, momentum is turning up; crossing below means it is turning down.'],
    ['Bollinger Bands', 'A band around the 20-day average showing the normal price range. Price outside the bands is "stretched" and often returns inside.'],
    ['Volume', 'How many shares traded. Big moves on high volume are more trustworthy than moves on low volume.'],
    ['Stop-loss', 'A price where you sell to cap your loss if the trade goes wrong. ALWAYS decide this before you buy.'],
    ['Target', 'A price where you plan to take profit. Many traders sell half at Target 1 and the rest at Target 2.'],
    ['Risk : Reward', 'How much you could gain versus lose. 1 : 2 means you risk ₹1 / $1 to make ₹2 / $2. Aim for at least 1 : 2.'],
    ['Volatility', 'How much a stock swings. High-volatility stocks can rise fast but also fall fast — use smaller positions.'],
    ['Diversification', 'Spreading money across many stocks and sectors so one bad company can\'t hurt you badly.'],
  ];
  view.innerHTML = `
    <a class="card click ac-banner" href="#/academy"><div><h2>🎓 New: Stock Market Academy</h2><p class="muted" style="margin:4px 0 0">A full step-by-step course from beginner to advanced, in English and മലയാളം — charts, buying and selling, entry, exit, stop-loss and risk control.</p></div><span class="btn primary">Open the course →</span></a>
    <div class="section-head section"><h2>Learn the basics</h2></div>
    <div class="card">
      <h3>10 golden rules for beginners</h3>
      <ol class="rules">
        <li>Only invest money you won't need for the next few years.</li>
        <li>Start small. Learn with a small amount before investing more.</li>
        <li>Always use a stop-loss — decide your exit before you enter.</li>
        <li>Never risk more than 1–2% of your total capital on a single trade.</li>
        <li>Prefer large, well-known companies (like the ones in "Top Picks").</li>
        <li>Trade with the trend: buying stocks above their 200-day average is usually safer.</li>
        <li>Don't chase a stock that already jumped a lot (RSI above 70).</li>
        <li>Diversify — hold 8–15 stocks from different sectors, or consider index funds.</li>
        <li>Don't trade on tips, rumours or emotions. Follow your plan.</li>
        <li>Keep a journal of every trade — why you entered, why you exited, what you learned.</li>
      </ol>
    </div>
    <div class="section-head section"><h2>How to use StockSense</h2></div>
    <div class="grid cols-3">
      <div class="card learn"><h3>1. Check the market mood</h3><p>On the Dashboard, see if the overall market is Bullish, Neutral or Bearish. Buying is easier when the whole market is rising.</p></div>
      <div class="card learn"><h3>2. Find candidates</h3><p>Open Top Picks. Short-term setups are for trades lasting weeks; Long-term trend is for holding months or longer.</p></div>
      <div class="card learn"><h3>3. Analyse & plan</h3><p>Open a stock, read "What the chart is telling you", note the entry zone, stop-loss and targets, then use the calculator to size your position.</p></div>
    </div>
    <div class="section-head section"><h2>Glossary</h2></div>
    <div class="grid cols-3">${terms.map(([t, d]) => `<div class="card learn"><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('')}</div>
    <div class="card section disclaimer" style="width:100%;margin-left:0">
      <b>How signals are made:</b> StockSense combines 10 common technical indicators (moving averages, RSI, MACD, Bollinger Bands, volume, momentum and candle patterns) into a score from −100 to +100.
      Entry, stop-loss and targets come from recent support/resistance and the stock's average daily move (ATR). This is a rules-based guide, not a prediction — markets can and do move against any signal.
    </div>`;
}

// ---------- search ----------
function initSearch() {
  const input = $('#searchInput');
  const list = $('#searchList');
  const box = $('#searchBox');
  let results = [];
  let active = -1;
  let timer;
  let ctrl;
  let lastQuery = '';

  const close = () => {
    list.hidden = true;
    box.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  const renderList = () => {
    if (!results.length) {
      list.innerHTML = `<li class="muted" aria-disabled="true">No matches. Press Enter to try "${esc(input.value.trim().toUpperCase())}" as a symbol.</li>`;
    } else {
      list.innerHTML = results.map((r, i) => `<li role="option" data-i="${i}" aria-selected="${i === active}">
        <span><span class="sym">${esc(r.symbol)}</span> <span class="muted">${esc(r.name)}</span></span>
        <span class="meta">${esc(r.exchange)} · ${esc(r.type)}</span></li>`).join('');
    }
    list.hidden = false;
    box.setAttribute('aria-expanded', 'true');
  };
  const pick = (sym) => {
    close();
    input.value = '';
    input.blur();
    goAnalyze(sym);
  };
  const doSearch = async (q) => {
    ctrl?.abort();
    ctrl = new AbortController();
    lastQuery = q;
    try {
      const data = await api(`/api/search?q=${enc(q)}`, { signal: ctrl.signal, timeout: 15000 });
      if (q !== lastQuery) return results;
      // Show the user's own market first.
      const mine = (r) => (state.market === 'IN' ? /\.(NS|BO)$/.test(r.symbol) : !r.symbol.includes('.'));
      results = [...data.quotes.filter(mine), ...data.quotes.filter((r) => !mine(r))];
      active = -1;
      if (document.activeElement === input) renderList();
    } catch (e) {
      if (e.name !== 'AbortError') {
        results = [];
        list.innerHTML = `<li class="muted" aria-disabled="true">${esc(e.message)}</li>`;
        list.hidden = false;
      }
    }
    return results;
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { results = []; close(); return; }
    timer = setTimeout(() => doSearch(q), 250);
  });
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      renderList();
    } else if (e.key === 'Escape') {
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      if (active >= 0 && results[active]) return pick(results[active].symbol);
      clearTimeout(timer);
      const r = q === lastQuery && results.length ? results : await doSearch(q);
      if (r.length) return pick(r[0].symbol);
      const raw = q.toUpperCase().replace(/\s+/g, '');
      if (/^[A-Z0-9.\-^=&]{1,25}$/.test(raw)) pick(raw);
      else toast('Please type a company name or a stock symbol.');
    }
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) {
      e.preventDefault();
      pick(results[Number(li.dataset.i)].symbol);
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('focus', () => { if (input.value.trim() && results.length) renderList(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
      e.preventDefault();
      input.focus();
    }
  });
}

// ---------- init ----------
function setMarket(m) {
  state.market = m;
  store.set('ss.market', m);
  $$('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.market === m));
}

function init() {
  // Optional link parameter, e.g. http://localhost:3000/?tf=5m#/analyze/TCS.NS
  const tf = new URLSearchParams(location.search).get('tf');
  if (TIMEFRAMES.some(([k]) => k === tf)) state.chartInterval = tf;
  setMarket(state.market);
  $$('.seg button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.market === state.market) return;
    setMarket(b.dataset.market);
    scanCache = null;
    indicesCache = null;
    const { tab, param } = parseHash();
    // An open stock page stays as-is; other pages reload for the new market.
    if (!(tab === 'analyze' && param)) route();
  }));

  $('#themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('ss.theme', next);
    // Charts read colours at build time, so rebuild them.
    rebuildChart();
  });

  if (!store.get('ss.disclaimerOk', false)) $('#disclaimer').hidden = false;
  $('#disclaimerOk').addEventListener('click', () => {
    $('#disclaimer').hidden = true;
    store.set('ss.disclaimerOk', true);
  });

  initSearch();
  initPaper({ api, esc, enc, isNum, cls, toast, store, state, view, newController, errorBox, loading, goAnalyze, verdictClass, popular: POPULAR });
  initIntraday({ api, esc, enc, isNum, cls, state, view, newController, errorBox, loading, goAnalyze, verdictClass, verdictPill, fmtPrice, fmtNum, fmtPct, marketLabel });
  window.addEventListener('hashchange', route);
  route();
}

init();

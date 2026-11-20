// StockSense — Intraday desk.
//   * "Best of the best" intraday BUY picks, shown on their own with a pass/fail checklist
//   * Strong Buy lists (daily chart and right-now on 5-minute candles)
//   * Every scenario (breakout, pullback, gap-up fade, ...) with filters
//   * The per-stock "Intraday view" card used on the Analyse page
// All analysis is computed on the server (lib/intraday.js); this file only draws it.
import { openOrder } from './paper.js';

let C = null; // helpers injected by app.js (avoids a circular import)
let board = null; // last /api/intraday response
let filter = 'all'; // 'all' | 'g:<group>' | 's:<scenario key>'

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function initIntraday(ctx) {
  C = ctx;
}

const GROUPS = {
  bull: { label: '🟢 Buy setups', pill: 'bull' },
  wait: { label: '🟡 Wait / watch', pill: 'warn' },
  bear: { label: '🔴 Avoid', pill: 'bear' },
};
const groupPill = (sc) => `<span class="pill ${GROUPS[sc.group]?.pill || 'neutral'}">${C.esc(sc.label)}</span>`;
const signed = (v) => (C.isNum(v) ? `${v > 0 ? '+' : ''}${v}` : '—');

function minsText(m) {
  if (!C.isNum(m)) return '';
  const h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} min` : `${m} min`;
}

function scorePill(i) {
  if (!i || i.insufficient) return '<span class="pill neutral">Too early</span>';
  const cls = C.verdictClass(i.verdict.key);
  return `<span class="pill ${cls}" title="Intraday score ${signed(i.score)} / 100">${C.esc(i.verdict.label)} <span class="num">${signed(i.score)}</span></span>`;
}

const orbCell = (orb) =>
  orb === 'above' ? '<span class="up">▲ Above</span>' : orb === 'below' ? '<span class="down">▼ Below</span>' : '<span class="muted">Inside</span>';

// ---------- page ----------
export async function viewIntraday(_, alive) {
  C.view.innerHTML = `
    <div class="section-head">
      <h2>⚡ Intraday desk — ${C.esc(C.marketLabel())} large caps</h2>
      <div class="small muted"><span id="iUpdated"></span> <button class="btn small" id="iRefresh">↻ Refresh</button></div>
    </div>
    <div id="iBanner"></div>
    <div id="iBody">${C.loading('Scanning every stock on 5-minute candles… this can take up to 20 seconds the first time.')}</div>
    <p class="small muted">Intraday trading is high-risk: prices move fast and most beginners lose money. Signals come from 5-minute charts and may be delayed ~15 minutes — always use the stop-loss and close every intraday trade before the market closes. Educational only, not advice.</p>`;

  const body = $('#iBody');
  body.addEventListener('click', (e) => {
    const buy = e.target.closest('[data-pt]');
    if (buy) {
      openOrder({ symbol: buy.dataset.pt, name: buy.dataset.name || '', side: 'BUY', product: 'INTRADAY' });
      return;
    }
    const chip = e.target.closest('[data-f]');
    if (chip) {
      filter = chip.dataset.f;
      renderScenarios();
      return;
    }
    if (e.target.closest('a')) return;
    const row = e.target.closest('[data-sym]');
    if (row) C.goAnalyze(row.dataset.sym);
  });

  const load = async () => {
    try {
      const data = await C.api(`/api/intraday?market=${C.state.market}`, { signal: C.newController().signal, timeout: 90000 });
      if (!alive()) return;
      board = data;
      if (!validFilter()) filter = 'all';
      render();
    } catch (e) {
      if (!alive() || e.name === 'AbortError') return;
      body.innerHTML = C.errorBox(e.message, 'iRetry');
      $('#iRetry')?.addEventListener('click', load);
    }
  };
  $('#iRefresh').addEventListener('click', load);
  // The market only moves while it is open, so a closed market is refreshed rarely.
  C.state.timers.push(setInterval(() => {
    if (document.hidden || !alive()) return;
    if (board && !board.marketOpen && Date.now() - board.updated < 5 * 60 * 1000) return;
    load();
  }, 60 * 1000));
  await load();
}

function validFilter() {
  if (filter === 'all') return true;
  if (filter.startsWith('g:')) return Boolean(GROUPS[filter.slice(2)]);
  return Boolean(board?.scenarios?.[filter.slice(2)]);
}

function render() {
  const d = board;
  $('#iUpdated').textContent = `Updated ${new Date(d.updated).toLocaleTimeString()} · ${d.items.length}/${d.total} stocks`;
  $('#iBanner').innerHTML = bannerHtml(d);
  $('#iBody').innerHTML = `
    <section class="section">${bestHtml(d)}</section>
    <section class="section">${strongHtml(d)}</section>
    <section class="section">
      <div class="section-head"><h2>🔍 Every scenario — all ${d.items.length} stocks</h2></div>
      <div class="card" id="iScn"></div>
    </section>
    ${legendHtml(d)}`;
  renderScenarios();
}

// ---------- banner: market status + direction ----------
function bannerHtml(d) {
  const open = d.marketOpen;
  const mb = d.marketBias;
  const status = open
    ? `<span class="pill open">● Market open</span> ${C.isNum(d.minutesLeft) ? `<span class="small muted">${C.esc(minsText(d.minutesLeft))} left in the session</span>` : ''}`
    : `<span class="pill closed">Market closed</span> <span class="small muted">Showing the last session${d.sessionDate ? ` (${C.esc(d.sessionDate)})` : ''}. Intraday signals expire fast — re-check after the next open before trading.</span>`;
  let dir = '';
  if (mb && mb.bias !== 'unknown') {
    const pill = mb.bias === 'bullish' ? 'bull' : mb.bias === 'bearish' ? 'bear' : 'warn';
    dir = `<div class="small" style="margin-top:6px"><b>Market direction — ${C.esc(mb.name)}:</b> <span class="pill ${pill}">${C.esc(mb.bias)}</span>
      <span class="num ${C.cls(mb.changePct)}">${C.isNum(mb.changePct) ? C.fmtPct(mb.changePct) : ''}</span> · ${C.esc(mb.text)}</div>`;
  } else {
    dir = `<div class="small muted" style="margin-top:6px">Market direction is not available right now, so that check is skipped.</div>`;
  }
  return `<div class="card idx-banner">${status}${dir}</div>`;
}

// ---------- best of the best ----------
function checklistHtml(checks) {
  return `<ul class="checks">${checks
    .map((c) => `<li class="${c.ok ? 'ok' : 'no'}"><span class="ck">${c.ok ? '✔' : '✖'}</span><span>${C.esc(c.label)} <span class="muted">— ${C.esc(c.detail)}</span></span></li>`)
    .join('')}</ul>`;
}

function bestCard(it, rank) {
  const i = it.intraday;
  const p = i.plan;
  const s = i.stats;
  const P = (v) => C.fmtPrice(v, it.currency, it.symbol);
  const top = rank === 1;
  return `<div class="card best ${top ? 'top' : ''}">
    <div class="best-head">
      <div>
        <span class="pill bull">${top ? '🏆 #1 Best of the best' : `#${rank} Also passes every check`}</span>
        <h3 style="margin-top:8px;font-size:${top ? 20 : 16}px">${C.esc(it.name)}</h3>
        <div class="small muted">${C.esc(it.symbol)} · ${groupPill(i.scenario)}</div>
      </div>
      <div style="text-align:right">
        <div class="price num">${P(it.price)}</div>
        <div class="num ${C.cls(s.dayChangePct)}" style="font-weight:700">${C.fmtPct(s.dayChangePct)} today</div>
      </div>
    </div>
    <p class="small" style="margin:8px 0 0">${C.esc(i.scenario.blurb)}</p>
    <div class="plan-grid four">
      <div class="plan-item entry"><div class="k">BUY ZONE</div><div class="v num">${P(p.entryLow)} – ${P(p.entryHigh)}</div></div>
      <div class="plan-item stop"><div class="k">STOP-LOSS</div><div class="v num">${P(p.stopLoss)}</div></div>
      <div class="plan-item target"><div class="k">TARGET 1</div><div class="v num">${P(p.target1)}</div></div>
      <div class="plan-item target"><div class="k">TARGET 2</div><div class="v num">${P(p.target2)}</div></div>
    </div>
    <div class="small muted">Risk : Reward <b>1 : ${C.isNum(p.riskReward) ? p.riskReward.toFixed(1) : '—'}</b> · risk ${C.fmtNum(p.riskPct, 2)}% per share · ${scorePill(i)} · daily: ${C.verdictPill(it.daily?.verdict)}</div>
    ${top ? `<div class="small" style="margin-top:10px"><b>All ${it.best.total} checks passed</b></div>${checklistHtml(it.best.checks)}` : `<details class="small" style="margin-top:8px"><summary>All ${it.best.total} checks passed</summary>${checklistHtml(it.best.checks)}</details>`}
    <div class="stock-actions" style="justify-content:flex-start;margin-top:12px">
      <button type="button" class="btn buy" data-pt="${C.esc(it.symbol)}" data-name="${C.esc(it.name)}" title="Practise with virtual money — no real order is placed">Paper Buy (Intraday)</button>
      <a class="btn" href="#/analyze/${C.enc(it.symbol)}">Open chart &amp; full analysis</a>
    </div>
  </div>`;
}

function nearMissRow(it) {
  const failed = it.best.checks.filter((c) => !c.ok);
  return `<div class="list-row miss-row" data-sym="${C.esc(it.symbol)}">
    <div>
      <div class="nm">${C.esc(it.name)}</div>
      <div class="sub">${C.esc(it.symbol)} · ${C.esc(it.intraday.scenario.label)} · ${it.best.passCount}/${it.best.total} checks passed</div>
      <div class="miss">${failed.map((c) => `<span class="pill bear" title="${C.esc(c.detail)}">✖ ${C.esc(c.label.split(' (')[0])}</span>`).join('')}</div>
    </div>
    <div class="num" style="text-align:right">${C.fmtPrice(it.price, it.currency, it.symbol)}</div>
    ${scorePill(it.intraday)}
  </div>`;
}

function bestHtml(d) {
  const head = `<div class="section-head"><h2>🏆 Best of the best — intraday BUY</h2>
    <span class="small muted">A stock must pass <b>every</b> check below. Shown separately from the lists that follow.</span></div>`;
  if (d.best.length) {
    const [first, ...rest] = d.best;
    return `${head}${bestCard(first, 1)}${rest.length ? `<div class="grid cols-2" style="margin-top:16px">${rest.map((it, k) => bestCard(it, k + 2)).join('')}</div>` : ''}`;
  }
  const reasons = d.marketBias?.bias === 'bearish'
    ? `The overall market is falling (${C.esc(d.marketBias.name)}), which blocks fresh buy trades.`
    : !d.marketOpen ? 'The market is closed, so this reflects the last session.' : 'No stock has a clean setup with enough volume, a strong trend and room to run.';
  return `${head}<div class="card">
    <h3>No stock passes every check right now</h3>
    <p class="small muted" style="margin:4px 0 0">${reasons} This filter is strict on purpose — on many days the right trade is <b>no trade</b>. Check again in 15–30 minutes.</p>
    ${d.nearMisses.length ? `<h3 style="margin-top:14px">Closest candidates (not ready — see what is missing)</h3><div class="list">${d.nearMisses.map(nearMissRow).join('')}</div>` : ''}
  </div>`;
}

// ---------- strong buy lists ----------
function strongRow(it, kind) {
  const i = it.intraday;
  const sub = kind === 'daily'
    ? `${C.esc(it.symbol)} · RSI ${C.fmtNum(it.daily.rsi, 0)} · 1M ${C.fmtPct(it.daily.ret1m, 1)}`
    : `${C.esc(it.symbol)} · ${C.esc(i.scenario.label)}`;
  const pill = kind === 'daily'
    ? `<span class="pill bull">${C.esc(it.daily.verdict.label)} <span class="num">${signed(it.daily.score)}</span></span>`
    : scorePill(i);
  return `<div class="list-row" data-sym="${C.esc(it.symbol)}">
    <div><div class="nm">${C.esc(it.name)}</div><div class="sub">${sub}</div></div>
    <div class="num" style="text-align:right">${C.fmtPrice(it.price, it.currency, it.symbol)}<div class="small ${C.cls(it.dayChangePct)}">${C.fmtPct(it.dayChangePct)}</div></div>
    ${pill}
  </div>`;
}

// First rows always visible, the rest folded away so long lists don't bury the page.
const SHOW_ROWS = 8;
function rowsHtml(items, kind) {
  const first = items.slice(0, SHOW_ROWS).map((it) => strongRow(it, kind)).join('');
  const more = items.slice(SHOW_ROWS);
  return `<div class="list">${first}</div>${more.length
    ? `<details class="small more"><summary>Show ${more.length} more</summary><div class="list">${more.map((it) => strongRow(it, kind)).join('')}</div></details>` : ''}`;
}

function strongHtml(d) {
  const daily = d.strongBuyDaily.length
    ? rowsHtml(d.strongBuyDaily, 'daily')
    : `<div class="empty" style="padding:14px 8px">No stock is rated <b>Strong Buy</b> on the daily chart right now (it needs a score of +50 or more — it is rare).</div>
       ${d.closestDaily.length ? `<div class="small muted" style="margin:4px 0">Closest — rated Buy:</div>${rowsHtml(d.closestDaily, 'daily')}` : ''}`;
  const intra = d.strongBuyIntraday.length
    ? rowsHtml(d.strongBuyIntraday, 'intra')
    : '<div class="empty" style="padding:14px 8px">No stock is a <b>Strong Buy</b> on the 5-minute chart right now.</div>';
  return `<div class="section-head"><h2>⭐ Strong Buy stocks</h2></div>
    <div class="grid cols-2">
      <div class="card"><h3>Daily chart <span class="small muted">— for swing trades (days to weeks)</span></h3>${daily}</div>
      <div class="card"><h3>Intraday, right now <span class="small muted">— for same-day trades</span></h3>${intra}</div>
    </div>`;
}

// ---------- scenarios ----------
function renderScenarios() {
  const box = $('#iScn');
  if (!box || !board) return;
  const d = board;
  const live = d.items.filter((it) => it.intraday && !it.intraday.insufficient);
  const early = d.items.filter((it) => !it.intraday || it.intraday.insufficient);
  const inGroup = (g) => live.filter((it) => it.intraday.scenario.group === g).length;
  const chip = (key, label, n, title = '') =>
    `<button type="button" data-f="${C.esc(key)}" class="${filter === key ? 'active' : ''}" title="${C.esc(title)}">${label} <span class="num">${n}</span></button>`;
  const scenarioChips = Object.entries(d.scenarios)
    .filter(([k]) => d.counts[k])
    .map(([k, sc]) => chip(`s:${k}`, C.esc(sc.label), d.counts[k], sc.blurb))
    .join('');

  let rows = live;
  let note = '';
  if (filter.startsWith('g:')) rows = live.filter((it) => it.intraday.scenario.group === filter.slice(2));
  else if (filter.startsWith('s:')) {
    rows = live.filter((it) => it.intraday.scenario.key === filter.slice(2));
    note = d.scenarios[filter.slice(2)]?.blurb || '';
  }
  rows = [...rows].sort((a, b) => b.intraday.score - a.intraday.score);

  box.innerHTML = `
    <div class="filters">
      ${chip('all', 'All', live.length)}
      ${Object.entries(GROUPS).map(([g, v]) => chip(`g:${g}`, v.label, inGroup(g))).join('')}
    </div>
    <div class="filters" style="margin-top:8px">${scenarioChips}</div>
    ${note ? `<p class="small muted" style="margin:10px 0 0">${C.esc(note)}</p>` : ''}
    <div style="margin-top:10px">${rows.length ? tableHtml(rows) : '<div class="empty">No stocks in this scenario right now.</div>'}</div>
    ${early.length ? `<p class="small muted">Not enough 5-minute data yet: ${early.map((x) => C.esc(x.symbol)).join(', ')}</p>` : ''}
    ${d.failed?.length ? `<p class="small muted">Could not load: ${d.failed.map((x) => C.esc(x.symbol)).join(', ')}</p>` : ''}`;
}

function tableHtml(rows) {
  const body = rows.map((it, n) => {
    const i = it.intraday;
    const s = i.stats;
    const p = i.plan;
    const buy = p.action === 'buy';
    const P = (v) => C.fmtPrice(v, it.currency, it.symbol);
    return `<tr data-sym="${C.esc(it.symbol)}">
      <td class="muted">${n + 1}</td>
      <td><b>${C.esc(it.name)}</b><div class="small muted">${C.esc(it.symbol)}</div></td>
      <td class="r num">${P(it.price)}</td>
      <td class="r num ${C.cls(s.dayChangePct)}">${C.fmtPct(s.dayChangePct)}</td>
      <td class="r num ${C.cls(s.gapPct)}">${C.fmtPct(s.gapPct)}</td>
      <td>${groupPill(i.scenario)}${it.best.passed ? ' <span title="Passes every best-of-the-best check">🏆</span>' : ''}</td>
      <td>${scorePill(i)}</td>
      <td class="r num ${C.cls(s.vsVwapPct)}">${C.fmtPct(s.vsVwapPct)}</td>
      <td>${orbCell(s.orb)}</td>
      <td class="r num">${C.isNum(s.rvol) ? `${s.rvol.toFixed(1)}×` : '—'}</td>
      <td class="r num">${C.fmtNum(s.rsi, 0)}</td>
      <td class="r num">${buy ? P(p.entry) : '—'}</td>
      <td class="r num">${buy ? P(p.stopLoss) : '—'}</td>
      <td class="r num">${buy ? P(p.target1) : '—'}</td>
      <td>${C.verdictPill(it.daily?.verdict)}</td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>#</th><th>Stock</th><th class="r">Price</th><th class="r">Today</th><th class="r" title="Opening price vs yesterday's close">Gap</th><th>Scenario</th><th>Intraday signal</th><th class="r" title="Price vs VWAP, the day's average price">vs VWAP</th><th title="First 15 minutes' high / low">Opening range</th><th class="r" title="Volume vs normal for this time of day">Rel. vol</th><th class="r">RSI</th><th class="r">Entry</th><th class="r">Stop-loss</th><th class="r">Target 1</th><th>Daily signal</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

// ---------- legend ----------
function legendHtml(d) {
  const byGroup = (g) => Object.values(d.scenarios).filter((s) => s.group === g);
  const block = (g) => `<div><h3>${GROUPS[g].label}</h3><dl class="pt-dl">${byGroup(g).map((s) => `<dt>${C.esc(s.label)} <span class="small muted">— ${C.esc(s.action)}</span></dt><dd>${C.esc(s.blurb)}</dd>`).join('')}</dl></div>`;
  return `<details class="card section legend">
    <summary><b>How it works — scenarios, score and the "best of the best" checks</b></summary>
    <div class="grid cols-3" style="margin-top:12px">${block('bull')}${block('wait')}${block('bear')}</div>
    <h3 style="margin-top:16px">How the intraday score is made</h3>
    <p class="small muted" style="margin:4px 0 0">Ten factors on 5-minute candles, weighted and added into a score from −100 to +100: price vs <b>VWAP</b> (the day's volume-weighted average price), the <b>opening-range</b> breakout (first 15 minutes), 9 vs 21 EMA, RSI, MACD, relative volume, change vs yesterday's close, yesterday's high/low, the last hour's high/low structure and position in today's range. +50 or more = Strong Buy.</p>
    <h3 style="margin-top:16px">What "best of the best" requires</h3>
    <p class="small muted" style="margin:4px 0 0">All of these at once: intraday Strong Buy · a proper buy scenario · above VWAP · 9 EMA above 21 EMA · volume at least 1.2× normal · RSI 50–75 · room to run before the next resistance · the daily chart is Buy or Strong Buy · the overall market is not falling · at least 45 minutes left in the session. Fail any one and the stock stays off the list.</p>
  </details>`;
}

// ---------- per-stock card (Analyse page) ----------
export async function loadIntradayCard(q, alive, signal) {
  const box = $('#aIntraday');
  if (!box) return;
  try {
    const d = await C.api(`/api/intraday-stock?symbol=${C.enc(q.symbol)}&market=${C.state.market}`, { signal, timeout: 30000 });
    if (!alive()) return;
    box.innerHTML = cardHtml(d, q);
  } catch (e) {
    if (!alive() || e.name === 'AbortError') return;
    box.innerHTML = `<h3>⚡ Intraday view</h3><div class="small muted">${C.esc(e.message)}</div>`;
  }
}

function cardHtml(d, q) {
  const i = d.intraday;
  const head = `<div class="section-head" style="margin-bottom:6px"><h3>⚡ Intraday view${i.sessionDate ? ` <span class="small muted">— session of ${C.esc(i.sessionDate)}</span>` : ''}</h3>
    <span class="pill ${d.marketState === 'open' ? 'open' : 'closed'}">${d.marketState === 'open' ? '● Market open' : 'Market closed'}</span></div>`;
  if (i.insufficient) return `${head}<div class="small muted">${C.esc(i.message)}</div>`;

  const s = i.stats;
  const p = i.plan;
  const lv = i.levels;
  const P = (v) => C.fmtPrice(v, q.currency, q.symbol);
  const row = (k, v, tip = '') => `<div><span${tip ? ` title="${C.esc(tip)}"` : ''}>${k}</span><span class="num">${v}</span></div>`;
  const best = d.best;
  const bestPill = best
    ? `<span class="pill ${best.passed ? 'bull' : best.passCount >= best.total - 2 ? 'warn' : 'neutral'}" title="Checks that make a stock 'best of the best'">${best.passed ? '🏆 ' : ''}${best.passCount}/${best.total} best-of-the-best checks</span>`
    : '';

  let plan;
  if (p.action === 'buy') {
    plan = `<div class="plan-grid">
      <div class="plan-item entry"><div class="k">BUY ZONE</div><div class="v num">${P(p.entryLow)} – ${P(p.entryHigh)}</div></div>
      <div class="plan-item stop"><div class="k">STOP-LOSS</div><div class="v num">${P(p.stopLoss)}</div></div>
      <div class="plan-item target"><div class="k">TARGET 1</div><div class="v num">${P(p.target1)}</div></div>
      <div class="plan-item target"><div class="k">TARGET 2</div><div class="v num">${P(p.target2)}</div></div></div>
      <div class="small muted">Risk : Reward <b>1 : ${p.riskReward.toFixed(1)}</b> · risk ${C.fmtNum(p.riskPct, 2)}% per share</div>`;
  } else {
    plan = `<h3 class="${p.action === 'avoid' ? 'down' : ''}" style="${p.action === 'wait' ? 'color:var(--warn)' : ''}">${C.esc(p.headline)}</h3>`;
  }

  return `${head}
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${groupPill(i.scenario)} ${scorePill(i)} ${bestPill}</div>
    <p class="small" style="margin:8px 0">${C.esc(i.scenario.blurb)}</p>
    <div class="grid cols-2" style="align-items:start">
      <div>${plan}<ul class="notes small">${p.notes.map((n) => `<li>${C.esc(n)}</li>`).join('')}</ul></div>
      <div class="stats" style="grid-template-columns:minmax(0,1fr)">
        ${row('VWAP', `${P(s.vwap)} (${C.fmtPct(s.vsVwapPct)})`, "The day's volume-weighted average price. Above it = buyers in control.")}
        ${row('Opening range (15 min)', `${P(s.orl)} – ${P(s.orh)} · ${orbCell(s.orb)}`, 'High and low of the first 15 minutes.')}
        ${row('Today / gap', `${C.fmtPct(s.dayChangePct)} / ${C.fmtPct(s.gapPct)}`, 'Change vs yesterday\'s close / opening gap.')}
        ${row('Day high / low', `${P(s.dayHigh)} / ${P(s.dayLow)}`)}
        ${row('9 / 21 EMA', `${P(s.ema9)} / ${P(s.ema21)}`, 'Short-term trend on 5-minute candles.')}
        ${row('RSI (5 min)', C.fmtNum(s.rsi, 0))}
        ${row('Relative volume', C.isNum(s.rvol) ? `${s.rvol.toFixed(1)}×` : '—', 'Volume so far vs normal for this time of day.')}
        ${lv ? row('Yesterday high / low', `${P(lv.prevHigh)} / ${P(lv.prevLow)}`) : ''}
        ${lv ? row('Pivot · R1 · S1', `${P(lv.pivot)} · ${P(lv.r1)} · ${P(lv.s1)}`, 'Classic floor-trader levels from yesterday.') : ''}
      </div>
    </div>
    <details class="small" style="margin-top:10px"><summary>Why this signal? (${i.factors.length} intraday factors)</summary>${i.factors.map((f) =>
      `<div class="factor"><div class="ic ${f.verdict}">${f.verdict === 'bullish' ? '↑' : f.verdict === 'bearish' ? '↓' : '•'}</div><div><div class="t">${C.esc(f.label)}</div><div class="d">${C.esc(f.text)}</div></div></div>`).join('')}</details>
    ${best ? `<details class="small" style="margin-top:6px"><summary>Best-of-the-best checklist (${best.passCount}/${best.total})</summary>${checklistHtml(best.checks)}</details>` : ''}
    <p class="small muted" style="margin:8px 0 0">Intraday signals change within minutes and are for same-day trades only. ${C.esc(i.verdict.summary)}</p>`;
}

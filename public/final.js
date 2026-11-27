// StockSense — "🎯 Final Picks" (intraday, short term, long term, each next to what testing says)
// and "🔎 Stock Check" (my stock fell — what now?). The analysis is done on the server; this file draws it.

let C = null; // helpers injected by app.js
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function initFinal(ctx) {
  C = ctx;
}

const TRUST = { good: 'bull', weak: 'warn', bad: 'bear', untested: 'neutral' };
const trustPill = (e) => `<span class="pill ${TRUST[e.level] || 'neutral'}">${C.esc(e.label)}</span>`;
const signed = (v, d = 0) => (C.isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d)}` : '—');

// ---------- how many shares ----------
// Risk a fixed slice of your money on each trade: shares = (money you accept to lose) / (entry - stop).
export function shareCount(capital, riskPct, entry, stop) {
  if (![capital, riskPct, entry, stop].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0) || stop >= entry) return 0;
  return Math.max(0, Math.min(Math.floor((capital * riskPct) / 100 / (entry - stop)), Math.floor(capital / entry)));
}

function sizeText(entry, stop, currency, symbol) {
  const qty = shareCount(C.state.capital, C.state.riskPct, entry, stop);
  const P = (v) => C.fmtPrice(v, currency, symbol);
  if (!qty) return `<span class="muted">Your risk limit is too small for even 1 share here (one share risks ${P(entry - stop)}).</span>`;
  return `At most <b>${qty.toLocaleString()}</b> share${qty === 1 ? '' : 's'} (${P(qty * entry)}) — if the stop is hit you lose about <b class="down">${P(qty * (entry - stop))}</b> before charges.`;
}

function riskSettingsHtml() {
  return `<div class="card risk-settings">
    <form class="calc" onsubmit="return false">
      <label>My trading money<input id="fCap" type="number" min="0" step="any" inputmode="decimal" value="${C.esc(C.state.capital)}"></label>
      <label>Most I will risk on one trade (%)<input id="fRisk" type="number" min="0.1" max="5" step="0.1" inputmode="decimal" value="${C.esc(C.state.riskPct)}"></label>
    </form>
    <p class="small muted" style="margin:8px 0 0">Share numbers below are worked out from these. Beginners: risk 0.5–1% per trade.</p>
  </div>`;
}
function bindRiskSettings(redraw) {
  const apply = () => {
    const cap = parseFloat($('#fCap')?.value);
    const risk = parseFloat($('#fRisk')?.value);
    if (C.isNum(cap) && cap > 0) C.store.set('ss.capital', (C.state.capital = cap));
    if (C.isNum(risk) && risk > 0 && risk <= 5) C.store.set('ss.riskPct', (C.state.riskPct = risk));
    redraw();
  };
  $('#fCap')?.addEventListener('input', apply);
  $('#fRisk')?.addEventListener('input', apply);
}

// ---------- news ----------
function newsChip(n) {
  if (!n || n.level === 'unavailable') return '<span class="pill neutral">News not available</span>';
  if (n.level === 'red') return '<span class="pill bear">⛔ Serious headlines</span>';
  if (n.level === 'amber') return '<span class="pill warn">📰 Negative headlines — read them</span>';
  if (n.level === 'none') return '<span class="pill neutral">No recent headlines found</span>';
  return `<span class="pill bull">No warning words in ${n.checked} headline${n.checked === 1 ? '' : 's'}</span>`;
}
function headlineList(items, tag = '') {
  return items.map((h) => `<a class="news-item" href="${C.esc(C.safeUrl(h.link))}" target="_blank" rel="noopener noreferrer">
    <div class="title">${tag}${C.esc(h.title)}</div>
    <div class="meta"><span>${C.esc(h.publisher)}</span>${h.time ? `<span>· ${C.esc(C.timeAgo(h.time))}</span>` : ''}</div></a>`).join('');
}
function newsBlock(n, { open = false } = {}) {
  if (!n || !n.headlines?.length) return '';
  const flagged = new Set([...n.serious, ...n.negative].map((h) => h.title));
  const events = n.events.length ? `<div class="small" style="margin-top:6px">📅 <b>Coming up / company events mentioned:</b> check dates before you buy — prices can jump either way.${headlineList(n.events)}</div>` : '';
  return `<details class="small news-block" ${open ? 'open' : ''}><summary>Read the headlines (${n.headlines.length})</summary>
    ${headlineList(n.serious, '⛔ ')}${headlineList(n.negative, '⚠ ')}${events}${headlineList(n.headlines.filter((h) => !flagged.has(h.title)).slice(0, 5))}
    <p class="muted">A keyword scan, not understanding: it can miss bad news. Also check the company's announcements on NSE / BSE.</p></details>`;
}

// ---------- pick cards ----------
const planItem = (cls, k, v) => `<div class="plan-item ${cls}"><div class="k">${k}</div><div class="v num">${v}</div></div>`;

function pickCard(it, horizon, rank) {
  const P = (v) => C.fmtPrice(v, it.currency, it.symbol);
  let plan;
  let entry;
  let stop;
  let why;
  if (horizon === 'intraday') {
    const p = it.intraday.plan;
    const s = it.intraday.stats;
    entry = p.entry;
    stop = p.stopLoss;
    plan = planItem('entry', 'BUY ZONE', `${P(p.entryLow)} – ${P(p.entryHigh)}`) + planItem('stop', 'STOP-LOSS', P(p.stopLoss))
      + planItem('', 'EXIT', 'By 3:15 PM') + planItem('target', 'OPTIONAL TARGET', P(p.target1));
    why = `${it.intraday.scenario.label} · passed ${it.best.passCount}/${it.best.total} checks · volume ${C.isNum(s.rvol) ? `${s.rvol.toFixed(1)}×` : '—'} · RSI ${C.fmtNum(s.rsi, 0)} · ${signed(s.dayChangePct, 2)}% today`;
  } else {
    const d = it.daily;
    const zone = C.isNum(d.entryLow) && C.isNum(d.entryHigh) ? `${P(d.entryLow)} – ${P(d.entryHigh)}` : 'On dips';
    entry = C.isNum(d.entryHigh) && d.action === 'buy' ? d.entryHigh : it.price;
    stop = d.stopLoss;
    plan = planItem('entry', d.action === 'wait' ? 'WAIT FOR A DIP TO' : 'BUY ZONE', zone)
      + planItem('stop', horizon === 'long' ? 'EXIT IF IT CLOSES BELOW' : 'STOP-LOSS', P(d.stopLoss))
      + (horizon === 'swing' ? planItem('target', 'TARGET', P(d.target1)) + planItem('', 'HOLD', 'Up to 4 weeks') : planItem('', '1-YEAR CHANGE', C.fmtPct(d.ret1y, 1)) + planItem('', 'TREND SCORE', signed(d.longTermScore)));
    why = `Daily: ${d.verdict.label} (${signed(d.score)}) · above its 200-day average · RSI ${C.fmtNum(d.rsi, 0)}${d.rsi >= 70 ? ' — stretched, buy in parts' : ''}`;
  }
  return `<div class="card pick">
    <div class="best-head">
      <div><span class="pick-rank">${rank}</span> <b>${C.esc(it.name)}</b><div class="small muted">${C.esc(it.symbol)}</div></div>
      <div style="text-align:right"><div class="num pick-price">${P(it.price)}</div><div class="small num ${C.cls(it.dayChangePct)}">${C.fmtPct(it.dayChangePct)}</div></div>
    </div>
    <div style="margin-top:6px">${newsChip(it.news)}</div>
    <div class="plan-grid">${plan}</div>
    <div class="small muted">${C.esc(why)}</div>
    ${C.isNum(stop) && stop < entry ? `<div class="small size-line" data-entry="${entry}" data-stop="${stop}" data-cur="${C.esc(it.currency)}" data-sym="${C.esc(it.symbol)}">${sizeText(entry, stop, it.currency, it.symbol)}</div>` : ''}
    ${newsBlock(it.news)}
    <div class="stock-actions" style="justify-content:flex-start">
      <a class="btn small" href="#/analyze/${C.enc(it.symbol)}">Chart</a>
      <a class="btn small" href="#/check/${C.enc(it.symbol)}">Stock check</a>
    </div>
  </div>`;
}

const INTRADAY_STATE = {
  closed: '⏸ The market is not open. Intraday picks appear between about <b>9:45 AM and 2:30 PM IST</b> on trading days. Come back then — do not use yesterday\'s intraday levels.',
  too_early: '⏳ The market has only just opened. Wait for the first 30 minutes of trading.',
  late: '⏰ Too late to start a new intraday trade today.',
  stale: '⚠ The intraday data is not from today\'s session yet.',
};

function section(title, sub, evidence, body, extra = '') {
  return `<section class="section">
    <div class="section-head"><h2>${title}</h2><span class="small muted">${sub}</span></div>
    <div class="evidence-note ${TRUST[evidence.level] || ''}">${trustPill(evidence)} <span class="small">${C.esc(evidence.text)}</span>${extra}</div>
    ${body}
  </section>`;
}
const cards = (list, horizon, empty) => (list.length
  ? `<div class="grid cols-3">${list.map((it, k) => pickCard(it, horizon, k + 1)).join('')}</div>`
  : `<div class="card"><p style="margin:0">${empty}</p></div>`);

function finalHtml(d) {
  const e = d.evidence;
  const mb = d.marketBias;
  const status = d.marketOpen
    ? `<span class="pill open">● Market open</span>${C.isNum(d.minutesLeft) ? ` <span class="small muted">${Math.floor(d.minutesLeft / 60)} h ${d.minutesLeft % 60} min left</span>` : ''}`
    : `<span class="pill closed">Market closed</span> <span class="small muted">Daily data up to ${C.esc(d.sessionDate || '—')}</span>`;
  const trustRow = (name, x) => `<div class="trust-row"><b>${name}</b>${trustPill(x)}<span class="small muted">${C.esc(x.text)}</span></div>`;
  return `
    <div class="card idx-banner">${status}${mb && mb.bias !== 'unknown' ? ` · <span class="small"><b>${C.esc(mb.name)}</b> <span class="num ${C.cls(mb.changePct)}">${C.fmtPct(mb.changePct)}</span> (${C.esc(mb.bias)})</span>` : ''}</div>
    <div class="card section honest">
      <h3>Read this first — how much can you trust these picks?</h3>
      <p class="small" style="margin:0 0 8px">We replayed the app's own rules on past prices. <b>None of them is proven.</b> Treat every pick as an idea to check, risk only a small amount, and practise on paper first.</p>
      ${trustRow('Intraday (passes every check)', e.intraday)}
      ${trustRow('Any plain intraday "buy" signal — no longer recommended', e.anyBuy)}
      ${trustRow('Short term', e.swing)}
      ${trustRow('Long term', e.long)}
      ${d.evidenceInfo ? `<details class="small" style="margin-top:8px"><summary>How this was tested, and its limits</summary><p>Each test only used data available at that moment, bought at the next candle, assumed the stop was hit first when unsure and took off trading costs. Tested on ${C.esc(new Date(d.evidenceInfo.generatedAt).toLocaleDateString())}.</p><ul class="notes">${d.evidenceInfo.caveats.map((c) => `<li>${C.esc(c)}</li>`).join('')}</ul></details>` : ''}
    </div>
    <div class="section">${riskSettingsHtml()}</div>
    ${section('⚡ Intraday', 'Same day · only stocks that pass every check', e.intraday,
    cards(d.intraday, 'intraday', d.state === 'live' ? 'No stock passes every check right now. <b>No trade</b> is the right call until one does — check again in 15–30 minutes.' : INTRADAY_STATE[d.state] || INTRADAY_STATE.stale))}
    ${section('📈 Short term', '1 to 4 weeks · strong daily charts that are not stretched', e.swing,
    cards(d.swing, 'swing', 'No strong daily setup that is not already stretched.'), '<span class="small"> <b>Ideas to research, not buy calls.</b></span>')}
    ${section('🌱 Long term', '6 months and more · strongest steady uptrends', e.long,
    cards(d.long, 'long', 'No large cap shows a strong, steady long-term uptrend right now.'), '<span class="small"> <b>For most long-term money, a broad index fund is the better-supported core;</b> use single stocks only for a small part, after checking the business.</span>')}
    ${d.heldBack.length ? `<section class="section"><div class="section-head"><h2>🚫 Held back — serious headlines</h2><span class="small muted">These would have qualified. Read why before touching them.</span></div>
      <div class="grid cols-2">${d.heldBack.map((h) => `<div class="card"><b>${C.esc(h.name)}</b> <span class="small muted">${C.esc(h.symbol)} · would have been: ${C.esc(h.horizons.join(', '))}</span>${headlineList(h.news.serious)}</div>`).join('')}</div></section>` : ''}
    ${checklistHtml()}`;
}

export async function viewFinal(_, alive) {
  C.view.innerHTML = `
    <div class="section-head"><h2>🎯 Final Picks — ${C.esc(C.marketLabel())} large caps</h2>
      <div class="small muted"><span id="fUpdated"></span> <button class="btn small" id="fRefresh">↻ Refresh</button></div></div>
    <div id="fBody">${C.loading('Checking charts, the market and the news for each candidate… up to 30 seconds the first time.')}</div>
    <p class="small muted">Not investment advice. Prices can be about 15 minutes late — confirm the live price with your broker before any order.</p>`;
  let data = null;
  // Only the share numbers depend on the money / risk boxes, so only those are rewritten while typing.
  const resize = () => $$('#fBody .size-line[data-entry]').forEach((el) => {
    el.innerHTML = sizeText(Number(el.dataset.entry), Number(el.dataset.stop), el.dataset.cur, el.dataset.sym);
  });
  const draw = () => {
    if (!data) return;
    const open = $$('#fBody details').map((x) => x.open);
    $('#fBody').innerHTML = finalHtml(data);
    $$('#fBody details').forEach((x, i) => { if (open[i]) x.open = true; });
    bindRiskSettings(resize);
  };
  const load = async () => {
    try {
      const d = await C.api(`/api/final?market=${C.state.market}`, { signal: C.newController().signal, timeout: 90000 });
      if (!alive()) return;
      data = d;
      $('#fUpdated').textContent = `Updated ${new Date(d.updated).toLocaleTimeString()} · ${d.scanned} stocks`;
      // Don't redraw under someone who is typing.
      if (!['fCap', 'fRisk'].includes(document.activeElement?.id)) draw();
    } catch (err) {
      if (!alive() || err.name === 'AbortError') return;
      $('#fBody').innerHTML = C.errorBox(err.message, 'fRetry');
      $('#fRetry')?.addEventListener('click', load);
    }
  };
  $('#fRefresh').addEventListener('click', load);
  C.state.timers.push(setInterval(() => { if (!document.hidden && alive() && data?.marketOpen) load(); }, 3 * 60 * 1000));
  await load();
}

// ---------- before you buy ----------
const CHECKLIST = [
  ['1. Market first', 'Is the NIFTY / SENSEX rising or falling today? Most stocks follow the market.'],
  ['2. The bigger trend', 'Price above its 200-day and 50-day averages is an uptrend. Below them, you are fighting the trend.'],
  ['3. WHY did it move?', 'Read the news and the company\'s announcements on NSE / BSE. Results, a downgrade, a legal case or a block deal change the picture completely.'],
  ['4. Volume', 'A big fall on heavy volume means many holders are leaving. A quiet dip is less serious.'],
  ['5. Support and resistance', 'Where did buyers step in before? A broken support often becomes the new ceiling.'],
  ['6. Don\'t chase', 'RSI above 70, or far above the average price, means you are late.'],
  ['7. The stop-loss, BEFORE you buy', 'Decide the price that proves you wrong. If you would not sell there, don\'t buy.'],
  ['8. Position size', 'Risk 0.5–1% of your money per trade. A wider stop means fewer shares, not more risk.'],
  ['9. The business (long term)', 'Sales and profit growth, debt, cash flow, P/E against similar companies, promoter holding and pledged shares. This app does NOT check these — see the company\'s results or a site such as screener.in.'],
  ['10. Dates', 'Results day, dividends and board meetings can move the price sharply overnight.'],
  ['11. Never average down blindly', 'Buying more of a falling stock only because it is cheaper makes one mistake bigger.'],
  ['12. Don\'t win it back today', 'After a big loss, the urge to recover quickly is the most expensive one. It is fine to do nothing.'],
];
function checklistHtml() {
  return `<details class="card section legend"><summary><b>📚 Before you buy — what to study (12 checks)</b></summary>
    <div class="grid cols-2" style="margin-top:12px">${CHECKLIST.map(([t, d]) => `<div class="learn"><h3>${C.esc(t)}</h3><p>${C.esc(d)}</p></div>`).join('')}</div></details>`;
}

// ---------- stock check ----------
const TONE = { bad: ['bear', '✖'], warn: ['warn', '!'], good: ['bull', '✔'], info: ['neutral', '•'], ok: ['bull', '✔'] };

function historyHtml(h) {
  if (!h.count) return '<p class="small muted">No earlier fall this large in the available history, so there is nothing to compare with. Be extra careful.</p>';
  const row = (name, x) => `<tr><td>${name}</td><td class="r num">${x.higher} of ${h.count}</td><td class="r num ${C.cls(x.medianPct)}">${C.fmtPct(x.medianPct, 1)}</td><td class="r num down">${C.fmtPct(x.worstPct, 1)}</td><td class="r num up">${C.fmtPct(x.bestPct, 1)}</td></tr>`;
  return `<p class="small">In about ${h.years} years this stock fell ${C.fmtPct(h.thresholdPct, 1)} or more in a day <b>${h.count} times</b> before. What happened next:</p>
    <div class="table-wrap"><table><thead><tr><th>After</th><th class="r">Higher</th><th class="r">Typical (median)</th><th class="r">Worst</th><th class="r">Best</th></tr></thead>
    <tbody>${row('5 days', h.after5)}${row('20 days (about a month)', h.after20)}</tbody></table></div>
    <p class="small muted">This is what happened before, not what will happen now. Close to half-and-half means a fall alone tells you nothing.</p>`;
}

function positionHtml(d) {
  return `<div class="card"><h3>I already own it</h3>
    <form class="calc" onsubmit="return false">
      <label>My average buy price<input id="pAvg" type="number" min="0" step="any" inputmode="decimal"></label>
      <label>Number of shares<input id="pQty" type="number" min="0" step="1" inputmode="numeric"></label>
      <label>Shares I think of adding<input id="pAdd" type="number" min="0" step="1" inputmode="numeric"></label>
    </form>
    <div class="calc-out" id="pOut">Enter your numbers to see where you stand. (They stay in your browser and are not saved.)</div></div>`;
}
function bindPosition(d) {
  const P = (v) => C.fmtPrice(v, d.quote.currency, d.quote.symbol);
  const price = d.quote.price;
  const stop = d.check.ifYouBuy.stop;
  const update = () => {
    const avg = parseFloat($('#pAvg').value);
    const qty = parseFloat($('#pQty').value);
    const add = parseFloat($('#pAdd').value) || 0;
    const out = $('#pOut');
    if (!(avg > 0 && qty > 0)) { out.innerHTML = 'Enter your average price and number of shares.'; return; }
    const pnl = (price - avg) * qty;
    const need = ((avg - price) / price) * 100;
    const atStop = (stop - avg) * qty;
    let html = `Now: <b class="${C.cls(pnl)}">${pnl < 0 ? 'loss' : 'gain'} ${P(Math.abs(pnl))}</b> (${C.fmtPct(((price - avg) / avg) * 100)}).${need > 0 ? ` The price must rise <b>${need.toFixed(1)}%</b> from here just to get your money back.` : ''}
      <div class="small">If it falls to ${P(stop)} (the level below the recent low), your ${pnl < 0 ? 'loss' : 'result'} would be <b class="${C.cls(atStop)}">${atStop < 0 ? '−' : '+'}${P(Math.abs(atStop))}</b>.</div>`;
    if (add > 0) {
      const newQty = qty + add;
      const newAvg = (avg * qty + price * add) / newQty;
      const newAtStop = (stop - newAvg) * newQty;
      html += `<div class="small" style="margin-top:6px">After adding ${add}: average becomes ${P(newAvg)}, but you put in <b>${P(price * add)}</b> more, and at ${P(stop)} the result becomes <b class="${C.cls(newAtStop)}">${newAtStop < 0 ? '−' : '+'}${P(Math.abs(newAtStop))}</b>. A lower average does not reduce the loss — it increases what is at risk.</div>`;
    }
    out.innerHTML = html;
  };
  ['#pAvg', '#pQty', '#pAdd'].forEach((s) => $(s).addEventListener('input', update));
}

function checkHtml(d) {
  const q = d.quote;
  const c = d.check;
  const P = (v) => C.fmtPrice(v, q.currency, q.symbol);
  const head = `<div class="stock-head"><div><h1>${C.esc(q.name)}</h1><div class="muted small">${C.esc(q.symbol)} · ${q.marketState === 'open' ? 'Market open' : 'Market closed'}${q.marketTime ? ` · price as of ${C.esc(new Date(q.marketTime).toLocaleString())}` : ''}</div></div>
    <div style="text-align:right"><div class="price num">${P(q.price)}</div><div class="num ${C.cls(q.changePct)}" style="font-weight:700">${C.fmtPct(q.changePct)} latest day</div></div></div>
    ${q.repaired ? '<p class="small muted">Note: the data provider left the latest daily close empty; it was completed from the live quote.</p>' : ''}
    ${q.stale ? '<div class="disclaimer" style="width:100%;margin:8px 0">The data provider is not responding — this is older saved data.</div>' : ''}`;
  if (c.insufficient) return `${head}<div class="card section">${C.esc(c.message)}</div>${newsBlock(d.news, { open: true })}`;
  const day = c.day;
  const stat = (k, v) => `<div><span>${k}</span><span class="num">${v}</span></div>`;
  const [toneCls] = TONE[c.stance.tone] || TONE.info;
  return `${head}
    <div class="card section stance ${toneCls}">
      <div class="small muted" style="font-weight:700">WHAT THE DATA SAYS</div>
      <h2>${C.esc(c.stance.title)}</h2>
      <p style="margin:6px 0 0">${C.esc(c.stance.text)}</p>
    </div>
    <div class="grid split section" style="align-items:start">
      <div class="card"><h3>What we found</h3>${c.findings.map((f) => {
        const [cls, icon] = TONE[f.tone] || TONE.info;
        return `<div class="factor"><div class="ic ${cls === 'bull' ? 'bullish' : cls === 'bear' ? 'bearish' : 'neutral'}">${icon}</div><div class="d" style="color:var(--text)">${C.esc(f.text)}</div></div>`;
      }).join('')}</div>
      <div class="card"><h3>The day studied: ${C.esc(day.date)}${c.isLatest ? ' (latest)' : ''}</h3>
        <div class="stats" style="grid-template-columns:minmax(0,1fr)">
          ${stat('Change', `<span class="${C.cls(day.changePct)}">${C.fmtPct(day.changePct)}</span>`)}
          ${stat(C.esc(d.indexName), C.fmtPct(day.indexPct))}
          ${stat('Compared with the market', C.fmtPct(day.relativePct))}
          ${stat('Opening gap', C.fmtPct(day.gapPct))}
          ${stat('Open → close', `${P(day.open)} → ${P(day.close)}`)}
          ${stat('High / low', `${P(day.high)} / ${P(day.low)}`)}
          ${stat('Volume vs normal', C.isNum(day.volumeMultiple) ? `${day.volumeMultiple.toFixed(1)}×` : '—')}
          ${stat('Size vs normal day', C.isNum(day.timesNormal) ? `${day.timesNormal.toFixed(1)}×` : '—')}
          ${stat('Since that close', C.fmtPct(c.latest.sinceDropPct))}
        </div></div>
    </div>
    <div class="card section"><h3>After similar falls in the past</h3>${historyHtml(c.history)}</div>
    <div class="grid cols-2 section" style="align-items:start">
      <div class="card"><h3>What would change this — wait for these</h3><ul class="notes">${c.triggers.map((t) => `<li>${C.esc(t)}</li>`).join('')}</ul></div>
      <div class="card"><h3>Where it stands now</h3><div class="stats" style="grid-template-columns:minmax(0,1fr)">
        ${stat('Daily chart signal (not a proven buy)', C.verdictPill(c.trend.verdict))}
        ${stat('RSI', C.fmtNum(c.trend.rsi, 0))}
        ${stat('50-day average', P(c.trend.sma50))}
        ${stat('200-day average', P(c.trend.sma200))}
        ${stat('Supports (floors)', c.trend.supports.map(P).join(', '))}
        ${stat('Resistances (ceilings)', c.trend.resistances.map(P).join(', '))}
        ${stat('1 month / 1 year', `${C.fmtPct(c.trend.ret1m, 1)} / ${C.fmtPct(c.trend.ret1y, 1)}`)}
        ${stat('From 52-week high', C.fmtPct(c.trend.fromHigh52, 1))}
      </div></div>
    </div>
    <div class="card section"><div class="section-head"><h3>News — read before deciding</h3>${newsChip(d.news)}</div>
      ${d.news.headlines?.length ? newsBlock(d.news, { open: true }) : `<p class="small muted">${C.esc(d.news.error || 'No headlines naming this company in the last few days.')} Check its announcements on NSE / BSE.</p>`}</div>
    <div class="grid cols-2 section" style="align-items:start">
      ${positionHtml(d)}
      <div class="card"><h3>If you still decide to buy</h3>
        <p class="small">Only after the signs above. Stop-loss: <b class="down">${P(c.ifYouBuy.stop)}</b> (${C.fmtNum(c.ifYouBuy.riskPct, 1)}% below the current price — under the recent low and outside normal daily noise).</p>
        ${riskSettingsHtml()}
        <div class="small size-line" id="cSize">${sizeText(q.price, c.ifYouBuy.stop, q.currency, q.symbol)}</div>
        <div class="stock-actions" style="justify-content:flex-start"><a class="btn small" href="#/analyze/${C.enc(q.symbol)}">Open the chart</a></div>
      </div>
    </div>
    ${checklistHtml()}`;
}

export async function viewCheck(param, alive) {
  C.view.innerHTML = `
    <div class="section-head"><h2>🔎 Stock Check — did your stock fall?</h2></div>
    <form class="card" id="chkForm" style="display:flex;gap:8px;flex-wrap:wrap">
      <input id="chkQ" type="search" maxlength="60" placeholder="Company name or symbol — e.g. Tata Motors, IRFC, YESBANK" value="${C.esc(param)}"
        style="flex:1;min-width:220px;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2)">
      <button class="btn primary" type="submit">Check this stock</button>
    </form>
    <div id="chkBody">${param ? C.loading(`Studying ${param}: price history, the day of the fall, past falls and the news…`) : `<div class="card section"><p style="margin:0">Type <b>any</b> stock above — it does not need to be in the app's list. You will get: what happened that day, whether the whole market fell too, what happened after similar falls before, the news, and what to wait for before buying more.</p></div>${checklistHtml()}`}</div>`;
  $('#chkForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const typed = $('#chkQ').value.trim();
    if (!typed) return;
    let symbol = typed.toUpperCase();
    // A company name (spaces, or lower-case words) is looked up first.
    if (/\s/.test(typed) || typed !== symbol) {
      try {
        const found = await C.api(`/api/search?q=${C.enc(typed)}`, { timeout: 15000 });
        const mine = found.quotes.find((r) => (C.state.market === 'IN' ? /\.(NS|BO)$/.test(r.symbol) : !r.symbol.includes('.'))) || found.quotes[0];
        if (mine) symbol = mine.symbol;
        else if (/\s/.test(typed)) return C.toast('No stock found with that name. Try the exchange symbol.');
      } catch (err) {
        if (/\s/.test(typed)) return C.toast(err.message);
      }
    }
    const hash = `#/check/${C.enc(symbol)}`;
    if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = hash;
  });
  if (!param) return;
  const d = await C.api(`/api/stock-check?symbol=${C.enc(param)}&market=${C.state.market}`, { signal: C.newController().signal, timeout: 60000 });
  if (!alive()) return;
  $('#chkBody').innerHTML = checkHtml(d);
  if (!d.check.insufficient) {
    bindPosition(d);
    bindRiskSettings(() => { $('#cSize').innerHTML = sizeText(d.quote.price, d.check.ifYouBuy.stop, d.quote.currency, d.quote.symbol); });
  }
}

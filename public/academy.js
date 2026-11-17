// StockSense Academy — a step-by-step course (English + Malayalam) with
// diagrams, quizzes and progress tracking.
import en1 from './academy/lessons-en-1.js';
import en2 from './academy/lessons-en-2.js';
import ml1 from './academy/lessons-ml-1.js';
import ml2 from './academy/lessons-ml-2.js';

const LESSONS = { en: { ...en1, ...en2 }, ml: { ...ml1, ...ml2 } };

// Course order. `min` = approximate reading time in minutes.
export const LEVELS = [
  { key: 'l1', lessons: [['what-is-market', 6], ['getting-started', 6], ['how-to-buy-sell', 8], ['market-basics', 7]] },
  { key: 'l2', lessons: [['candles', 6], ['trends', 6], ['support-resistance', 7], ['volume', 5], ['candle-patterns', 6]] },
  { key: 'l3', lessons: [['moving-averages', 6], ['rsi', 5], ['macd-bollinger', 6], ['chart-patterns', 7], ['analysis-routine', 8]] },
  { key: 'l4', lessons: [['entry', 8], ['stoploss', 10], ['exit-targets', 8], ['risk-management', 9], ['psychology', 7]] },
  { key: 'l5', lessons: [['fundamentals', 8], ['strategies', 9], ['advanced-topics', 9]] },
];
export const ORDER = LEVELS.flatMap((l) => l.lessons.map(([id]) => id));

const UI = {
  en: {
    title: 'Stock Market Academy', sub: 'A complete course from zero to advanced — one class at a time. Read, look at the diagrams, answer the quiz, then practise on live charts.',
    l1: 'Level 1 · Beginner — How the market works', l2: 'Level 2 · Reading charts', l3: 'Level 3 · Indicators and analysis',
    l4: 'Level 4 · Entry, exit, stop-loss and risk', l5: 'Level 5 · Advanced',
    progress: (d, t) => `${d} of ${t} classes completed`, start: 'Start the course', cont: 'Continue', review: 'Course complete — review from the start',
    cls: 'Class', min: 'min read', done: 'Completed', back: '← All classes', prev: '← Previous', next: 'Next class →',
    complete: 'Mark complete and continue →', finish: 'Finish the course ✓', quiz: 'Quick quiz', quizSub: 'Check that you understood this class.',
    correct: 'Correct!', wrong: 'Not quite.', tip: 'Tip', warn: 'Warning', ex: 'Example', tryIt: 'Try it',
    notFound: 'This class was not found.', reset: 'Reset progress', resetAsk: 'Clear your course progress?',
    note: 'This course is for education only and is not investment advice. Rules, charges and tax rates change — always verify the current ones.',
    fig: {
      high: 'High', low: 'Low', open: 'Open', close: 'Close', body: 'Body', wick: 'Wick', green: 'Green (bullish) candle', red: 'Red (bearish) candle',
      uptrend: 'Uptrend', downtrend: 'Downtrend', resistance: 'Resistance', support: 'Support', breakout: 'Breakout', flip: 'Old resistance becomes support',
      hammer: 'Hammer', bullEng: 'Bullish engulfing', doji: 'Doji', star: 'Shooting star', bearEng: 'Bearish engulfing',
      entry: 'Entry', stop: 'Stop-loss', t1: 'Target 1', t2: 'Target 2', risk: 'Risk', reward: 'Reward',
      dtop: 'Double top', dbot: 'Double bottom', hs: 'Head and shoulders', neck: 'neckline',
    },
  },
  ml: {
    title: 'ഓഹരി വിപണി അക്കാദമി', sub: 'പൂജ്യത്തിൽ നിന്ന് അഡ്വാൻസ്ഡ് വരെ ഒരു സമ്പൂർണ്ണ കോഴ്സ് — ഓരോ ക്ലാസ്സായി. വായിക്കുക, ചിത്രങ്ങൾ നോക്കുക, ക്വിസ് ചെയ്യുക, പിന്നെ ലൈവ് ചാർട്ടിൽ പരിശീലിക്കുക.',
    l1: 'ലെവൽ 1 · തുടക്കക്കാർക്ക് — വിപണി എങ്ങനെ പ്രവർത്തിക്കുന്നു', l2: 'ലെവൽ 2 · ചാർട്ട് വായന', l3: 'ലെവൽ 3 · ഇൻഡിക്കേറ്ററുകളും വിശകലനവും',
    l4: 'ലെവൽ 4 · എൻട്രി, എക്സിറ്റ്, സ്റ്റോപ്പ്-ലോസ്, റിസ്ക്', l5: 'ലെവൽ 5 · അഡ്വാൻസ്ഡ്',
    progress: (d, t) => `${t} ക്ലാസുകളിൽ ${d} എണ്ണം പൂർത്തിയായി`, start: 'കോഴ്സ് തുടങ്ങുക', cont: 'തുടരുക', review: 'കോഴ്സ് പൂർത്തിയായി — ആദ്യം മുതൽ വീണ്ടും നോക്കുക',
    cls: 'ക്ലാസ്', min: 'മിനിറ്റ്', done: 'പൂർത്തിയായി', back: '← എല്ലാ ക്ലാസുകളും', prev: '← മുമ്പത്തേത്', next: 'അടുത്ത ക്ലാസ് →',
    complete: 'പൂർത്തിയായി — അടുത്തതിലേക്ക് →', finish: 'കോഴ്സ് പൂർത്തിയാക്കുക ✓', quiz: 'ചെറിയ ക്വിസ്', quizSub: 'ഈ ക്ലാസ് മനസ്സിലായോ എന്ന് പരിശോധിക്കുക.',
    correct: 'ശരിയാണ്!', wrong: 'ശരിയല്ല.', tip: 'ടിപ്പ്', warn: 'മുന്നറിയിപ്പ്', ex: 'ഉദാഹരണം', tryIt: 'പരീക്ഷിച്ചു നോക്കൂ',
    notFound: 'ഈ ക്ലാസ് കണ്ടെത്താനായില്ല.', reset: 'പുരോഗതി മായ്ക്കുക', resetAsk: 'നിങ്ങളുടെ കോഴ്സ് പുരോഗതി മായ്ക്കണോ?',
    note: 'ഈ കോഴ്സ് പഠനത്തിന് മാത്രമാണ്; നിക്ഷേപ ഉപദേശമല്ല. നിയമങ്ങളും ചാർജുകളും നികുതി നിരക്കുകളും മാറാം — നിലവിലുള്ളവ എപ്പോഴും പരിശോധിക്കുക.',
    fig: {
      high: 'ഹൈ (High)', low: 'ലോ (Low)', open: 'ഓപ്പൺ', close: 'ക്ലോസ്', body: 'ബോഡി', wick: 'വിക്ക്', green: 'പച്ച (ബുള്ളിഷ്) കാൻഡിൽ', red: 'ചുവപ്പ് (ബെയറിഷ്) കാൻഡിൽ',
      uptrend: 'അപ്ട്രെൻഡ്', downtrend: 'ഡൗൺട്രെൻഡ്', resistance: 'റെസിസ്റ്റൻസ്', support: 'സപ്പോർട്ട്', breakout: 'ബ്രേക്കൗട്ട്', flip: 'പഴയ റെസിസ്റ്റൻസ് സപ്പോർട്ടാകുന്നു',
      hammer: 'ഹാമർ', bullEng: 'ബുള്ളിഷ് എൻഗൾഫിംഗ്', doji: 'ഡോജി', star: 'ഷൂട്ടിംഗ് സ്റ്റാർ', bearEng: 'ബെയറിഷ് എൻഗൾഫിംഗ്',
      entry: 'എൻട്രി', stop: 'സ്റ്റോപ്പ്-ലോസ്', t1: 'ടാർഗറ്റ് 1', t2: 'ടാർഗറ്റ് 2', risk: 'റിസ്ക്', reward: 'റിവാർഡ്',
      dtop: 'ഡബിൾ ടോപ്പ്', dbot: 'ഡബിൾ ബോട്ടം', hs: 'ഹെഡ് ആൻഡ് ഷോൾഡേഴ്സ്', neck: 'നെക്ക്‌ലൈൻ',
    },
  },
};

// ---------- small helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage disabled */ } },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Escape first, then allow **bold** and *italic* only.
const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');

let lang = store.get('ss.academy.lang', 'en') === 'ml' ? 'ml' : 'en';
const getDone = () => {
  const d = store.get('ss.academy.done', []);
  return new Set(Array.isArray(d) ? d.filter((id) => ORDER.includes(id)) : []);
};
const setDone = (set) => store.set('ss.academy.done', [...set]);
// Fall back to English if a translation is ever missing.
const lessonOf = (id) => LESSONS[lang][id] || LESSONS.en[id] || null;

// ---------- diagrams ----------
const T = (x, y, text, extra = '') => `<text x="${x}" y="${y}" ${extra}>${esc(text)}</text>`;
const svg = (w, h, inner, label) =>
  `<figure class="ac-fig"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet">${inner}</svg></figure>`;
// One candle: o/h/l/c are y-coordinates (smaller y = higher price).
function candle(x, o, h, l, c, w = 22) {
  const up = c < o;
  const col = up ? 'var(--up)' : 'var(--down)';
  const top = Math.min(o, c);
  const height = Math.max(2, Math.abs(o - c));
  return `<line x1="${x}" y1="${h}" x2="${x}" y2="${l}" stroke="${col}" stroke-width="2"/><rect x="${x - w / 2}" y="${top}" width="${w}" height="${height}" fill="${col}" rx="2"/>`;
}
const pline = (pts, extra = '') => `<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="var(--text)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" ${extra}/>`;
const dot = (x, y, col) => `<circle cx="${x}" cy="${y}" r="4" fill="${col}"/>`;

const FIGS = {
  candle(L) {
    const lab = (x, y, text, anchor = 'start') => `<line x1="${anchor === 'start' ? x - 46 : x + 46}" y1="${y}" x2="${anchor === 'start' ? x - 6 : x + 6}" y2="${y}" stroke="var(--muted)" stroke-dasharray="3 3"/>${T(x, y + 4, text, `text-anchor="${anchor}"`)}`;
    return svg(560, 270, `
      ${candle(150, 185, 35, 235, 85, 44)}
      ${lab(232, 35, L.high)}${lab(232, 85, L.close)}${lab(232, 185, L.open)}${lab(232, 235, L.low)}
      ${T(68, 139, L.body, 'text-anchor="end"')}<line x1="74" y1="135" x2="124" y2="135" stroke="var(--muted)" stroke-dasharray="3 3"/>
      ${T(68, 62, L.wick, 'text-anchor="end"')}<line x1="74" y1="58" x2="146" y2="58" stroke="var(--muted)" stroke-dasharray="3 3"/>
      ${T(150, 262, L.green, 'text-anchor="middle" class="cap"')}
      ${candle(420, 85, 35, 235, 185, 44)}
      ${lab(338, 35, L.high, 'end')}${lab(338, 85, L.open, 'end')}${lab(338, 185, L.close, 'end')}${lab(338, 235, L.low, 'end')}
      ${T(420, 262, L.red, 'text-anchor="middle" class="cap"')}`, `${L.green} / ${L.red}`);
  },
  trend(L) {
    const up = [[20, 185], [70, 125], [100, 155], [150, 85], [180, 115], [245, 45]];
    const dn = [[315, 45], [365, 115], [395, 85], [445, 155], [475, 125], [540, 190]];
    return svg(560, 230, `
      ${pline(up, 'style="stroke:var(--up)"')}
      ${dot(150, 85, 'var(--up)')}${dot(245, 45, 'var(--up)')}${dot(100, 155, 'var(--up)')}${dot(180, 115, 'var(--up)')}
      ${T(150, 73, 'HH', 'text-anchor="middle"')}${T(232, 33, 'HH', 'text-anchor="middle"')}${T(100, 174, 'HL', 'text-anchor="middle"')}${T(184, 134, 'HL', 'text-anchor="middle"')}
      ${T(130, 222, L.uptrend, 'text-anchor="middle" class="cap"')}
      ${pline(dn, 'style="stroke:var(--down)"')}
      ${dot(395, 85, 'var(--down)')}${dot(475, 125, 'var(--down)')}${dot(445, 155, 'var(--down)')}${dot(540, 190, 'var(--down)')}
      ${T(399, 73, 'LH', 'text-anchor="middle"')}${T(479, 113, 'LH', 'text-anchor="middle"')}${T(441, 174, 'LL', 'text-anchor="middle"')}${T(528, 208, 'LL', 'text-anchor="middle"')}
      ${T(430, 222, L.downtrend, 'text-anchor="middle" class="cap"')}`, `${L.uptrend} / ${L.downtrend}`);
  },
  sr(L) {
    const p = [[20, 160], [70, 82], [120, 172], [170, 80], [220, 174], [270, 82], [320, 168], [372, 80], [415, 48], [450, 78], [530, 22]];
    return svg(560, 240, `
      <line x1="14" y1="78" x2="546" y2="78" stroke="var(--down)" stroke-width="1.6" stroke-dasharray="6 4"/>
      <line x1="14" y1="176" x2="390" y2="176" stroke="var(--up)" stroke-width="1.6" stroke-dasharray="6 4"/>
      ${pline(p)}
      ${T(18, 68, L.resistance, 'fill="var(--down)"')}${T(18, 196, L.support, 'fill="var(--up)"')}
      ${dot(415, 48, 'var(--up)')}${T(410, 36, L.breakout, 'text-anchor="end" fill="var(--up)"')}
      ${dot(450, 78, 'var(--info)')}${T(540, 106, L.flip, 'text-anchor="end" fill="var(--info)"')}
      <line x1="450" y1="82" x2="450" y2="94" stroke="var(--info)"/>`, `${L.support} / ${L.resistance}`);
  },
  patterns(L) {
    const cell = (i, inner, name) => `<g transform="translate(${i * 120},0)">${inner}${T(60, 190, name, 'text-anchor="middle" class="cap"')}</g>`;
    return svg(600, 200, `
      ${cell(0, candle(60, 62, 50, 150, 54, 26), L.hammer)}
      ${cell(1, candle(44, 70, 62, 124, 116, 20) + candle(76, 128, 48, 136, 56, 28), L.bullEng)}
      ${cell(2, candle(60, 98, 50, 150, 97, 26), L.doji)}
      ${cell(3, candle(60, 138, 50, 150, 146, 26), L.star)}
      ${cell(4, candle(44, 116, 62, 124, 70, 20) + candle(76, 56, 48, 136, 128, 28), L.bearEng)}`, `${L.hammer}, ${L.bullEng}, ${L.doji}, ${L.star}, ${L.bearEng}`);
  },
  plan(L) {
    const line = (y, col, text) => `<line x1="14" y1="${y}" x2="440" y2="${y}" stroke="${col}" stroke-width="1.6" stroke-dasharray="6 4"/>${T(20, y - 6, text, `fill="${col}"`)}`;
    return svg(560, 250, `
      ${line(34, 'var(--up)', L.t2)}${line(78, 'var(--up)', L.t1)}${line(140, 'var(--info)', L.entry)}${line(196, 'var(--down)', L.stop)}
      ${pline([[150, 176], [185, 150], [215, 164], [250, 140], [290, 108], [315, 122], [355, 78], [385, 92], [432, 36]])}
      ${dot(250, 140, 'var(--info)')}
      <rect x="462" y="78" width="16" height="62" fill="var(--up)" opacity=".75" rx="3"/>
      <rect x="462" y="140" width="16" height="56" fill="var(--down)" opacity=".75" rx="3"/>
      ${T(486, 113, L.reward, 'fill="var(--up)"')}${T(486, 172, L.risk, 'fill="var(--down)"')}`, `${L.entry}, ${L.stop}, ${L.t1}, ${L.t2}`);
  },
  cpatterns(L) {
    const neck = (x1, x2, y) => `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="var(--muted)" stroke-dasharray="5 4"/>`;
    return svg(600, 200, `
      ${neck(20, 180, 120)}${pline([[20, 160], [60, 50], [100, 120], [140, 50], [172, 120], [185, 165]], 'style="stroke:var(--down)"')}
      ${T(100, 190, L.dtop, 'text-anchor="middle" class="cap"')}
      ${neck(220, 380, 70)}${pline([[220, 30], [260, 140], [300, 70], [340, 140], [372, 70], [385, 28]], 'style="stroke:var(--up)"')}
      ${T(300, 190, L.dbot, 'text-anchor="middle" class="cap"')}
      ${neck(420, 590, 125)}${pline([[420, 160], [445, 85], [470, 125], [505, 40], [540, 125], [562, 85], [578, 125], [590, 165]], 'style="stroke:var(--down)"')}
      ${T(505, 190, L.hs, 'text-anchor="middle" class="cap"')}${T(588, 117, L.neck, 'text-anchor="end" class="small"')}`, `${L.dtop}, ${L.dbot}, ${L.hs}`);
  },
};

// ---------- rendering ----------
function block(b, U) {
  const [type, a, c] = b;
  switch (type) {
    case 'h': return `<h3>${rich(a)}</h3>`;
    case 'p': return `<p>${rich(a)}</p>`;
    case 'ul': return `<ul>${a.map((x) => `<li>${rich(x)}</li>`).join('')}</ul>`;
    case 'ol': return `<ol>${a.map((x) => `<li>${rich(x)}</li>`).join('')}</ol>`;
    case 'tip': return `<div class="ac-note tip"><b>💡 ${esc(U.tip)}</b><span>${rich(a)}</span></div>`;
    case 'warn': return `<div class="ac-note warn"><b>⚠ ${esc(U.warn)}</b><span>${rich(a)}</span></div>`;
    case 'ex': return `<div class="ac-note ex"><b>🧮 ${esc(U.ex)}</b><span>${rich(a)}</span></div>`;
    case 'fig': return FIGS[a] ? FIGS[a](U.fig) : '';
    case 'try': return typeof c === 'string' && c.startsWith('#/') ? `<a class="ac-try" href="${esc(c)}">▶ ${esc(U.tryIt)}: ${esc(a)}</a>` : '';
    default: return '';
  }
}

function langToggle() {
  return `<div class="seg ac-lang" role="group" aria-label="Language">
    <button type="button" data-lang="en" class="${lang === 'en' ? 'active' : ''}">English</button>
    <button type="button" data-lang="ml" class="${lang === 'ml' ? 'active' : ''}" lang="ml">മലയാളം</button>
  </div>`;
}
function bindLang(rerender) {
  $$('.ac-lang button').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.lang === lang) return;
      lang = b.dataset.lang;
      store.set('ss.academy.lang', lang);
      rerender();
    })
  );
}

function renderHome(view) {
  const U = UI[lang];
  const done = getDone();
  const total = ORDER.length;
  const nextId = ORDER.find((id) => !done.has(id));
  const cta = !nextId ? U.review : done.size ? U.cont : U.start;
  let n = 0;
  view.innerHTML = `<div class="academy ${lang}" lang="${lang}">
    <div class="card ac-hero">
      <div class="ac-hero-top"><div><h1>🎓 ${esc(U.title)}</h1><p class="muted">${esc(U.sub)}</p></div>${langToggle()}</div>
      <div class="ac-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done.size}"><span style="width:${(done.size / total) * 100}%"></span></div>
      <div class="ac-hero-bottom">
        <span class="small muted">${esc(U.progress(done.size, total))}</span>
        <span>${done.size ? `<button type="button" class="btn small" id="acReset">${esc(U.reset)}</button> ` : ''}<a class="btn primary" href="#/academy/${esc(nextId || ORDER[0])}">${esc(cta)}${nextId && lessonOf(nextId) ? `: ${esc(lessonOf(nextId).t)}` : ''}</a></span>
      </div>
    </div>
    ${LEVELS.map((lv) => `
      <div class="section-head section"><h2>${esc(U[lv.key])}</h2><span class="small muted">${lv.lessons.filter(([id]) => done.has(id)).length}/${lv.lessons.length}</span></div>
      <div class="grid cols-3">${lv.lessons.map(([id, min]) => {
        const les = lessonOf(id);
        n++;
        if (!les) return '';
        return `<a class="card click ac-card ${done.has(id) ? 'done' : ''}" href="#/academy/${esc(id)}">
          <div class="ac-card-top"><span class="ac-num">${done.has(id) ? '✓' : n}</span><span class="small muted">${esc(U.cls)} ${n} · ${min} ${esc(U.min)}</span></div>
          <h3>${esc(les.t)}</h3><p class="small muted">${esc(les.s)}</p>
        </a>`;
      }).join('')}</div>`).join('')}
    <p class="small muted section">${esc(U.note)}</p>
  </div>`;
  bindLang(() => renderHome(view));
  $('#acReset')?.addEventListener('click', () => {
    if (!window.confirm(U.resetAsk)) return;
    setDone(new Set());
    renderHome(view);
  });
}

function renderLesson(view, id) {
  const U = UI[lang];
  const les = lessonOf(id);
  const idx = ORDER.indexOf(id);
  if (!les || idx < 0) {
    view.innerHTML = `<div class="card hero-empty"><h2>${esc(U.notFound)}</h2><p><a class="btn primary" href="#/academy">${esc(U.back)}</a></p></div>`;
    return;
  }
  const level = LEVELS.find((lv) => lv.lessons.some(([x]) => x === id));
  const min = level.lessons.find(([x]) => x === id)[1];
  const done = getDone();
  const prev = ORDER[idx - 1];
  const next = ORDER[idx + 1];
  const quiz = (les.q || []).map((q, qi) => `
    <div class="ac-q" data-q="${qi}">
      <div class="ac-q-text">${qi + 1}. ${rich(q[0])}</div>
      <div class="ac-opts">${q[1].map((o, oi) => `<button type="button" class="ac-opt" data-o="${oi}">${rich(o)}</button>`).join('')}</div>
      <div class="ac-fb" hidden></div>
    </div>`).join('');

  view.innerHTML = `<article class="academy lesson ${lang}" lang="${lang}">
    <div class="ac-lesson-top"><a href="#/academy" class="small">${esc(U.back)}</a>${langToggle()}</div>
    <div class="card ac-body">
      <div class="small muted">${esc(U[level.key])}</div>
      <h1>${esc(U.cls)} ${idx + 1}: ${esc(les.t)}</h1>
      <p class="muted">${esc(les.s)} <span class="pill neutral">${min} ${esc(U.min)}</span> ${done.has(id) ? `<span class="pill bull">✓ ${esc(U.done)}</span>` : ''}</p>
      ${les.b.map((b) => block(b, U)).join('')}
    </div>
    ${quiz ? `<div class="card section ac-quiz"><h2>📝 ${esc(U.quiz)}</h2><p class="small muted">${esc(U.quizSub)}</p>${quiz}</div>` : ''}
    <div class="ac-nav section">
      ${prev ? `<a class="btn" href="#/academy/${esc(prev)}">${esc(U.prev)}</a>` : '<span></span>'}
      <button type="button" class="btn primary" id="acComplete">${esc(next ? U.complete : U.finish)}</button>
    </div>
  </article>`;

  bindLang(() => renderLesson(view, id));

  $$('.ac-q', view).forEach((qEl) => {
    const q = les.q[Number(qEl.dataset.q)];
    $$('.ac-opt', qEl).forEach((btn) =>
      btn.addEventListener('click', () => {
        const chosen = Number(btn.dataset.o);
        const right = chosen === q[2];
        $$('.ac-opt', qEl).forEach((b, i) => {
          b.disabled = true;
          if (i === q[2]) b.classList.add('right');
          else if (i === chosen) b.classList.add('wrong');
        });
        const fb = $('.ac-fb', qEl);
        fb.hidden = false;
        fb.className = `ac-fb ${right ? 'right' : 'wrong'}`;
        fb.innerHTML = `<b>${esc(right ? U.correct : U.wrong)}</b> ${rich(q[3])}`;
      })
    );
  });

  $('#acComplete').addEventListener('click', () => {
    const d = getDone();
    d.add(id);
    setDone(d);
    location.hash = next ? `#/academy/${next}` : '#/academy';
  });
}

export function viewAcademy(param) {
  const view = $('#view');
  const id = String(param || '').trim();
  if (id) renderLesson(view, id);
  else renderHome(view);
}

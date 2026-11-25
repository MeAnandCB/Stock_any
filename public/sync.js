// StockSense — cloud sync, browser side.
// The rules (sync code, newest-wins merge, the engine) live in /lib/sync-core.js, shared with the server
// and covered by tests. This file connects them to localStorage, the network and the "☁️ Sync" dialog.
//
// It must be the FIRST module app.js imports: it watches writes to localStorage so every part of the app
// (watchlist, paper trading, Academy) is synced without those parts knowing about it.
import { createEngine, SYNC_KEYS } from '/lib/sync-core.js';

let ls = null;
try {
  ls = window.localStorage;
} catch {
  /* storage blocked: sync stays off */
}
const proto = Storage.prototype;
const rawGet = proto.getItem;
const rawSet = proto.setItem;
const rawRemove = proto.removeItem;

// Raw access: used by the engine, so its own writes are never mistaken for edits by the user.
const storage = {
  get: (k) => { try { return rawGet.call(ls, k); } catch { return null; } },
  set: (k, v) => { try { rawSet.call(ls, k, String(v)); } catch { /* full or blocked */ } },
  remove: (k) => { try { rawRemove.call(ls, k); } catch { /* ignore */ } },
};

async function post(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(data?.error || `Sync failed (HTTP ${res.status}).`), { status: res.status });
    return data;
  } catch (e) {
    if (e.status) throw e;
    throw Object.assign(new Error(e.name === 'AbortError' ? 'The server took too long to answer.' : 'Cannot reach the server — you may be offline.'), { status: 0 });
  } finally {
    clearTimeout(timer);
  }
}

export const engine = createEngine({ storage, post });

// ---------- status + footer button ----------
const status = { state: 'idle', message: '', reloadNeeded: false };
let lastRun = 0;
const timeText = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function updateButton() {
  const b = document.getElementById('syncBtn');
  if (!b) return;
  let text = '☁️ Sync: off';
  if (!ls) text = '☁️ Sync unavailable';
  else if (engine.code()) {
    if (status.reloadNeeded) text = '☁️ Updated from cloud — click to reload';
    else if (status.state === 'syncing') text = '☁️ Syncing…';
    else if (status.state === 'error') text = '⚠ Sync problem — click for details';
    else text = engine.lastSync() ? `☁️ Synced ${timeText(engine.lastSync())}` : '☁️ Sync on';
  }
  b.textContent = text;
  b.title = engine.code() ? 'Your watchlist, paper-trading accounts and course progress are kept in the cloud' : 'Keep your data in the cloud and open it on any device';
}
function setStatus(state, message = '') {
  status.state = state;
  status.message = message;
  updateButton();
  document.dispatchEvent(new CustomEvent('ss:sync-status'));
}

// ---------- running a sync ----------
let running = null;
let timer = null;
let dirty = false;

function modalOpen() {
  return Boolean(document.querySelector('.pt-backdrop'));
}
function remoteChangesArrived() {
  // Another device changed something. The page already drew itself from the old data, so refresh it —
  // but never while the user is in the middle of an order or a dialog.
  if (modalOpen()) {
    status.reloadNeeded = true;
    updateButton();
  } else {
    location.reload();
  }
}

export function runSync() {
  if (!ls || !engine.code()) return Promise.resolve(null);
  if (running) {
    dirty = true; // something changed while syncing: go round again afterwards
    return running;
  }
  clearTimeout(timer);
  timer = null;
  setStatus('syncing');
  running = engine
    .sync()
    .then((r) => {
      lastRun = Date.now();
      setStatus('idle');
      if (r.applied.length && appStarted) remoteChangesArrived();
      return r;
    })
    .catch((e) => {
      setStatus('error', e.message);
      return null;
    })
    .finally(() => {
      running = null;
      if (dirty) {
        dirty = false;
        schedulePush();
      }
    });
  return running;
}

function schedulePush() {
  if (!engine.code()) return;
  if (running) {
    dirty = true;
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(runSync, 1500); // wait for a burst of edits to finish
}

// Watch every write the app makes to a synced key.
proto.setItem = function (key, value) {
  if (this !== ls || !SYNC_KEYS.includes(key)) return rawSet.call(this, key, value);
  let same = false;
  try {
    same = rawGet.call(this, key) === String(value);
  } catch {
    /* treat as changed */
  }
  rawSet.call(this, key, value);
  if (!same) {
    engine.touch(key);
    schedulePush();
  }
};

let appStarted = false;
// Called once before the first screen is drawn: fetch the cloud copy so the app starts on current data.
// Never blocks for long and never throws — offline just means "start with what is on this device".
export async function startSync() {
  try {
    updateButton();
    if (ls && engine.code()) await Promise.race([runSync(), new Promise((r) => setTimeout(r, 4000))]);
  } finally {
    appStarted = true;
  }
}

export function initSyncUi() {
  const btn = document.getElementById('syncBtn');
  updateButton();
  btn?.addEventListener('click', () => {
    if (status.reloadNeeded) location.reload();
    else openSyncDialog();
  });
  const wake = () => {
    if (document.visibilityState === 'visible' && engine.code() && Date.now() - lastRun > 30000) runSync();
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('focus', wake);
  window.addEventListener('online', wake);
  // Closing the tab right after an edit: send it now (a beacon survives the page closing).
  window.addEventListener('pagehide', () => {
    if (timer && engine.code()) {
      try {
        navigator.sendBeacon('/api/sync', new Blob([JSON.stringify(engine.payload())], { type: 'application/json' }));
      } catch {
        /* best effort */
      }
    }
  });
}

// ---------- the dialog ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let dlg = null; // { root, box, onKey, reloadOnClose }

function closeDialog() {
  if (!dlg) return;
  document.removeEventListener('keydown', dlg.onKey);
  const { root } = dlg;
  dlg = null;
  root.remove();
  if (status.reloadNeeded) location.reload();
}

function summaryHtml(d) {
  const parts = [];
  if (d.watchlist) parts.push(`${d.watchlist} watchlist stock${d.watchlist === 1 ? '' : 's'}`);
  for (const m of ['IN', 'US']) {
    const a = d.paper[m];
    if (a && a.orders + a.trades + a.holdings + a.positions > 0) parts.push(`paper trading ${m}: ${a.trades} trade${a.trades === 1 ? '' : 's'}, ${a.orders} order${a.orders === 1 ? '' : 's'}`);
  }
  if (d.classesDone) parts.push(`${d.classesDone} Academy class${d.classesDone === 1 ? '' : 'es'} done`);
  return d.hasData
    ? `<b>This browser has:</b> ${esc(parts.join(' · '))}.`
    : `<b>This browser has no watchlist, paper trades or course progress yet.</b> If you used StockSense before, open it at the <b>same address you used then</b> (for example http://localhost:3000) — browsers keep separate data for each address.`;
}

function show(html, bind) {
  dlg.box.innerHTML = html;
  dlg.box.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', closeDialog));
  bind?.(dlg.box);
  dlg.box.focus({ preventScroll: true });
}
const head = (title, sub = '') => `<div class="pt-m-head"><div><h2 id="syncTitle">${title}</h2>${sub ? `<div class="small muted">${sub}</div>` : ''}</div><button type="button" class="btn small" data-act="close" aria-label="Close">✕</button></div>`;
const showErr = (box, msg) => {
  const el = box.querySelector('#syncErr');
  if (!el) return;
  el.textContent = msg;
  el.hidden = !msg;
};
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied ✓';
  } catch {
    const range = document.createRange();
    const target = document.querySelector('.sync-code');
    if (target) {
      range.selectNodeContents(target);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
    btn.textContent = 'Press ⌘C / Ctrl+C';
  }
}

function viewOff() {
  const d = engine.describeLocal();
  show(`${head('☁️ Sync across devices', 'Keep your watchlist, paper-trading accounts and course progress in the cloud and open them on any device.')}
    <div class="pt-m-body">
      <div class="pt-tip small">${summaryHtml(d)}</div>
      <button type="button" class="btn primary" data-act="create">${d.hasData ? 'Create a sync code and upload this browser’s data' : 'Create a sync code'}</button>
      <div class="small muted" style="text-align:center">— or, if you already have a code —</div>
      <label class="pt-f">Sync code from your other device
        <input id="syncCodeIn" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"></label>
      <button type="button" class="btn" data-act="join">Connect with this code</button>
      <div class="pt-err" id="syncErr" hidden></div>
      <p class="small muted" style="margin:0">Connecting replaces older data on this browser with the cloud copy (what was replaced is kept for recovery). Your code works on any device that can open this app.</p>
    </div>`, (box) => {
    const busy = (on) => box.querySelectorAll('button[data-act]').forEach((b) => (b.disabled = on));
    box.querySelector('[data-act="create"]').addEventListener('click', async () => {
      busy(true);
      showErr(box, '');
      try {
        const code = await engine.create(crypto.getRandomValues(new Uint8Array(32)));
        updateButton();
        viewCreated(code);
      } catch (e) {
        showErr(box, e.message);
        busy(false);
      }
    });
    const join = async () => {
      busy(true);
      showErr(box, '');
      try {
        const r = await engine.join(box.querySelector('#syncCodeIn').value);
        updateButton();
        show(`${head('✔ Connected')}<div class="pt-m-body"><p style="margin:0">${r.applied.length ? 'Your data was downloaded from the cloud. Reloading…' : 'Connected. This browser matches the cloud copy.'}</p></div>`);
        if (r.applied.length) setTimeout(() => location.reload(), 900);
        else setTimeout(closeDialog, 1200);
      } catch (e) {
        showErr(box, e.message);
        busy(false);
      }
    };
    box.querySelector('[data-act="join"]').addEventListener('click', join);
    box.querySelector('#syncCodeIn').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join();
    });
  });
}

function viewCreated(code) {
  show(`${head('✔ Your sync code')}
    <div class="pt-m-body">
      <div class="sync-code" aria-label="Your sync code">${esc(code)}</div>
      <button type="button" class="btn primary" data-act="copy">Copy code</button>
      <div class="pt-tip small"><b>Save this code somewhere safe</b> (a password manager is ideal). Type it into “☁️ Sync” on every other device to see the same data.
        Anyone who has the code can read and change your synced data, and it cannot be recovered if you lose it — but you can always see it again here while this device is connected.</div>
      <p class="small muted" style="margin:0">Uploaded to the cloud: your watchlist, paper-trading accounts, Academy progress and risk settings. Theme and chart settings stay on each device.</p>
    </div>
    <div class="pt-m-foot"><button type="button" class="btn" data-act="close">Done</button></div>`, (box) => {
    box.querySelector('[data-act="copy"]').addEventListener('click', (e) => copyText(code, e.currentTarget));
  });
}

function viewOn() {
  const code = engine.code();
  const masked = `${code.slice(0, 5)}-•••••-•••••-•••••-•••••`;
  const bad = status.state === 'error';
  show(`${head('☁️ Sync is on')}
    <div class="pt-m-body">
      <div class="pt-tip small" style="${bad ? 'border-left-color:var(--down)' : ''}">${bad ? `⚠ ${esc(status.message)}` : `✔ Connected${engine.lastSync() ? ` · last synced ${esc(timeText(engine.lastSync()))}` : ''}`}</div>
      <div><div class="small muted" style="margin-bottom:4px">Your sync code</div>
        <div class="sync-code" id="syncCodeShown">${esc(masked)}</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn" data-act="reveal">Show code</button>
        <button type="button" class="btn" data-act="copy">Copy code</button>
        <button type="button" class="btn primary" data-act="now">Sync now</button>
      </div>
      <div class="pt-err" id="syncErr" hidden></div>
      <hr style="border:0;border-top:1px solid var(--border);width:100%;margin:2px 0">
      <button type="button" class="btn" data-act="stop">Stop syncing on this device <span class="small muted">(keeps your data here and in the cloud)</span></button>
      <button type="button" class="btn sell" data-act="wipe">Delete my cloud copy <span class="small">(stops syncing on all devices)</span></button>
    </div>`, (box) => {
    const shown = box.querySelector('#syncCodeShown');
    box.querySelector('[data-act="reveal"]').addEventListener('click', (e) => {
      const hidden = shown.textContent.includes('•');
      shown.textContent = hidden ? code : masked;
      e.currentTarget.textContent = hidden ? 'Hide code' : 'Show code';
    });
    box.querySelector('[data-act="copy"]').addEventListener('click', (e) => copyText(code, e.currentTarget));
    box.querySelector('[data-act="now"]').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      const r = await runSync();
      if (r && r.applied.length) {
        show(`${head('✔ Updated from the cloud')}<div class="pt-m-body"><p style="margin:0">Newer data from another device was downloaded. Reloading…</p></div>`);
        setTimeout(() => location.reload(), 900);
        return;
      }
      viewOn();
    });
    box.querySelector('[data-act="stop"]').addEventListener('click', () => {
      engine.disconnect();
      updateButton();
      viewOff();
    });
    box.querySelector('[data-act="wipe"]').addEventListener('click', async () => {
      if (!confirm('Delete your cloud copy?\n\nOther devices using this code will stop syncing. The data on each device stays where it is — only the cloud copy is removed.')) return;
      try {
        await engine.wipeCloud();
        updateButton();
        viewOff();
      } catch (e) {
        showErr(box, e.message);
      }
    });
  });
}

export function openSyncDialog() {
  closeDialog();
  if (!ls) {
    alert('This browser is blocking local storage, so sync cannot be set up here.');
    return;
  }
  const root = document.createElement('div');
  root.className = 'pt-backdrop';
  root.innerHTML = '<div class="pt-modal sync-modal" role="dialog" aria-modal="true" aria-labelledby="syncTitle" tabindex="-1"></div>';
  document.body.appendChild(root);
  const onKey = (e) => {
    if (e.key === 'Escape') closeDialog();
  };
  dlg = { root, box: root.firstElementChild, onKey };
  document.addEventListener('keydown', onKey);
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) closeDialog();
  });
  if (engine.code()) viewOn();
  else viewOff();
}

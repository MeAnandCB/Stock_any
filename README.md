# StockSense — beginner-friendly stock analyser

Live market dashboard, Buy/Hold/Sell signals, entry / stop-loss / target levels, top picks, watchlist and news with sentiment — for **India (NSE/BSE)** and **US** markets.

> Educational tool, not financial advice. Signals are rule-based and can be wrong.

## Run it

Needs Node.js 18+. There are no dependencies to install **unless you want to save history to MongoDB** (then run `npm install` once — see [Saving data to MongoDB](#saving-data-to-mongodb-optional)).

- Double-click **`start.bat`**, or
- `npm start` (opens the browser) / `node server.js`

Then open http://localhost:3000. If port 3000 is busy it picks the next free one.

`npm test` runs the unit tests (on Node 22+ use `node --test test/*.test.js` if `npm test` complains about the `test/` folder).

## Saving data to MongoDB (optional)

The app works fine without a database. Connect one and it keeps a history of the intraday desk:

| Collection | What is saved | When |
|---|---|---|
| `picks` | Every **best-of-the-best** intraday BUY: stock, scenario, buy zone, stop-loss, targets, risk:reward, score and checks passed — **frozen as first signalled** — plus the last time it still qualified. Kept forever (about 0.5 KB each). | The first time a stock passes every check **while the market is open** |
| `scans` | A snapshot of the whole desk: every stock's score, scenario and plan, the daily signal, market direction and the Strong Buy lists (about 14 KB each). Deleted automatically after 30 days. | Every 5 minutes while the market is open (one final snapshot per session after the close) — **only while someone has the Intraday page open or calls `/api/intraday`** |

Your watchlist and paper-trading accounts live in your browser; to keep them in the cloud and use them on any device, turn on **☁️ Sync** (next section).

**Set it up** — pick one database, then start the app:

1. `npm install` (installs the MongoDB driver).
2. **Database on this computer:** run `npm run db` in its own terminal and leave it open (data is kept in `.mongodb/data`; it only listens on 127.0.0.1). It uses `.mongodb/mongod`, or any `mongod` on your PATH (`brew tap mongodb/brew && brew install mongodb-community` on macOS).
   **Or MongoDB Atlas (cloud, free tier):** create a cluster, a database user (Database Access) and allow your IP (Network Access), then copy the connection string — `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/`. URL-encode special characters in the password (`@` → `%40`).
3. Copy `.env.example` to `.env` and set `MONGODB_URI=` (local: `mongodb://127.0.0.1:27017`). `.env` is git-ignored; real environment variables override it.
4. `npm start`. The console says `MongoDB: connected`, or why it could not. The Intraday page shows a **📚 Saved history** table, and `/api/db-status` reports `{ ok, scans, picks }`.

If something else already uses port 3000 on your computer, add `PORT=3100` (any free port) to `.env`.

Options in `.env`: `MONGODB_DB` (default `stocksense`), `SCAN_TTL_DAYS` (default 30; `0` keeps scans forever), `MONGODB_TIMEOUT_MS` (default 5000).

**Good to know**

- A database problem never breaks the app: saving has a 2.5 s time limit, a failed connection is retried at most every 30 s, and errors are logged once a minute with the connection string removed.
- Writes are idempotent (fixed IDs per 5-minute slot / per pick), so refreshing, several browser tabs or several server instances never create duplicates.
- On **Vercel**: add `MONGODB_URI` (and optionally the other variables) under Project → Settings → Environment Variables, and in Atlas → Network Access allow Vercel's addresses (`0.0.0.0/0` is the usual choice because Vercel IPs change). Vercel installs the driver from `package.json` automatically.
- `/api/history` and `/api/db-status` are read-only and never expose the connection string, but on a public deployment anyone can read the saved signal history.
- To run the database tests: `TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node --test test/*.test.js` (uses a temporary database and deletes it afterwards).

## ☁️ Sync across devices (needs the database)

Keeps your **watchlist, paper-trading accounts (India and US), Academy progress and risk settings** in MongoDB, so any browser or device shows the same data. Theme and chart-timeframe settings stay per device.

1. Open the app on the device that has your data — **at the address you always used** (browsers keep a separate store per address: `localhost:3000`, `localhost:3100` and `127.0.0.1:3000` are all different).
2. Click **☁️ Sync: off** in the page footer → **Create a sync code and upload this browser's data**. Save the code (a password manager is ideal).
3. On every other device: open the app → **☁️ Sync** → paste the code → **Connect**. That device now shows the same data.

From then on changes are uploaded a moment after you make them and downloaded when you open or return to the app. Details:

- **Newest change wins, per item.** If you change the watchlist on two devices while offline, the later edit wins; the other items (e.g. the paper account) are unaffected. A paper-trading account is one item, so trade on one device at a time. When connecting replaces older data, the replaced copy is kept in the browser (`ss.sync.prev`).
- **The code is the password.** It has 120 random bits and a check character (typos are caught), the server stores only a hash of it, and wrong guesses are rate-limited. Anyone with the code can read and change your synced data — it cannot be recovered if lost, but you can see it again in **☁️ Sync** while a device is connected. **Delete my cloud copy** removes it for everyone.
- **Anywhere** means the app itself must be reachable: run it on a host such as Vercel (below), or use it on your own computer. Every deployment pointing at the same database shares the same sync codes.
- A server accepts at most 20 sync codes (`SYNC_MAX_BUCKETS`) so a public deployment cannot fill a free database.
- Deleting something (e.g. removing the last watchlist stock) syncs like any other edit; resetting the browser's storage does not delete the cloud copy.

**Put it online (Vercel)**

1. Push the project to GitHub (it already is) and import it at vercel.com → *Add New… → Project*. No build settings needed — `vercel.json` has them.
2. Project → Settings → Environment Variables: add `MONGODB_URI` (your Atlas string). Optionally `MONGODB_DB`, `SYNC_MAX_BUCKETS`.
3. In Atlas → Network Access, allow `0.0.0.0/0` (Vercel's addresses change).
4. Redeploy, open the `https://…vercel.app` address, and use **☁️ Sync** there. Use the **same address** every time on that device. Data from a different address (e.g. your old `localhost:3000`) is brought across by creating the code there first, then connecting from the new address.

## Features

| Tab | What it does |
|---|---|
| Dashboard | Indices (NIFTY, SENSEX, Bank Nifty, VIX / S&P, NASDAQ, Dow, VIX), market mood, best setups, top gainers/losers, headlines. Auto-refreshes every 5 min. |
| Analyse | **Live candlestick chart** (1 min / 5 min / 15 min / 1 hour / Daily) that updates every 5–10 s while the market is open, with a LIVE badge, pause button and live header price. Chart overlays: 20/50/200-bar averages, Bollinger Bands, support/resistance, trade-plan lines, RSI and MACD. Signal score (−100…+100), entry zone, stop-loss, 2 targets, risk:reward, plain-English explanation of every indicator, an **Intraday view** card (VWAP, opening range, relative volume, intraday plan and best-of-the-best checklist), position-size calculator, stock news. |
| Top Picks | Scans 30 large caps per market. Ranks by short-term setup score or long-term trend strength. Filters include **⭐ Strong Buy** (score +50 or more). |
| ⚡ Intraday | The intraday desk, on 5-minute candles. **🏆 Best of the best** — the intraday BUY picks that pass *every* check (shown separately, with a pass/fail checklist, buy zone, stop-loss and targets). **⭐ Strong Buy stocks** — one list from the daily chart (swing) and one from the live 5-minute chart. **🔍 Every scenario** — all 30 stocks sorted into 14 scenarios (opening-range breakout, gap-up holding / fading, gap-down reversal, pullback to VWAP, steady uptrend / downtrend, overextended, range-bound, low volume …) with filters. Shows market direction (index) and time left in the session. Auto-refreshes every minute while the market is open. |
| Watchlist | Saved in your browser. |
| ⚡ Intraday → 📚 Saved history | The best-of-the-best picks saved in MongoDB (see above) with their frozen buy zone, stop-loss and targets. Appears at the bottom of the Intraday tab; explains how to connect when no database is set. |
| Paper Trade | Practise with **virtual money** (₹10,00,000 / $100,000) at live prices, in a broker-style layout: Buy/Sell order window (Delivery or Intraday, Market / Limit / SL-M, quantity, margin and approximate charges), **Holdings, Positions, Orders** and a **P&L report**. Stop-loss and target orders trigger automatically while the app is open, and every closed trade gets a plain-English review (R-multiple, charges, did you use a stop-loss). A step-by-step *Learn* guide walks you through your first trade. Stored only in your browser; separate India and US accounts. Buy/Sell buttons also appear on every stock's Analyse page. |
| News | Market or topic news with positive/negative headline tagging. |
| Academy | A 22-class course from beginner to advanced in **English and Malayalam (മലയാളം)**: how the market works, opening an account, how to buy and sell, reading candles, trends, support/resistance, indicators, chart analysis routine, entry, stop-loss, exits, risk management, psychology, fundamentals and strategies. Diagrams, a quiz per class, progress tracking and "try it" links into live charts. |
| Glossary | Beginner rules and glossary. |

Search accepts company names ("infosys") or symbols. In India mode, `RELIANCE` resolves to `RELIANCE.NS` automatically.

## How signals work

10 factors are scored and weighted: price vs 200/50-day average, 50/200 alignment (golden/death cross), 20 vs 50-day, RSI, MACD (and fresh crossovers), Bollinger Bands, volume confirmation, 1-month momentum and candlestick patterns (engulfing, hammer, shooting star, doji).

### Intraday signals

Computed on 5-minute candles (last 5 sessions) in `lib/intraday.js`. Ten factors give a −100…+100 score: price vs **VWAP**, **opening-range** (first 15 min) breakout, 9 vs 21 EMA, RSI, MACD, relative volume (vs the same clock time on earlier days), change vs yesterday's close, yesterday's high/low, the last hour's high/low structure and position in today's range. Each stock is then placed in one scenario, and gets a long trade plan (stop under the nearest structure / VWAP, targets at the next resistance or 2R / 3R).

A stock is **best of the best** only if all of these hold: intraday Strong Buy · a buy scenario · above VWAP · 9 EMA above 21 EMA · volume ≥ 1.2× normal · RSI 50–75 · room to run before yesterday's high / pivots · daily chart is Buy or Strong Buy · the index is not falling · at least 45 minutes left (when the market is open). When nothing passes, the page says so and lists the closest candidates with what is missing — "no trade" is a valid answer.

When the market is closed, everything reflects the **last session**; intraday signals go stale quickly, so re-check after the open.

### Daily signals (stop-loss and targets)

Stop-loss sits just below the nearest swing-low support (bounded by 0.75–3 × ATR); targets use the next resistance levels or 2R / 3R multiples.

## Data sources

- Intraday: Yahoo 5-minute bars (same source, usually ~15 min delayed for NSE).
- Prices & search: Yahoo Finance public chart/search endpoints (may be ~15 min delayed).
- News: Google News RSS (fallback: Yahoo Finance).

Unofficial endpoints can change or rate-limit; the server retries, caches (3 min prices, 5 min news) and serves the last good data if the provider is temporarily down.

## Project layout

```
server.js            HTTP server + API routes
lib/env.js           tiny .env loader
lib/db.js            optional MongoDB connection (lazy, retry back-off, secret-safe errors)
lib/store.js         what is saved (scans, picks), how, and how it is read back
lib/yahoo.js         data fetching, caching, retries, normalisation
lib/indicators.js    SMA, EMA, RSI, MACD, Bollinger, ATR, pivots
lib/analysis.js      scoring, levels, trade plan, summaries
lib/intraday.js      intraday engine: VWAP, opening range, scenarios, plan, "best of the best" checks (pure, unit-tested)
lib/news.js          Google News RSS parser
lib/sentiment.js     headline sentiment
lib/universe.js      indices and stock lists per market
lib/paper.js         paper-trading engine (orders, fills, margin, charges, P&L) — shared with the browser
public/              UI (index.html, app.js, styles.css)
public/paper.js      Paper Trade screens and order window
public/intraday.js   Intraday desk page and the Intraday card on the Analyse page
public/academy.js    course engine (curriculum, diagrams, quizzes, progress)
public/academy/      lesson text: lessons-en-*.js and lessons-ml-*.js (same ids in both)
test/                unit tests (node --test)
```

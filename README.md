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

## 📲 Daily Telegram digest

Every weekday morning your Telegram gets the same **Final Picks** as the app: up to 5 each for **intraday** (only stocks that pass every check — plain buy signals lost money in testing), **short term** and **long term**, each section followed by what testing says about its rule. Every candidate's headlines are screened: a stock with serious warning words is held back and named, and negative headlines are flagged. If nothing qualifies it says so — it never pads a list.

**Set it up (once)**

1. In Telegram open **@BotFather** → `/newbot` → choose a name → copy the **token**.
2. Put it in `.env`: `TELEGRAM_BOT_TOKEN=…`. Open your new bot in Telegram, press **Start** and send "hi".
3. Run `npm run telegram:setup -- --save --test` — it finds your chat, writes `TELEGRAM_CHAT_ID` into `.env` and sends a test message.
4. Try it: `npm run digest -- --dry` (shows the message, sends nothing), then `npm run digest` (sends it).
5. To have it arrive by itself, deploy (see *Put it online*) and add these in Vercel → Settings → Environment Variables: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `MONGODB_URI` and **`CRON_SECRET`** (any long random text, e.g. `openssl rand -hex 24`; Vercel sends it to the job automatically, and without it nobody can trigger the endpoint). Optional: `APP_URL` (adds an "Open StockSense" link), `DIGEST_MARKETS` (`IN`, `US` or `IN,US`). Then redeploy.

**When it runs.** `vercel.json` schedules `/api/cron/digest` at `30 4 * * 1-5` (UTC) = **10:00 IST, Monday–Friday**. On Vercel's free (Hobby) plan a daily job runs at some point *within* that hour, so expect it between 10:00 and 10:59 IST; change the time by editing the schedule (UTC). Intraday signals need about 30 minutes of trading, so don't schedule it before ~09:45 IST — if it does run too early, or on a holiday, the digest says so honestly and still sends the long-term ideas. To test on the live site, use Vercel → Settings → Cron Jobs → **Run**. You can also run it from your own computer with `npm run digest` (e.g. from `cron` or macOS `launchd`).

- Sent **once per market per day** (a guard in the database stops duplicates when the scheduler retries); `?force=1` overrides it. Each morning's scan and the ideas it sent (with their levels) are saved in MongoDB (`digests` collection).
- The bot token is a password: it lives only in `.env` / Vercel, never in logs or error messages.
- Signals come from price charts only — they say nothing about a company's profits, debt or valuation. Not investment advice; always use the stop-loss.

## 📊 How good are the signals? (read this first)

`npm run backtest` replays the app's own rules on past prices and writes `public/evidence.json`, which the app shows beside its picks. It only uses data available at each moment, buys at the next candle, assumes the stop is hit first when one candle touches both, takes off costs (intraday 0.10%, delivery 0.25% a round trip) and compares each pick with buying *any* stock at the same moment.

Results of the run of 27 Nov 2026 (intraday: 55 sessions; short term: 4 years; 30 NSE large caps):

| Rule | Result | Verdict |
|---|---|---|
| Any plain intraday buy signal, tight stop | 1,322 trades, −0.07% a trade | Lost money — no longer recommended |
| Intraday, passes every check (wide stop, held to the close) | 78 trades, +0.44% a trade, 63% winners | Slightly positive, **not proven** (too few trades) |
| Daily Buy / Strong Buy | 1,392 trades, +0.12%; negative since mid-2025 | No reliable edge |
| Short-term list (Strong Buy, above 200-day, RSI < 70) | 938 trades, +0.30% a trade, 45% winners | Slightly positive, **not proven** |
| Long-term top 5, held 1 year | +11.8% vs +13.0% for holding all 30 | **Did not beat** holding everything |

Several extra short-term filters looked good on older data and lost money on recent data, so they were **not** adopted. Limits: past results do not predict the future; the stock list is today's large companies (survivorship bias); 60 days of 5-minute data is one short market period. Re-run the test now and then, and do not tune rules until they look good on all of the past — that is how a rule stops working on the future.

Two rules changed because of the test: only stocks passing **every** check are put forward for intraday, and the intraday stop is **twice** as far as the nearest support (the tight stop was hit about twice as often), with the position closed by the end of the day.

**Data fix:** the provider sometimes returns the latest daily candle without a closing price. It used to be dropped and the live price written over the day before, which could show a falling stock as rising. The candle is now completed from the live quote.

## Features

| Tab | What it does |
|---|---|
| 🎯 Final Picks | Intraday, short-term and long-term picks on one page, each with the test evidence, buy zone, stop, number of shares for your risk limit, a headline screen (held back if serious), and a 12-point *before you buy* checklist. |
| 🔎 Stock Check | For **any** stock, especially one that just fell: how unusual the day was, whether the market fell too, volume, broken support / averages, what happened after similar falls over ~5 years, news, a plain verdict (do not buy more / wait / trend intact), what to wait for, an "I already own it" calculator (including what averaging down really does) and a stop outside normal daily noise. |
| Dashboard | Indices (NIFTY, SENSEX, Bank Nifty, VIX / S&P, NASDAQ, Dow, VIX), market mood, best setups, top gainers/losers, headlines. Auto-refreshes every 5 min. |
| Analyse | **Live candlestick chart** (1 min / 5 min / 15 min / 1 hour / Daily) that updates every 5–10 s while the market is open, with a LIVE badge, pause button and live header price. Chart overlays: 20/50/200-bar averages, Bollinger Bands, support/resistance, trade-plan lines, RSI and MACD. Signal score (−100…+100), entry zone, stop-loss, 2 targets, risk:reward, plain-English explanation of every indicator, an **Intraday view** card (VWAP, opening range, relative volume, intraday plan and best-of-the-best checklist), position-size calculator, stock news. |
| Top Picks | Scans 30 large caps per market. Ranks by short-term setup score or long-term trend strength. Filters include **⭐ Strong Buy** (score +50 or more). |
| 📲 Telegram digest | The Final Picks, sent on weekday mornings (see above). |
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

Computed on 5-minute candles (last 5 sessions) in `lib/intraday.js`. Ten factors give a −100…+100 score: price vs **VWAP**, **opening-range** (first 15 min) breakout, 9 vs 21 EMA, RSI, MACD, relative volume (vs the same clock time on earlier days), change vs yesterday's close, yesterday's high/low, the last hour's high/low structure and position in today's range. Each stock is then placed in one scenario, and gets a long trade plan (the setup is judged on the risk to the nearest structure / VWAP; the stop you use is twice as far, the optional target twice that risk, and the exit is the end of the day).

A stock **passes every check** only if all of these hold: intraday Strong Buy · a buy scenario · above VWAP · 9 EMA above 21 EMA · volume ≥ 1.2× normal · RSI 50–75 · room to run before yesterday's high / pivots · daily chart is Buy or Strong Buy · the index is not falling · at least 45 minutes left (when the market is open). When nothing passes, the page says so and lists the closest candidates with what is missing — "no trade" is a valid answer.

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
lib/scan.js          the intraday market scan shared by the website and the digest
lib/digest.js        picks and words the morning digest (pure, tested)
lib/digest-job.js    runs it: scan → message → Telegram, once a day
lib/telegram.js      Telegram Bot API sender (token never logged)
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

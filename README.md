# StockSense — beginner-friendly stock analyser

Live market dashboard, Buy/Hold/Sell signals, entry / stop-loss / target levels, top picks, watchlist and news with sentiment — for **India (NSE/BSE)** and **US** markets.

> Educational tool, not financial advice. Signals are rule-based and can be wrong.

## Run it

Needs Node.js 18+ (no `npm install` required — zero dependencies).

- Double-click **`start.bat`**, or
- `npm start` (opens the browser) / `node server.js`

Then open http://localhost:3000. If port 3000 is busy it picks the next free one.

`npm test` runs the unit tests (on Node 22+ use `node --test test/*.test.js` if `npm test` complains about the `test/` folder).

## Features

| Tab | What it does |
|---|---|
| Dashboard | Indices (NIFTY, SENSEX, Bank Nifty, VIX / S&P, NASDAQ, Dow, VIX), market mood, best setups, top gainers/losers, headlines. Auto-refreshes every 5 min. |
| Analyse | **Live candlestick chart** (1 min / 5 min / 15 min / 1 hour / Daily) that updates every 5–10 s while the market is open, with a LIVE badge, pause button and live header price. Chart overlays: 20/50/200-bar averages, Bollinger Bands, support/resistance, trade-plan lines, RSI and MACD. Signal score (−100…+100), entry zone, stop-loss, 2 targets, risk:reward, plain-English explanation of every indicator, an **Intraday view** card (VWAP, opening range, relative volume, intraday plan and best-of-the-best checklist), position-size calculator, stock news. |
| Top Picks | Scans 30 large caps per market. Ranks by short-term setup score or long-term trend strength. Filters include **⭐ Strong Buy** (score +50 or more). |
| ⚡ Intraday | The intraday desk, on 5-minute candles. **🏆 Best of the best** — the intraday BUY picks that pass *every* check (shown separately, with a pass/fail checklist, buy zone, stop-loss and targets). **⭐ Strong Buy stocks** — one list from the daily chart (swing) and one from the live 5-minute chart. **🔍 Every scenario** — all 30 stocks sorted into 14 scenarios (opening-range breakout, gap-up holding / fading, gap-down reversal, pullback to VWAP, steady uptrend / downtrend, overextended, range-bound, low volume …) with filters. Shows market direction (index) and time left in the session. Auto-refreshes every minute while the market is open. |
| Watchlist | Saved in your browser. |
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

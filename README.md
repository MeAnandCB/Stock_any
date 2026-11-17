# StockSense — beginner-friendly stock analyser

Live market dashboard, Buy/Hold/Sell signals, entry / stop-loss / target levels, top picks, watchlist and news with sentiment — for **India (NSE/BSE)** and **US** markets.

> Educational tool, not financial advice. Signals are rule-based and can be wrong.

## Run it

Needs Node.js 18+ (no `npm install` required — zero dependencies).

- Double-click **`start.bat`**, or
- `npm start` (opens the browser) / `node server.js`

Then open http://localhost:3000. If port 3000 is busy it picks the next free one.

`npm test` runs the unit tests.

## Features

| Tab | What it does |
|---|---|
| Dashboard | Indices (NIFTY, SENSEX, Bank Nifty, VIX / S&P, NASDAQ, Dow, VIX), market mood, best setups, top gainers/losers, headlines. Auto-refreshes every 5 min. |
| Analyse | **Live candlestick chart** (1 min / 5 min / 15 min / 1 hour / Daily) that updates every 5–10 s while the market is open, with a LIVE badge, pause button and live header price. Chart overlays: 20/50/200-bar averages, Bollinger Bands, support/resistance, trade-plan lines, RSI and MACD. Signal score (−100…+100), entry zone, stop-loss, 2 targets, risk:reward, plain-English explanation of every indicator, position-size calculator, stock news. |
| Top Picks | Scans 30 large caps per market. Ranks by short-term setup score or long-term trend strength. |
| Watchlist | Saved in your browser. |
| News | Market or topic news with positive/negative headline tagging. |
| Academy | A 22-class course from beginner to advanced in **English and Malayalam (മലയാളം)**: how the market works, opening an account, how to buy and sell, reading candles, trends, support/resistance, indicators, chart analysis routine, entry, stop-loss, exits, risk management, psychology, fundamentals and strategies. Diagrams, a quiz per class, progress tracking and "try it" links into live charts. |
| Glossary | Beginner rules and glossary. |

Search accepts company names ("infosys") or symbols. In India mode, `RELIANCE` resolves to `RELIANCE.NS` automatically.

## How signals work

10 factors are scored and weighted: price vs 200/50-day average, 50/200 alignment (golden/death cross), 20 vs 50-day, RSI, MACD (and fresh crossovers), Bollinger Bands, volume confirmation, 1-month momentum and candlestick patterns (engulfing, hammer, shooting star, doji).

Stop-loss sits just below the nearest swing-low support (bounded by 0.75–3 × ATR); targets use the next resistance levels or 2R / 3R multiples.

## Data sources

- Prices & search: Yahoo Finance public chart/search endpoints (may be ~15 min delayed).
- News: Google News RSS (fallback: Yahoo Finance).

Unofficial endpoints can change or rate-limit; the server retries, caches (3 min prices, 5 min news) and serves the last good data if the provider is temporarily down.

## Project layout

```
server.js            HTTP server + API routes
lib/yahoo.js         data fetching, caching, retries, normalisation
lib/indicators.js    SMA, EMA, RSI, MACD, Bollinger, ATR, pivots
lib/analysis.js      scoring, levels, trade plan, summaries
lib/news.js          Google News RSS parser
lib/sentiment.js     headline sentiment
lib/universe.js      indices and stock lists per market
public/              UI (index.html, app.js, styles.css)
public/academy.js    course engine (curriculum, diagrams, quizzes, progress)
public/academy/      lesson text: lessons-en-*.js and lessons-ml-*.js (same ids in both)
test/                unit tests (node --test)
```

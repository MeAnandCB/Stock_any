// Stocks scanned for "Top Picks" and market breadth. Large, liquid companies
// only — these are the most suitable for beginners.

export const MARKETS = {
  IN: {
    label: 'India (NSE)',
    currency: 'INR',
    newsQuery: 'Sensex Nifty share market',
    indices: [
      { symbol: '^NSEI', name: 'NIFTY 50' },
      { symbol: '^BSESN', name: 'SENSEX' },
      { symbol: '^NSEBANK', name: 'NIFTY BANK' },
      { symbol: '^INDIAVIX', name: 'India VIX (fear gauge)', isVix: true },
    ],
    stocks: [
      'RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'ICICIBANK.NS', 'INFY.NS', 'BHARTIARTL.NS', 'ITC.NS', 'SBIN.NS',
      'LT.NS', 'HINDUNILVR.NS', 'KOTAKBANK.NS', 'AXISBANK.NS', 'BAJFINANCE.NS', 'MARUTI.NS', 'SUNPHARMA.NS',
      'TITAN.NS', 'ASIANPAINT.NS', 'ULTRACEMCO.NS', 'WIPRO.NS', 'HCLTECH.NS', 'NTPC.NS', 'POWERGRID.NS',
      'ONGC.NS', 'M&M.NS', 'TATASTEEL.NS', 'NESTLEIND.NS', 'JSWSTEEL.NS', 'COALINDIA.NS', 'TECHM.NS', 'ADANIPORTS.NS',
    ],
  },
  US: {
    label: 'United States',
    currency: 'USD',
    newsQuery: 'stock market Wall Street',
    indices: [
      { symbol: '^GSPC', name: 'S&P 500' },
      { symbol: '^IXIC', name: 'NASDAQ' },
      { symbol: '^DJI', name: 'Dow Jones' },
      { symbol: '^VIX', name: 'VIX (fear gauge)', isVix: true },
    ],
    stocks: [
      'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'BRK-B', 'JPM', 'V', 'UNH', 'XOM', 'JNJ', 'WMT',
      'MA', 'PG', 'HD', 'COST', 'AVGO', 'LLY', 'NFLX', 'AMD', 'KO', 'PEP', 'BAC', 'DIS', 'ADBE', 'CRM', 'ORCL', 'CSCO',
    ],
  },
};

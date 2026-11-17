// News from Google News RSS (free, no API key, good coverage for Indian and US
// stocks). Falls back to Yahoo Finance search news when unavailable.
import { cached, search, AppError } from './yahoo.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
};

export function parseRss(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = m[1];
    let title = tag(body, 'title');
    const publisher = tag(body, 'source');
    const link = tag(body, 'link');
    const pub = Date.parse(tag(body, 'pubDate'));
    if (publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -(publisher.length + 3));
    if (!title || !/^https?:\/\//i.test(link)) continue;
    items.push({ title, publisher, link, time: Number.isFinite(pub) ? pub : null, tickers: [] });
  }
  return items;
}

// "Reliance Industries Limited" -> "Reliance Industries"
export function newsNameFor(name) {
  return String(name || '')
    .replace(/\b(limited|ltd\.?|inc\.?|incorporated|corporation|corp\.?|plc|company|co\.|holdings?|the)\b/gi, '')
    .replace(/[,.]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function googleNews(query, market) {
  const region = market === 'IN' ? 'hl=en-IN&gl=IN&ceid=IN:en' : 'hl=en-US&gl=US&ceid=US:en';
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:7d`)}&${region}`;
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (StockSense)' }, signal: AbortSignal.timeout(10000) });
  } catch {
    throw new AppError('Could not reach the news provider.', 503, true);
  }
  if (!res.ok) throw new AppError(`News provider returned HTTP ${res.status}.`, 502, true);
  return parseRss(await res.text());
}

export function getNews(query, market) {
  const q = String(query).trim().slice(0, 80);
  return cached(`news:${market}:${q.toLowerCase()}`, 5 * 60 * 1000, async () => {
    let items = [];
    for (let attempt = 0; attempt < 2 && !items.length; attempt++) {
      try {
        items = await googleNews(q, market);
      } catch {
        items = [];
        if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (!items.length) {
      const { news } = await search(q, { quotesCount: 0, newsCount: 15 });
      items = news;
    }
    // De-duplicate by title and keep the newest first.
    const seen = new Set();
    return items
      .filter((n) => {
        const k = n.title.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
      .slice(0, 20);
  });
}

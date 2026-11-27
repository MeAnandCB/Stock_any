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

// ---------- news about one company ----------

// Words a headline must contain to count as news about this company, e.g. TCS -> ["TCS", "Tata Consultancy"].
export function newsKeywordsFor(chart) {
  const base = chart.symbol.replace(/^\^/, '').replace(/\.(NS|BO)$/i, '');
  const words = newsNameFor(chart.name).split(' ').filter(Boolean);
  const name = words.slice(0, words.length > 1 ? 2 : 1).join(' ');
  // "RELIANCE" would also match Reliance Power etc., so require the fuller name.
  const baseIsFirstWord = words.length > 1 && base.toLowerCase() === words[0].toLowerCase();
  return [...new Set([baseIsFirstWord ? '' : base, name].filter((k) => k && k.length >= 2))];
}

export function newsQueryFor(chart) {
  const name = newsNameFor(chart.name) || chart.symbol;
  if (chart.symbol.startsWith('^')) return name;
  const base = chart.symbol.replace(/\.(NS|BO)$/i, '');
  const word = chart.currency === 'INR' ? 'share' : 'stock';
  return base.toLowerCase() === name.toLowerCase() ? `"${name}" ${word}` : `("${name}" OR ${base}) ${word}`;
}

const keywordRegexes = (keywords) => keywords.map((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
export const mentions = (items, keywords) => {
  const res = keywordRegexes(keywords);
  return items.filter((n) => res.some((r) => r.test(n.title)));
};
export function filterRelevant(items, keywords) {
  if (!keywords.length) return items;
  const hits = mentions(items, keywords);
  return hits.length >= 3 ? hits : items; // fall back if the filter is too strict
}

// ---------- screening headlines before a buy ----------
// A keyword scan, not comprehension: it tells you which headlines to READ. It can miss bad news and it can
// flag harmless headlines.
const SERIOUS = /\b(fraud|scam|raid(s|ed)?|money[- ]laundering|insider trading|forensic audit|auditors? (resigns?|quits?)|defaults?|defaulted|insolvency|bankruptcy|arrest(s|ed)?|charge ?sheet|show[- ]cause|sebi (order|notice|probe|ban|action|bars?)|probe[sd]?|investigat\w+|whistle[- ]?blower|accounting irregularit\w+|enforcement directorate)\b/i;
const NEGATIVE = /\b(downgrad\w+|cuts? (target|rating|guidance|price target)|target( price)? (cut|lowered|slashed)|penalty|penalised|penalized|tax (demand|notice)|gst (demand|notice)|lawsuit|sued|plunge[sd]?|crash(es|ed)?|slump(s|ed)?|tumble[sd]?|tank(s|ed)|nosedive\w*|sinks?|slides?|slips?|falls? \d|drops? \d|(profit|revenue|margin|sales)s? (falls?|drops?|declines?|slips?|dips?|shrinks?|misses)|miss(es|ed)? (estimates?|expectations?)|loss widens?|resigns?|resigned|resignation|steps? down|layoffs?|job cuts|stake sale|block deal|offloads?|sell[- ]?off|warning|weak (results?|guidance|outlook|quarter)|recall(s|ed)?|pledge[sd]?)\b/i;
const EVENT = /\b(results?|earnings|board meet\w*|dividend|bonus (issue|share\w*)|stock split|agm|egm|merger|demerger|acqui\w+|buy ?back|record date|rights issue|qip|fund ?rais\w+)\b/i;

export function screenNews(items, now = Date.now(), { days = 5 } = {}) {
  const recent = (items ?? []).filter((n) => !n.time || now - n.time <= days * 86400000);
  const pick = (re) => recent.filter((n) => re.test(n.title));
  const serious = pick(SERIOUS);
  const negative = pick(NEGATIVE).filter((n) => !serious.includes(n));
  const events = pick(EVENT);
  const level = !recent.length ? 'none' : serious.length ? 'red' : negative.length ? 'amber' : 'clear';
  return { level, days, checked: recent.length, serious: serious.slice(0, 5), negative: negative.slice(0, 5), events: events.slice(0, 4), headlines: recent.slice(0, 8) };
}

// Recent headlines that really mention this company, already screened. Never throws.
export async function stockNews(chart, market, now = Date.now()) {
  try {
    const items = await getNews(newsQueryFor(chart), market);
    return screenNews(mentions(items, newsKeywordsFor(chart)), now);
  } catch (e) {
    return { level: 'unavailable', checked: 0, serious: [], negative: [], events: [], headlines: [], error: e.message };
  }
}

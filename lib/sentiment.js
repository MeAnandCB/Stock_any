// Very simple headline sentiment: counts positive vs negative finance words.
// It's a rough guide, not a substitute for reading the article.

const POSITIVE = new Set([
  'surge', 'surges', 'surged', 'soar', 'soars', 'soared', 'jump', 'jumps', 'jumped', 'rally', 'rallies', 'rallied',
  'gain', 'gains', 'gained', 'beat', 'beats', 'record', 'upgrade', 'upgrades', 'upgraded', 'profit', 'profits',
  'growth', 'grows', 'strong', 'stronger', 'bullish', 'rise', 'rises', 'rising', 'rose', 'outperform', 'outperforms',
  'boost', 'boosts', 'wins', 'win', 'approval', 'approved', 'expands', 'expansion', 'dividend', 'rebound', 'rebounds',
  'climbs', 'climb', 'optimism', 'optimistic', 'buyback', 'upbeat', 'tops', 'highs', 'recovery', 'recovers', 'positive',
]);
const NEGATIVE = new Set([
  'fall', 'falls', 'fell', 'drop', 'drops', 'dropped', 'plunge', 'plunges', 'plunged', 'slump', 'slumps', 'crash',
  'crashes', 'miss', 'misses', 'missed', 'loss', 'losses', 'downgrade', 'downgrades', 'downgraded', 'weak', 'weaker',
  'bearish', 'decline', 'declines', 'declined', 'cut', 'cuts', 'lawsuit', 'probe', 'fraud', 'layoffs', 'layoff',
  'warning', 'warns', 'concern', 'concerns', 'slowdown', 'tumble', 'tumbles', 'sinks', 'sink', 'slides', 'slide',
  'lows', 'fears', 'fear', 'selloff', 'sell-off', 'recession', 'default', 'penalty', 'scam', 'negative', 'underperform',
]);

export function scoreHeadline(text) {
  const words = String(text).toLowerCase().match(/[a-z][a-z-]*/g) ?? [];
  let score = 0;
  for (let i = 0; i < words.length; i++) {
    const negated = i > 0 && ['not', 'no', "isn't", 'fails'].includes(words[i - 1]);
    if (POSITIVE.has(words[i])) score += negated ? -1 : 1;
    else if (NEGATIVE.has(words[i])) score += negated ? 1 : -1;
  }
  const label = score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
  return { score, label };
}

export function aggregate(items) {
  const counts = { positive: 0, negative: 0, neutral: 0 };
  for (const it of items) counts[it.sentiment?.label ?? 'neutral']++;
  const total = items.length;
  const net = total ? (counts.positive - counts.negative) / total : 0;
  const mood = net > 0.15 ? 'positive' : net < -0.15 ? 'negative' : 'neutral';
  return { ...counts, total, mood };
}

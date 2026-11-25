// Tiny in-memory rate limiter: at most `max` hits per `windowMs` for each key (e.g. an IP address).
// Per server process — on serverless hosts each warm instance counts separately, which is still
// enough to stop casual abuse. The sync code itself (120 bits) is what keeps data private.
export function createLimiter({ max, windowMs, now = () => Date.now() }) {
  const entries = new Map();
  const prune = (t) => {
    if (entries.size < 5000) return;
    for (const [k, e] of entries) if (e.reset <= t) entries.delete(k);
  };
  return {
    // Returns true while the key is within its allowance.
    hit(key) {
      const t = now();
      const e = entries.get(key);
      if (!e || e.reset <= t) {
        prune(t);
        entries.set(key, { count: 1, reset: t + windowMs });
        return max >= 1;
      }
      e.count++;
      return e.count <= max;
    },
    clear: () => entries.clear(),
  };
}

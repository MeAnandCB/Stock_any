// Run `fn` over `items` with at most `limit` in flight. Never rejects:
// each result is { ok: true, value } or { ok: false, error }.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const SYMBOL_RE = /^[A-Z0-9.\-^=&]{1,25}$/;

export function cleanSymbol(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  return SYMBOL_RE.test(s) ? s : null;
}

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

// Read a request body up to `limit` bytes. A body that is too large is thrown away (not buffered) and
// rejected with { status: 413 } once it has been received, so the browser gets a readable answer
// instead of a dropped connection. Anything absurdly large (8x the limit) is cut off.
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
      else if (size > limit * 8) req.destroy();
    });
    req.on('end', () => {
      if (size > limit) reject(Object.assign(new Error('That is too much data to back up at once.'), { status: 413 }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

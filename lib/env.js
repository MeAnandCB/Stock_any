// Minimal .env loader (the project avoids a dotenv dependency). Real environment
// variables always win over the file, so hosting dashboards (Vercel etc.) keep working.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, ''); // trailing comment on an unquoted value
    out[m[1]] = value;
  }
  return out;
}

// Returns the names that were set from the file (never their values).
export function loadEnv(file = DEFAULT_FILE) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return []; // no .env file is perfectly normal
  }
  const set = [];
  for (const [k, v] of Object.entries(parseEnv(text))) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      set.push(k);
    }
  }
  return set;
}

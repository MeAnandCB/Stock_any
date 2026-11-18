// Vercel serves ./public from its CDN. The browser also imports two shared
// modules from /lib (server.js exposes them locally), so copy them into
// public/lib at build time.
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'lib');
await mkdir(out, { recursive: true });
for (const f of ['indicators.js', 'paper.js']) {
  await copyFile(path.join(root, 'lib', f), path.join(out, f));
}
console.log('Copied shared modules to public/lib');

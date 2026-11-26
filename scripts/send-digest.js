// Send the morning digest to Telegram right now:  npm run digest
//   --dry          print the message instead of sending it
//   --market=US    market to use (default IN, or DIGEST_MARKETS from .env)
//   --force        send even if today's digest was already sent
import { loadEnv } from '../lib/env.js';
import { runDigest } from '../lib/digest-job.js';
import { closeDb } from '../lib/db.js';
import { MARKETS } from '../lib/universe.js';

loadEnv();
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const force = args.includes('--force');
const given = args.find((a) => a.startsWith('--market='))?.split('=')[1];
const markets = [...new Set((given ? [given] : String(process.env.DIGEST_MARKETS || 'IN').split(',')).map((m) => m.trim().toUpperCase()))].filter((m) => MARKETS[m]);
if (!markets.length) {
  console.error('Unknown market. Use --market=IN or --market=US.');
  process.exit(1);
}

let failed = false;
for (const market of markets) {
  try {
    const r = await runDigest({ market, dry, force });
    if (dry) {
      console.log(`----- ${market} (not sent) -----\n${r.messages.join('\n\n— next message —\n\n').replace(/<\/?(b|i|a)[^>]*>/g, '')}\n`);
    } else if (r.sent) {
      console.log(`✔ ${market}: digest sent to Telegram (${r.messages.length} message${r.messages.length === 1 ? '' : 's'}; intraday: ${r.intraday.join(', ') || 'none'}; long-term: ${r.longTerm.join(', ') || 'none'})`);
    } else {
      console.log(`– ${market}: not sent — ${r.reason}`);
    }
  } catch (e) {
    failed = true;
    console.error(`✘ ${market}: ${e.message}`);
  }
}
await closeDb();
process.exit(failed ? 1 : 0);

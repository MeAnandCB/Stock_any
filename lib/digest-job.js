// Run the morning digest: scan the market, build the message, send it to Telegram.
// Used by the scheduled endpoint (/api/cron/digest) and by `npm run digest`.
import { runIntradayScan } from './scan.js';
import { selectCandidates, applyNews } from './final.js';
import { stockNews } from './news.js';
import { mapLimit } from './util.js';
import { persistBoard } from './store.js';
import { buildDigest, localDate } from './digest.js';
import { sendAll, telegramConfigured } from './telegram.js';
import { getDb, dbEnabled } from './db.js';
import { AppError } from './yahoo.js';

// "Already sent today?" guard. Cron systems can fire twice and people re-run things, so a digest is
// claimed in the database before it is sent (one document per market per day). Without a database
// there is no guard — and a database problem never blocks the digest.
async function claim(id, now, injected) {
  if (!injected && !dbEnabled()) return 'no-db';
  try {
    const db = injected ?? (await getDb());
    await db.collection('digests').insertOne({ _id: id, claimedAt: new Date(now) });
    return 'claimed';
  } catch (e) {
    return e?.code === 11000 ? 'duplicate' : 'no-db';
  }
}
const quietly = async (fn) => {
  try {
    await fn();
  } catch {
    /* bookkeeping only */
  }
};

// Options (all optional): market 'IN'|'US'; dry = build the message but send nothing; force = send even if
// today's digest was already sent. `scan`, `send`, `db` are for tests.
export async function runDigest({ market = 'IN', dry = false, force = false, now = Date.now(), scan = null, send = sendAll, db = null } = {}) {
  if (!dry && send === sendAll && !telegramConfigured()) {
    throw new AppError('Telegram is not set up: add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (run "npm run telegram:setup" for help).', 503);
  }
  const result = await (scan ? scan(market) : runIntradayScan(market));
  if (!scan) await persistBoard(result); // the morning scan goes into the saved history as well

  // Read the headlines of every candidate, so a stock with serious news is not sent to your phone.
  let picks = null;
  if (!scan) {
    const candidates = selectCandidates(result, now);
    const wanted = new Map([...candidates.intraday, ...candidates.swing, ...candidates.long].map((it) => [it.symbol, it]));
    const screens = await mapLimit([...wanted.values()], 4, (it) => stockNews(it, market, now));
    picks = applyNews(candidates, new Map([...wanted.keys()].map((symbol, i) => [symbol, screens[i].ok ? screens[i].value : null])));
  }

  const digest = buildDigest(result, now, { picks });
  const summary = {
    market,
    state: digest.state,
    intraday: digest.intraday.map((it) => it.symbol),
    swing: digest.swing.map((it) => it.symbol),
    longTerm: digest.longTerm.map((it) => it.symbol),
    messages: digest.messages,
  };
  if (dry) return { ...summary, sent: false, dry: true };

  const id = `${market}:${localDate(now, market)}`;
  const guard = force ? 'forced' : await claim(id, now, db);
  if (guard === 'duplicate') return { ...summary, sent: false, reason: 'already sent today (use force=1 to send again)' };
  try {
    await send(digest.messages);
  } catch (e) {
    if (guard === 'claimed') await quietly(async () => (db ?? (await getDb())).collection('digests').deleteOne({ _id: id })); // allow a retry
    throw e;
  }
  if (guard === 'claimed') {
    await quietly(async () => {
      const sentIdeas = digest.intraday.map((it) => ({ symbol: it.symbol, price: it.price, entry: it.intraday.plan.entry, stopLoss: it.intraday.plan.stopLoss, target1: it.intraday.plan.target1, target2: it.intraday.plan.target2 }));
      await (db ?? (await getDb())).collection('digests').updateOne({ _id: id }, { $set: { market, sentAt: new Date(now), state: digest.state, intraday: sentIdeas, swing: summary.swing, longTerm: summary.longTerm } });
    });
  }
  return { ...summary, sent: true };
}

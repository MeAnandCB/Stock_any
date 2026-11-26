// Helps connect StockSense to your Telegram bot:  npm run telegram:setup
//   (needs TELEGRAM_BOT_TOKEN in .env — create the bot with @BotFather first)
//   --save   write TELEGRAM_CHAT_ID into .env for you
//   --test   send a "connected" message to your chat
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/env.js';
import { callTelegram, sendTelegram } from '../lib/telegram.js';

loadEnv();
const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
const save = process.argv.includes('--save');
const test = process.argv.includes('--test');
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();

if (!token) {
  console.log(`
No TELEGRAM_BOT_TOKEN found. Create your bot first (about a minute):

  1. In Telegram, open a chat with  @BotFather  and send:  /newbot
  2. Choose a name and a username (it must end in "bot").
  3. BotFather replies with a token like  123456789:AA...  — put it in the .env file:
         TELEGRAM_BOT_TOKEN=123456789:AA...
  4. Run  npm run telegram:setup  again.
`);
  process.exit(1);
}

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

let me;
try {
  const { res, body } = await callTelegram('getMe', {});
  if (!res.ok || !body?.ok) fail(`Telegram did not accept this token (${body?.description || `HTTP ${res.status}`}). Copy it again from @BotFather.`);
  me = body.result;
} catch (e) {
  fail(e.message);
}
console.log(`✔ Bot found: @${me.username} (${me.first_name})`);

const { body } = await callTelegram('getUpdates', { timeout: 0, allowed_updates: ['message', 'channel_post', 'my_chat_member'] });
const chats = new Map();
for (const u of body?.result ?? []) {
  const c = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
  if (c) chats.set(String(c.id), c);
}

if (!chats.size) {
  console.log(`
I can't see any chat yet. Telegram only shows chats where someone messaged the bot:

  1. Open  https://t.me/${me.username}  (or search @${me.username} in Telegram)
  2. Press START, then send any message, e.g. "hi"
  3. Run  npm run telegram:setup  again.
`);
  process.exit(1);
}

console.log('\nChats that have messaged your bot:');
for (const [id, c] of chats) console.log(`  ${id}   ${c.type}${c.first_name || c.title ? ` — ${[c.first_name, c.last_name, c.title].filter(Boolean).join(' ')}` : ''}${c.username ? ` (@${c.username})` : ''}`);

const current = process.env.TELEGRAM_CHAT_ID?.trim();
const privateChats = [...chats.values()].filter((c) => c.type === 'private');
const chosen = current && chats.has(current) ? current : privateChats.length === 1 ? String(privateChats[0].id) : chats.size === 1 ? [...chats.keys()][0] : null;

if (!chosen) {
  console.log('\nMore than one chat found. Put the one you want in .env as  TELEGRAM_CHAT_ID=<number>');
} else if (current === chosen) {
  console.log(`\n✔ TELEGRAM_CHAT_ID is already set to ${chosen}.`);
} else if (save) {
  const text = (() => { try { return readFileSync(envFile, 'utf8'); } catch { return ''; } })();
  if (/^\s*TELEGRAM_CHAT_ID\s*=/m.test(text)) console.log(`\nThere is already a TELEGRAM_CHAT_ID line in .env — edit it to:  TELEGRAM_CHAT_ID=${chosen}`);
  else {
    appendFileSync(envFile, `${text && !text.endsWith('\n') ? '\n' : ''}TELEGRAM_CHAT_ID=${chosen}\n`);
    console.log(`\n✔ Saved TELEGRAM_CHAT_ID=${chosen} to .env`);
  }
} else {
  console.log(`\nAdd this line to .env (or re-run with --save to do it for you):\n  TELEGRAM_CHAT_ID=${chosen}`);
}

if (test && chosen) {
  try {
    await sendTelegram('✅ <b>StockSense is connected.</b>\nYour morning digest will arrive here.', { chatId: chosen });
    console.log('✔ Test message sent — check Telegram.');
  } catch (e) {
    fail(`Test message failed: ${e.message}`);
  }
}

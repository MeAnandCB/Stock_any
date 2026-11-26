// Sending messages to Telegram through the Bot API (https://core.telegram.org/bots/api).
//   TELEGRAM_BOT_TOKEN  from @BotFather
//   TELEGRAM_CHAT_ID    your chat with the bot (scripts/telegram-setup.js finds it for you)
// The token is a password: it is never logged, and every error message has it removed.

export const LIMIT = 4000; // Telegram allows 4096 characters per message; keep a margin

export const telegramConfigured = () => Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim());
const apiBase = () => (process.env.TELEGRAM_API_BASE?.trim() || 'https://api.telegram.org').replace(/\/+$/, '');

// Telegram's HTML mode only needs these three characters escaped.
export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Cut a long text into messages of at most `limit` characters, breaking at blank lines, then at line
// ends, so sections stay whole. (A single line longer than the limit is cut as a last resort.)
export function splitMessage(text, limit = LIMIT) {
  const out = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) out.push(cur.replace(/\s+$/, ''));
    cur = '';
  };
  const add = (piece, sep) => {
    if (cur && (cur + sep + piece).length > limit) push();
    cur = cur ? cur + sep + piece : piece;
  };
  for (const block of String(text).split(/\n{2,}/)) {
    if (block.length <= limit) {
      add(block, '\n\n');
      continue;
    }
    push();
    for (const line of block.split('\n')) {
      let l = line;
      while (l.length > limit) {
        add(l.slice(0, limit), '\n');
        push();
        l = l.slice(limit);
      }
      add(l, '\n');
    }
    push();
  }
  push();
  return out;
}

const redact = (msg, token) => {
  let m = String(msg ?? '');
  if (token) m = m.split(token).join('***');
  return m.replace(/bot\d{5,}:[\w-]{20,}/g, 'bot***');
};

// One call to the Bot API. Returns { res, body }. A dropped connection is retried a couple of times (an
// unattended morning job should survive a network blip); if it still fails the error never contains the token.
// (If a connection drops after Telegram already received the message, a retry can deliver it twice —
// a duplicate is better than a missing digest.)
export async function callTelegram(method, payload, { token = process.env.TELEGRAM_BOT_TOKEN?.trim(), fetchImpl = fetch, attempts = 3, pauseMs = 700 } = {}) {
  if (!token) throw Object.assign(new Error('Telegram is not set up: add TELEGRAM_BOT_TOKEN.'), { status: 503 });
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(`${apiBase()}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(15000),
      });
      return { res, body: await res.json().catch(() => null) };
    } catch (e) {
      last = e;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, pauseMs * attempt));
    }
  }
  throw Object.assign(new Error(`Could not reach Telegram: ${redact(last?.cause?.message || last?.message, token)}`), { status: 502 });
}

// Sends one message. Throws an Error (with .status and .telegram) whose text never contains the token.
export async function sendTelegram(text, { token = process.env.TELEGRAM_BOT_TOKEN?.trim(), chatId = process.env.TELEGRAM_CHAT_ID?.trim(), fetchImpl = fetch, retries = 1 } = {}) {
  if (!token || !chatId) throw Object.assign(new Error('Telegram is not set up: add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.'), { status: 503 });
  const { res, body } = await callTelegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }, { token, fetchImpl });
  if (res.ok && body?.ok) return body.result;
  // Telegram asks us to slow down: wait the time it asks for (at most a few seconds) and try once more.
  const wait = Number(body?.parameters?.retry_after);
  if (res.status === 429 && retries > 0 && Number.isFinite(wait)) {
    await new Promise((r) => setTimeout(r, Math.min(wait, 5) * 1000));
    return sendTelegram(text, { token, chatId, fetchImpl, retries: retries - 1 });
  }
  const reason = redact(body?.description || `HTTP ${res.status}`, token);
  const hint = res.status === 401 ? ' (the bot token is wrong)'
    : /chat not found/i.test(reason) ? ' (open your bot in Telegram, press Start / send it a message, then check TELEGRAM_CHAT_ID)'
      : '';
  throw Object.assign(new Error(`Telegram refused the message: ${reason}${hint}`), { status: 502, telegram: body?.error_code ?? res.status });
}

export async function sendAll(messages, opts) {
  for (const m of messages) await sendTelegram(m, opts);
  return messages.length;
}

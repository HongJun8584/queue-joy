// netlify/functions/utils/telegram.js
// Simple wrapper to send Telegram messages using your centralized bot.
// Requires TELeGRAM_BOT_TOKEN in env.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  // Don't throw at import-time in dev; functions using this should handle missing token.
  console.warn('Warning: TELEGRAM_BOT_TOKEN not set.');
}
const API_BASE = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

async function sendTelegramMessage(chatId, text, opts = {}) {
  if (!API_BASE) throw new Error('TELEGRAM_BOT_TOKEN not configured.');
  if (!chatId) throw new Error('chatId required.');

  const body = Object.assign({
    chat_id: String(chatId),
    text: String(text),
    parse_mode: opts.parse_mode || 'HTML',
    disable_web_page_preview: opts.disable_web_page_preview !== undefined ? opts.disable_web_page_preview : false
  }, opts.extra || {});

  // Node 18+ provides global fetch in Netlify functions
  const res = await fetch(`${API_BASE}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const json = await res.json().catch(()=>({ ok:false }));
  if (!res.ok || json.ok === false) {
    const errText = json.description || (`Telegram HTTP ${res.status}`);
    const e = new Error(errText);
    e.raw = json;
    throw e;
  }
  return json;
}

module.exports = { sendTelegramMessage };

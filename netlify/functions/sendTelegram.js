// netlify/functions/sendTelegram.js
// CommonJS, no external deps. Uses global fetch (Node 18+ on Netlify).

const TELEGRAM_API_BASE = "https://api.telegram.org";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed. Use POST." }) };
  }

  let payload;
  try {
    payload = typeof event.body === "string" ? JSON.parse(event.body || "{}") : (event.body || {});
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { message, chatId, chatIds, parseMode, disableNotification, replyMarkup, copyAdmin } = payload;

  if (!message || typeof message !== "string") {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing required field: message (string)" }) };
  }

  const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const ADMIN_CHAT_ID = process.env.CHAT_ID || process.env.ADMIN_CHAT_ID || null;

  if (!BOT_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing BOT_TOKEN environment variable" }) };
  }

  // Build recipients array
  let recipients = [];
  if (Array.isArray(chatIds) && chatIds.length > 0) {
    recipients = chatIds.slice();
  } else if (chatId) {
    recipients = [chatId];
  }

  // fallback to admin chat if nothing provided
  if (recipients.length === 0) {
    if (ADMIN_CHAT_ID) {
      recipients = [ADMIN_CHAT_ID];
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: "No recipient specified and no ADMIN CHAT_ID configured" }) };
    }
  }

  // copy admin if requested
  if (copyAdmin && ADMIN_CHAT_ID) {
    if (!recipients.includes(ADMIN_CHAT_ID)) recipients.push(ADMIN_CHAT_ID);
  }

  const results = [];

  // send sequentially with a short pause to avoid hitting rate limits
  for (let i = 0; i < recipients.length; i++) {
    const to = recipients[i];
    const body = {
      chat_id: to,
      text: message,
    };
    if (parseMode) body.parse_mode = parseMode;
    if (disableNotification !== undefined) body.disable_notification = !!disableNotification;
    if (replyMarkup) body.reply_markup = replyMarkup;

    const url = `${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/sendMessage`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const json = await res.json().catch(() => null);
      if (!res.ok || (json && json.ok === false)) {
        results.push({ to, ok: false, status: res.status, response: json, error: (json && json.description) || `HTTP ${res.status}` });
      } else {
        results.push({ to, ok: true, status: res.status, response: json });
      }
    } catch (err) {
      results.push({ to, ok: false, error: err.message || String(err) });
    }

    if (i < recipients.length - 1) await sleep(200);
  }

  const anySuccess = results.some((r) => r.ok);
  const anyFailure = results.some((r) => !r.ok);

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: anySuccess && !anyFailure ? true : anySuccess ? "partial" : false,
      summary: { total: results.length, success: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length },
      results,
    }),
  };
};

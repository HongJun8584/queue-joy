// /netlify/functions/sendTelegram.js
// CommonJS, no external deps. Uses global fetch (Node 18+ on Netlify).

const TELEGRAM_API_BASE = "https://api.telegram.org";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// sanitize incoming free-form message: remove "Queue: <pushId>" lines and stray push-id tokens
function sanitizeMessage(text) {
  if (!text || typeof text !== 'string') return text || '';
  // remove lines like: "Queue: -OdJlxkAvWnrPU7VSIps" (case-insensitive)
  text = text.replace(/^.*queue:\s*[-A-Za-z0-9_]{6,}.*$/gim, '').trim();
  // remove standalone firebase push ids anywhere (20-ish chars often start with - but use >=8 heuristic)
  text = text.replace(/\b-?[A-Za-z0-9_]{8,}\b/g, '').replace(/\n{2,}/g, '\n').trim();
  return text;
}

function buildFriendlyCalledMessage({ queueId, queueNumber, counterName, baseMessage }) {
  // If caller supplied structured details, prefer them.
  const heading = baseMessage || "🎟 It's now your turn!";
  const lines = [heading];
  if (queueId || queueNumber) {
    const num = queueId || queueNumber;
    lines.push(`🧾 Number • ${num}`);
  }
  if (counterName) lines.push(`🪑 Counter • ${counterName}`);
  return lines.join('\n');
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

  // Accept either message or structured fields:
  // message (string) OR queueId/queueNumber (string) and/or counterName (string)
  const {
    message,
    chatId,
    chatIds,
    parseMode,
    disableNotification,
    replyMarkup,
    copyAdmin,
    queueId,       // friendly number string like "A023"
    queueNumber,   // alias
    counterName,   // friendly name like "4" or "Counter 3"
  } = payload;

  const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const ADMIN_CHAT_ID = process.env.CHAT_ID || process.env.ADMIN_CHAT_ID || null;

  if (!BOT_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing BOT_TOKEN environment variable" }) };
  }

  // Build recipients list
  let recipients = [];
  if (Array.isArray(chatIds) && chatIds.length) recipients = chatIds.slice();
  else if (chatId) recipients = [chatId];

  // fallback to admin chat if nothing provided (keeps previous behavior)
  if (recipients.length === 0) {
    if (ADMIN_CHAT_ID) recipients = [ADMIN_CHAT_ID];
    else return { statusCode: 400, body: JSON.stringify({ error: "No recipient specified and no ADMIN CHAT_ID configured" }) };
  }

  // optionally include admin copy
  if (copyAdmin && ADMIN_CHAT_ID && !recipients.includes(ADMIN_CHAT_ID)) recipients.push(ADMIN_CHAT_ID);

  // dedupe recipients
  recipients = Array.from(new Set(recipients.map(String)));

  // Construct the final text to send:
  let finalText = "";

  // If structured fields present, build a friendly notification (do not show DB keys)
  if (queueId || queueNumber || counterName) {
    finalText = buildFriendlyCalledMessage({ queueId, queueNumber, counterName, baseMessage: message && message.trim() });
  } else if (message && typeof message === 'string') {
    // sanitize any "Queue: <pushId>" or stray push-id tokens
    finalText = sanitizeMessage(message);
    // if sanitization removed everything, fallback to safe text
    if (!finalText) finalText = "🎟 It's now your turn! Please check the status page for details.";
  } else {
    // nothing meaningful provided
    finalText = "🎟 It's now your turn! Please check the status page for details.";
  }

  const results = [];

  // send to each recipient sequentially (polite to Telegram)
  for (let i = 0; i < recipients.length; i++) {
    const to = recipients[i];
    const body = {
      chat_id: to,
      text: finalText,
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

    if (i < recipients.length - 1) await sleep(180);
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

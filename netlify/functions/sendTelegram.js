// /netlify/functions/sendTelegram.js
// Node 18+ (Netlify Functions)
// Purpose: Server-side DM customers when their queue number is called.
// - Does NOT notify admin or log user content to admin chats.
// - Works even if the user's browser is closed (server-side send).
//
// Usage (POST JSON):
// {
//   "to": 123456789,                 // chatId (number) OR "@username" OR numeric string
//   "queueNumber": "A103",           // required
//   "counterName": "Counter 1",      // optional
//   "storeName": "Burger Hub",       // optional
//   "extraMessage": "Please proceed.", // optional
//   "method": "sendMessage",         // optional: sendMessage (default) or sendPhoto
//   "photoUrl": "...",               // required for sendPhoto
//   "disable_web_page_preview": true,// optional
//   "reply_markup": { ... }          // optional (object)
// }

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed — use POST." };
    }

    const BOT_TOKEN = process.env.BOT_TOKEN;
    if (!BOT_TOKEN) {
      console.error("Missing BOT_TOKEN environment variable");
      return { statusCode: 500, body: "Server misconfigured: missing BOT_TOKEN" };
    }

    // Parse body
    let body;
    try {
      body = typeof event.body === "string" ? JSON.parse(event.body) : (event.body || {});
    } catch (err) {
      return { statusCode: 400, body: "Invalid JSON body" };
    }

    // Basic required fields
    const to = body.to ?? body.chatId ?? body.chat_id;
    const queueNumber = body.queueNumber ?? body.queue_number ?? body.queueId;
    if (!to) return { statusCode: 400, body: "Missing required field: to (chatId or @username)" };
    if (!queueNumber) return { statusCode: 400, body: "Missing required field: queueNumber" };

    const method = String((body.method || "sendMessage")).trim();
    const counterName = body.counterName || body.counter_name || "";
    const storeName = body.storeName || body.store_name || "";
    const extraMessage = body.extraMessage || body.extra_message || "";
    const disablePreview = !!body.disable_web_page_preview;
    const replyMarkup = body.reply_markup || body.replyMarkup || null;
    const photoUrl = body.photoUrl || body.photo || null;
    const tgBase = `https://api.telegram.org/bot${BOT_TOKEN}`;

    // Utilities
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const isNumeric = (v) => /^-?\d+$/.test(String(v));

    // Escape dynamic text to prevent HTML injection while using HTML parse_mode.
    const escapeHtml = (str = "") =>
      String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");

    // Resolve chat id if user provided @username or non-numeric identifier.
    async function resolveChatId(toVal) {
      // If numeric -> return as-is
      if (isNumeric(toVal)) return String(toVal);

      const candidate = String(toVal).trim();
      // Accept @username or username without @
      const username = candidate.startsWith("@") ? candidate : (candidate.match(/^@?[\w\d_]+$/) ? `@${candidate}` : null);
      if (!username) {
        // Could be a UUID-like token — not resolvable here
        throw new Error("Invalid 'to' value — must be numeric chatId or @username");
      }

      // Call getChat to resolve
      const url = `${tgBase}/getChat?chat_id=${encodeURIComponent(username)}`;
      const res = await fetch(url);
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || !j.ok || !j.result || !j.result.id) {
        throw new Error(`Failed to resolve username ${username}`);
      }
      return String(j.result.id);
    }

    // Make Telegram request with retries on transient failures
    async function tgRequest(path, payload, tries = 3) {
      let attempt = 0;
      let lastErr = null;
      while (attempt < tries) {
        try {
          const res = await fetch(`${tgBase}/${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const j = await res.json().catch(() => null);
          if (res.ok && j && j.ok) return j;
          // For Telegram API errors (4xx/5xx), treat 5xx as retryable
          const status = res.status;
          lastErr = { status, body: j };
          if (status >= 500 && attempt < tries - 1) {
            // transient server error -> retry
            await sleep(300 * Math.pow(2, attempt)); // exponential backoff
            attempt++;
            continue;
          }
          // non-retryable or final attempt
          throw new Error(`Telegram API error: ${JSON.stringify(j)}`);
        } catch (err) {
          lastErr = err;
          // network-level or other error -> retry
          if (attempt < tries - 1) {
            await sleep(300 * Math.pow(2, attempt));
            attempt++;
            continue;
          }
          throw lastErr;
        }
      }
      throw lastErr;
    }

    // Resolve chat id
    let chatId;
    try {
      chatId = await resolveChatId(to);
    } catch (err) {
      // If resolution fails, return 400 so caller can fix it.
      return { statusCode: 400, body: `Failed to resolve recipient: ${err.message}` };
    }

    // Build friendly message (HTML)
    const header = storeName ? `<b>${escapeHtml(storeName)}</b>` : `<b>Queue Joy</b>`;
    const calledLine = `HEY👋 | Your queue number <b>${escapeHtml(queueNumber)}</b> is now being served${counterName ? ` at <b>${escapeHtml(counterName)}</b>` : ""}.`;
    const extra = extraMessage ? `\n${escapeHtml(extraMessage)}` : "";
    const footer = "\n\nIf you have already left, you can ignore this message. ✅";

    const text = `${header}\n${calledLine}${extra}${footer}`.trim();

    // Compose payload depending on method
    if (method === "sendPhoto") {
      if (!photoUrl) return { statusCode: 400, body: "photoUrl is required for sendPhoto" };
      const payload = {
        chat_id: chatId,
        photo: String(photoUrl),
      };
      // caption uses same formatted text, but Telegram limits caption length ~1024
      payload.caption = text.length > 1000 ? text.slice(0, 980) + "…" : text;
      payload.parse_mode = "HTML";
      if (typeof replyMarkup === "object" && replyMarkup !== null) payload.reply_markup = replyMarkup;
      // Attempt send (with retries)
      const result = await tgRequest("sendPhoto", payload).catch((e) => ({ error: String(e) }));
      if (result && result.error) {
        return { statusCode: 502, body: JSON.stringify({ ok: false, error: result.error }) };
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true, result }) };
    }

    // Default: sendMessage
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: !!disablePreview,
    };
    if (typeof replyMarkup === "object" && replyMarkup !== null) payload.reply_markup = replyMarkup;

    const result = await tgRequest("sendMessage", payload).catch((e) => ({ error: String(e) }));
    if (result && result.error) {
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: result.error }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, result }) };

  } catch (err) {
    console.error("sendTelegram error:", err && err.message ? err.message : err);
    return { statusCode: 500, body: `Internal server error: ${err && err.message ? err.message : String(err)}` };
  }
};

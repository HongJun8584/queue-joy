// netlify/functions/sendTelegram.js
// Uses global fetch (no node-fetch dependency) and works on Netlify Node 18+

export async function handler(event, context) {
  // CORS + JSON headers
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const message = body?.message || body?.text || "";

    if (!message) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Message is required" }) };
    }

    // Use these env var names (set them in Netlify site settings)
    const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
    const CHAT_ID = process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID;

    if (!BOT_TOKEN || !CHAT_ID) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Missing BOT_TOKEN or CHAT_ID in environment variables" }),
      };
    }

    const telegramURL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = {
      chat_id: CHAT_ID,
      text: `📢 QueueJoy Alert:\n${message}`,
      parse_mode: "Markdown"
    };

    // global fetch available on Netlify (Node 18+). No node-fetch required.
    const res = await fetch(telegramURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await res.json();

    if (!res.ok || result?.ok === false) {
      // Telegram rejected it — return error info
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: "Telegram API error", details: result }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, result }),
    };
  } catch (err) {
    console.error("sendTelegram error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Internal Server Error", details: String(err) }),
    };
  }
}

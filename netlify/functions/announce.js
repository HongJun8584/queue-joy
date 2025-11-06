// netlify/functions/announce.js
// Minimal public Telegram announcer
// Requires only BOT_TOKEN and CHAT_ID in environment variables
//
// Test via:
// curl -X POST https://<your-site>.netlify.app/.netlify/functions/announce \
//      -H "Content-Type: application/json" \
//      -d '{"message":"Hello from QueueJoy!"}'

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Only POST method allowed" }),
      };
    }

    const { message } = JSON.parse(event.body || "{}");
    if (!message) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing message field" }),
      };
    }

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHAT_ID = process.env.CHAT_ID;

    if (!BOT_TOKEN || !CHAT_ID) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Missing BOT_TOKEN or CHAT_ID in environment variables",
        }),
      };
    }

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.description || "Telegram API error");
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, sent_to: CHAT_ID, message }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || "Unknown error" }),
    };
  }
}

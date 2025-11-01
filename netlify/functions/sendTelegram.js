// netlify/functions/sendTelegram.js
// Production-ready handler for:
//  - Telegram webhook updates (user clicks your bot link: /start <TOKEN>)
//  - App-triggered notifications: POST { queueKey, queueId }

const admin = require("firebase-admin");

// Initialize Firebase admin only once
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
      databaseURL: process.env.FIREBASE_DB_URL,
    });
    console.log("🔥 Firebase admin initialized");
  } catch (err) {
    console.error("❌ Firebase init error:", err);
  }
}

const db = admin.database();

// Helper: send message via Telegram HTTP API
async function sendTelegramMessage(chatId, text, opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN env");
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: opts.parse_mode || "Markdown",
    disable_web_page_preview: opts.disable_web_page_preview ?? true,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!res.ok || !json.ok) {
    const err = json?.description || `Telegram API error (status ${res.status})`;
    throw new Error(err);
  }
  return json;
}

// Safe DB helpers
async function safeGet(path) {
  try {
    const snap = await db.ref(path).once("value");
    return snap.exists() ? snap.val() : null;
  } catch (e) {
    console.error("DB read failed:", path, e);
    return null;
  }
}

async function safeUpdate(path, data) {
  try {
    await db.ref(path).update(data);
    return true;
  } catch (e) {
    console.error("DB update failed:", path, e);
    return false;
  }
}

exports.handler = async (event, context) => {
  // Always return CORS headers
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    // Only accept POST for both webhook and app-triggered events
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
    }

    // Parse body (Telegram will POST JSON update; frontend posts { queueKey, queueId })
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (err) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
    }

    // ---------- Case A: Telegram webhook update (user clicked bot link) ----------
    // Telegram sends updates with a `message` object containing text and chat.id
    if (body.message && body.message.text) {
      const msg = body.message;
      const chatId = msg.chat && msg.chat.id;
      const text = String(msg.text || "").trim();

      console.log("🔔 Telegram update received:", text, "chatId:", chatId);

      // Expect "/start <TOKEN>"
      if (text.toLowerCase().startsWith("/start")) {
        const parts = text.split(/\s+/);
        const token = parts[1] || parts[0].replace("/start", "");

        if (!token) {
          await sendTelegramMessage(chatId, "❌ No token found. Please re-generate the link from Queue Joy.");
          return { statusCode: 200, headers, body: JSON.stringify({ message: "No token" }) };
        }

        // Check pending token record
        const pending = await safeGet(`telegramPending/${token}`);
        if (!pending) {
          await sendTelegramMessage(chatId, "❌ Invalid or expired link. Please reconnect through Queue Joy.");
          return { statusCode: 200, headers, body: JSON.stringify({ message: "Invalid token" }) };
        }

        const queueKey = pending.queueKey;
        // Update queue record with chatId
        await safeUpdate(`queue/${queueKey}`, {
          telegramChatId: chatId,
          telegramConnected: true,
          telegramLinkedAt: Date.now(),
        });

        // Remove pending token
        try { await db.ref(`telegramPending/${token}`).remove(); } catch (e) { console.warn("Failed to remove pending token", e); }

        // Send welcome message
        await sendTelegramMessage(chatId, "👋 *Connected!* You’ll now receive notifications from Queue Joy.", { parse_mode: "Markdown" });

        return { statusCode: 200, headers, body: JSON.stringify({ message: "Linked" }) };
      }

      // If other Telegram messages are received, ignore or respond
      return { statusCode: 200, headers, body: JSON.stringify({ message: "No-op" }) };
    }

    // ---------- Case B: App-triggered notification ----------
    // Expect payload { queueKey, queueId, name? }
    const { queueKey, queueId, name } = body;
    if (queueKey && queueId) {
      console.log("📢 Notification request for", queueKey, queueId);

      // Read queue data
      const queueData = await safeGet(`queue/${queueKey}`);
      if (!queueData || !queueData.telegramChatId) {
        console.warn("No linked chat for queue:", queueKey);
        return { statusCode: 200, headers, body: JSON.stringify({ message: "No linked Telegram chat" }) };
      }

      const chatId = queueData.telegramChatId;
      const displayName = name || queueData.name || "Customer";

      const text = `🔔 *It’s your turn, ${escapeMarkdown(displayName)}!* 🎟️\n\nQueue number *${escapeMarkdown(String(queueId))}* is now being served — please proceed to the counter.`;
      try {
        const sent = await sendTelegramMessage(chatId, text, { parse_mode: "Markdown" });
        console.log("✅ Sent Telegram message:", sent);
        return { statusCode: 200, headers, body: JSON.stringify({ message: "Notification sent" }) };
      } catch (err) {
        console.error("❌ Telegram send failed:", err.message || err);
        // Optionally notify admin
        if (process.env.ADMIN_CHAT_ID) {
          try { await sendTelegramMessage(process.env.ADMIN_CHAT_ID, `🚨 Failed to notify ${queueKey}: ${err.message}`); } catch(e){/* ignore */ }
        }
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Telegram send failed", details: err.message }) };
      }
    }

    // If we reach here, nothing matched
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Bad request" }) };
  } catch (err) {
    console.error("🔥 Handler error:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Server error", details: String(err) }) };
  }
};

// simple markdown escape for names/numbers (avoid breaking parse_mode)
function escapeMarkdown(text = "") {
  return text.replace(/([_*[\]()`~>#+-=|{}.!])/g, "\\$1");
}

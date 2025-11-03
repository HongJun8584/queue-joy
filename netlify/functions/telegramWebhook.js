// netlify/functions/telegramWebhook.js
// CommonJS version. Handles /start <queueKey>, writes chatId into Firebase RTDB,
// computes simple estimated wait, and replies with a short friendly message.
// Requires env:
//   BOT_TOKEN
//   FIREBASE_SERVICE_ACCOUNT (JSON string)
//   FIREBASE_DB_URL (your RTDB URL, e.g. https://project-id-default-rtdb.firebaseio.com)

const admin = require("firebase-admin");

function safeParseJson(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}
function toInt(n, fallback = NaN) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.trunc(v) : fallback;
}

async function ensureFirebaseInitialized() {
  if (admin.apps && admin.apps.length) return admin.app();
  const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  const dbUrl = process.env.FIREBASE_DB_URL;
  if (!svcJson || !dbUrl) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT or FIREBASE_DB_URL not set in env");
  }
  const cred = safeParseJson(svcJson);
  if (!cred) throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON");
  admin.initializeApp({
    credential: admin.credential.cert(cred),
    databaseURL: dbUrl,
  });
  return admin.app();
}

const TELEGRAM_API_BASE = "https://api.telegram.org";

module.exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let update;
  try {
    update = JSON.parse(event.body || "{}");
  } catch (err) {
    console.error("Invalid JSON body", err);
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  if (!BOT_TOKEN) {
    console.error("Missing BOT_TOKEN");
    return { statusCode: 500, body: "Missing BOT_TOKEN" };
  }

  const msg = update.message || update.edited_message;
  if (!msg || !msg.text || !msg.chat || !msg.chat.id) {
    // ignore non-text updates or missing chat
    return { statusCode: 200, body: "Ignored" };
  }

  const text = String(msg.text).trim();
  const chatId = msg.chat.id;

  // only handle /start <token>
  if (!text.toLowerCase().startsWith("/start")) {
    return { statusCode: 200, body: "Ignored non-start message" };
  }

  const parts = text.split(/\s+/);
  const queueKey = (parts[1] || "").trim();

  try {
    await ensureFirebaseInitialized();
    const db = admin.database();

    // Default reply
    let queueNumber = queueKey ? queueKey.toUpperCase() : "Unknown";
    let counterName = null;
    let estWaitText = "We will notify you when it's your turn.";

    if (queueKey) {
      const qSnap = await db.ref(`queue/${queueKey}`).once("value");
      const qVal = qSnap.exists() ? qSnap.val() : null;

      if (qVal) {
        // save chatId and connected flag
        try {
          await db.ref(`queue/${queueKey}/chatId`).set(chatId);
          await db.ref(`queue/${queueKey}/telegramConnected`).set(true);
        } catch (err) {
          console.warn("Failed to write chatId to Firebase:", err);
        }

        queueNumber = qVal.queueId || queueNumber;

        const counterId = qVal.counterId;
        if (counterId) {
          const cSnap = await db.ref(`counters/${counterId}`).once("value");
          const cVal = cSnap.exists() ? cSnap.val() : null;
          if (cVal) {
            counterName = cVal.name || counterId;

            // avg service time (minutes) fallback chain
            let avgServiceTime = null;
            if (typeof cVal.avgServiceTime === "number") avgServiceTime = cVal.avgServiceTime;
            else if (cVal.avgServiceTime) avgServiceTime = toInt(cVal.avgServiceTime);

            if (!avgServiceTime || !Number.isFinite(avgServiceTime)) {
              const sSnap = await db.ref(`settings/avgServiceTime`).once("value");
              if (sSnap.exists()) avgServiceTime = toInt(sSnap.val());
            }
            if (!avgServiceTime || !Number.isFinite(avgServiceTime)) avgServiceTime = 2;

            // nowServing
            const nowSnap = await db.ref(`counters/${counterId}/nowServing`).once("value");
            const nowServing = nowSnap.exists() ? toInt(nowSnap.val(), 0) : 0;

            // parse numeric part from queueNumber
            const prefix = String(queueNumber).match(/^[A-Za-z]*/)?.[0] || "";
            const numericPart = Number(String(queueNumber).replace(prefix, "")) || NaN;
            const yourNumberNum = Number.isFinite(numericPart) ? numericPart : NaN;
            const peopleAhead = Number.isFinite(yourNumberNum) ? Math.max(0, yourNumberNum - nowServing) : null;

            if (peopleAhead !== null) {
              const estMinutes = peopleAhead * avgServiceTime;
              if (peopleAhead === 0) {
                estWaitText = "You are next — we will notify you now.";
              } else {
                estWaitText = `${peopleAhead} person${peopleAhead > 1 ? "s" : ""} ahead — approx ${estMinutes} min`;
              }
            } else {
              estWaitText = "We will notify you when it's your turn.";
            }
          } // end if cVal
        } // end if counterId
      } else {
        estWaitText = "We couldn't find your queue entry. Re-open the app if needed.";
      }
    } // end if queueKey

    // Build minimal reply (only Hey, number and counter, and relax text)
    const lines = [
      "Hey 👋",
      `🎫 Queue Number: ${queueNumber}`,
      `🏢 Counter: ${counterName || "TBD"}`,
      `⏱️ ${estWaitText}`,
      "",
      "You can leave this page in the background — we'll DM you on Telegram when it's your turn. Make sure Telegram notifications are enabled on your phone. Go play a game and relax 🎮"
    ];
    const replyText = lines.join("\n");

    const telegramUrl = `${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/sendMessage`;
    const sendRes = await fetch(telegramUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: replyText,
      }),
    });

    const sendJson = await sendRes.json().catch(() => null);
    if (!sendRes.ok || (sendJson && sendJson.ok === false)) {
      console.error("Telegram send failed", sendRes.status, sendJson);
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: sendJson || "Telegram send error" }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error("Webhook handler error", err);
    // fallback minimal message without DB (try to notify)
    try {
      if (BOT_TOKEN && chatId) {
        const fallbackText = `Hey 👋\nYou are connected. We'll DM you when it's your turn.`;
        await fetch(`${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: fallbackText }),
        });
      }
    } catch (e) {
      console.warn("fallback send failed", e);
    }
    return { statusCode: 200, body: "OK (error handled)" };
  }
};

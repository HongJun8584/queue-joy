const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');

// ✅ Initialize Firebase once
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: "queue-joy-aa21b",
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      }),
      databaseURL: "https://queue-joy-aa21b-default-rtdb.asia-southeast1.firebasedatabase.app",
    });
    console.log("🔥 Firebase initialized");
  } catch (err) {
    console.error("❌ Firebase init failed:", err);
  }
}

const db = admin.database();
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

// Utility: safe Telegram message sender
async function safeSendMessage(chatId, text, options = {}) {
  if (!chatId) return console.warn("⚠️ Missing chatId, message skipped.");
  try {
    await bot.sendMessage(chatId, text, options);
    console.log(`✅ Sent message to ${chatId}`);
  } catch (err) {
    console.error("❌ Telegram send failed:", err.message || err);
  }
}

// Utility: safe Firebase getter
async function safeGet(refPath) {
  try {
    const snap = await db.ref(refPath).once("value");
    return snap.exists() ? snap.val() : null;
  } catch (err) {
    console.error(`❌ Firebase read failed (${refPath}):`, err);
    return null;
  }
}

// Utility: safe Firebase update
async function safeUpdate(refPath, data) {
  try {
    await db.ref(refPath).update(data);
    console.log(`✅ Updated ${refPath}`);
  } catch (err) {
    console.error(`❌ Firebase update failed (${refPath}):`, err);
  }
}

// ✅ Main Netlify handler
exports.handler = async (event) => {
  // Prevent timeout if tab is backgrounded or Netlify is cold-starting
  context = event.context || {};
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed 🚫" }) };
    }

    const body = JSON.parse(event.body || "{}");
    const { message, queueKey, queueId } = body;

    // ===================================================
    // 1️⃣ HANDLE TELEGRAM CONNECTION (/start TOKEN)
    // ===================================================
    if (message && message.text && message.text.startsWith("/start ")) {
      const token = message.text.split(" ")[1];
      const chatId = message.chat.id;

      console.log("🔗 Connection attempt via token:", token);

      const pendingData = await safeGet(`telegramPending/${token}`);
      if (!pendingData) {
        await safeSendMessage(
          chatId,
          "❌ *Invalid or expired link.*\nPlease go back and reconnect through Queue Joy.",
          { parse_mode: "Markdown" }
        );
        return { statusCode: 200, body: JSON.stringify({ message: "Invalid token" }) };
      }

      const { queueKey } = pendingData;

      // Update user queue with Telegram info
      await safeUpdate(`queue/${queueKey}`, {
        telegramChatId: chatId,
        telegramConnected: true,
        telegramLinkedAt: Date.now(),
      });

      // Remove pending token
      try {
        await db.ref(`telegramPending/${token}`).remove();
      } catch (err) {
        console.error("⚠️ Failed to delete pending token:", err);
      }

      // Send welcome
      await safeSendMessage(
        chatId,
        "👋 *Welcome to Queue Joy!*\n\nYou’re now connected — we’ll notify you here when it’s your turn 🪄",
        { parse_mode: "Markdown" }
      );

      return { statusCode: 200, body: JSON.stringify({ message: "Telegram linked successfully ✅" }) };
    }

    // ===================================================
    // 2️⃣ HANDLE QUEUE NOTIFICATION
    // ===================================================
    if (queueKey && queueId) {
      console.log(`📢 Queue call: ${queueKey} (${queueId})`);

      const queueData = await safeGet(`queue/${queueKey}`);
      if (!queueData || !queueData.telegramChatId) {
        console.warn("⚠️ No Telegram linked for this queue:", queueKey);
        return { statusCode: 200, body: JSON.stringify({ message: "No linked Telegram chat" }) };
      }

      const chatId = queueData.telegramChatId;
      const name = queueData.name || "Customer";

      // Send "your turn" message
      await safeSendMessage(
        chatId,
        `🔔 *It’s your turn, ${name}!* 🎟️\n\nQueue number *${queueId}* is now being served — please proceed to the counter.`,
        { parse_mode: "Markdown" }
      );

      // Optional follow-up reminder after 2 mins
      setTimeout(async () => {
        await safeSendMessage(
          chatId,
          `⏰ Reminder: Your queue number *${queueId}* was called 2 minutes ago.\nIf you’re nearby, please approach the counter.`,
          { parse_mode: "Markdown" }
        );
      }, 120000);

      return { statusCode: 200, body: JSON.stringify({ message: "Notification sent ✅" }) };
    }

    // ===================================================
    // 3️⃣ INVALID REQUEST
    // ===================================================
    return { statusCode: 400, body: JSON.stringify({ error: "Bad request 🚫" }) };
  } catch (err) {
    console.error("💥 Handler error:", err);
    await safeSendMessage(process.env.ADMIN_CHAT_ID, `🚨 *Queue Joy Error!*\n\n${err.message}`, {
      parse_mode: "Markdown",
    });
    return { statusCode: 500, body: JSON.stringify({ error: "Internal server error 💥" }) };
  }
};

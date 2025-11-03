// netlify/functions/telegramWebhook.js

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed. Use POST." };
    }

    const body = JSON.parse(event.body || "{}");

    if (!body.message || !body.message.chat) {
      return { statusCode: 200, body: "No message" };
    }

    const chatId = body.message.chat.id;
    const text = (body.message.text || "").trim();

    const BOT_TOKEN = process.env.BOT_TOKEN;
    if (!BOT_TOKEN) {
      return { statusCode: 500, body: JSON.stringify({ error: "Missing BOT_TOKEN" }) };
    }

    // Simulate your data
    const prefix = "A";
    const number = Math.floor(Math.random() * 100 + 1);
    const counter = Math.floor(Math.random() * 5 + 1);

    if (text === "/start" || text.toLowerCase().includes("start")) {
      const message = `
👋 Hey!
🧾 Number • ${prefix}${number}
🪑 Counter • ${counter}

QueueJoy is now keeping your spot in line.
Leave this page open in the background (don’t close it) — relax and enjoy your time! 🎮
      `;

      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message }),
      });
    }

    return { statusCode: 200, body: "OK" };
  } catch (err) {
    console.error("Webhook error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

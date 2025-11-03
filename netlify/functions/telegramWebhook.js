import fetch from "node-fetch";

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");

    if (!body.message || !body.message.text) {
      return { statusCode: 200, body: "No message" };
    }

    const chatId = body.message.chat.id;
    const text = body.message.text.trim();

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHAT_ID = process.env.CHAT_ID;

    if (!BOT_TOKEN || !CHAT_ID) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing BOT_TOKEN or CHAT_ID in environment" }),
      };
    }

    // Example — replace these with live values from your queue system later
    const prefix = "A";
    const currentNumber = "104";
    const counterName = "3";

    if (text === "/start" || text.toLowerCase().includes("start")) {
      const message = `
👋 **Hey!**

🧾 **Number • ${prefix}${currentNumber}**  
🪑 **Counter • ${counterName}**

QueueJoy is now keeping your spot in line.  
You can safely leave this browser tab running in the background — don’t close it!  

Relax, grab a drink ☕, or play a quick game 🎮  
We’ll message you right here when it’s your turn.
      `;

      const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

      await fetch(telegramUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "Markdown",
        }),
      });
    }

    return { statusCode: 200, body: "OK" };
  } catch (err) {
    console.error("Webhook error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

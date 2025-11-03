import fetch from "node-fetch";

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");

    // Handle only messages
    if (!body.message || !body.message.text) {
      return { statusCode: 200, body: "No message" };
    }

    const chatId = body.message.chat.id;
    const text = body.message.text.trim();

    const BOT_TOKEN = process.env.BOT_TOKEN;
    if (!BOT_TOKEN) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing BOT_TOKEN in environment" }),
      };
    }

    // ⚙️ Customize your message here
    if (text === "/start" || text.toLowerCase().includes("start")) {
      // example data — you can update from your queue system
      const queueNumber = "A102";
      const counter = "3";

      const message = `
Hey 👋  
You're now connected to QueueJoy!  

Your number: **${queueNumber}**  
Your counter: **${counter}**

You can leave this page open in the background —  
relax, play a game, or grab a drink ☕  
We'll message you when it's your turn!
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

// netlify/functions/sendTelegram.js
import fetch from "node-fetch";

export async function handler(event, context) {
  // 1️⃣ Only allow POST requests
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  try {
    // 2️⃣ Parse the JSON body from the request
    const body = JSON.parse(event.body || "{}");
    const { message } = body;

    if (!message) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Message is required" }),
      };
    }

    // 3️⃣ Read environment variables
    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHAT_ID = process.env.CHAT_ID;

    if (!BOT_TOKEN || !CHAT_ID) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing BOT_TOKEN or CHAT_ID" }),
      };
    }

    // 4️⃣ Telegram API endpoint
    const telegramURL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    // 5️⃣ Send message to Telegram
    const telegramResponse = await fetch(telegramURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: `📢 QueueJoy Alert:\n${message}`,
      }),
    });

    const result = await telegramResponse.json();

    // 6️⃣ Return success if Telegram accepted it
    if (telegramResponse.ok) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, result }),
      };
    } else {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Failed to send Telegram message",
          details: result,
        }),
      };
    }
  } catch (err) {
    // 7️⃣ Catch any unexpected error
    console.error("Error in sendTelegram:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal Server Error",
        details: err.message,
      }),
    };
  }
}

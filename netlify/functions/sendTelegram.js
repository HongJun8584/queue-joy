// netlify/functions/sendTelegram.js

export const handler = async (event) => {
  // Allow only POST requests
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed. Use POST instead." }),
    };
  }

  try {
    // Parse the request body
    const { message } = JSON.parse(event.body || "{}");

    if (!message) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing 'message' in request body." }),
      };
    }

    // Environment variables from Netlify
    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing Telegram credentials." }),
      };
    }

    // Send message to Telegram (using built-in fetch)
    const telegramURL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(telegramURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
      }),
    });

    const data = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: "Telegram message sent!",
        telegramResponse: data,
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

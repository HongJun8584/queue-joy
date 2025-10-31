// netlify/functions/sendTelegram.js

// Export the handler so Netlify can detect and run it
export const handler = async (event) => {
  try {
    // Only allow POST
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Method Not Allowed" }),
      };
    }

    // Parse incoming data (from form or frontend)
    const body = JSON.parse(event.body || "{}");
    const { message } = body;

    if (!message) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Message is required" }),
      };
    }

    // ✅ Replace with your own bot token and chat ID
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
    const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "YOUR_CHAT_ID_HERE";

    const telegramURL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    // Send the message to Telegram
    const response = await fetch(telegramURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.description || "Telegram API error");
    }

    // ✅ Success
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: "Message sent successfully!",
        telegramResponse: data,
      }),
    };
  } catch (error) {
    // ❌ Handle failure
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error.message,
      }),
    };
  }
};

export async function handler(event, context) {
  console.log("🚀 getToken.js triggered");

  try {
    const BOT_TOKEN = process.env.BOT_TOKEN; // <-- matches your Netlify variable
    const CHAT_ID = process.env.CHAT_ID; // optional if you stored it too

    if (!BOT_TOKEN) {
      console.error("❌ BOT_TOKEN missing from environment variables");
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing BOT_TOKEN in Netlify environment" })
      };
    }

    console.log("✅ BOT_TOKEN successfully loaded from environment");

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ token: BOT_TOKEN, chatId: CHAT_ID || null })
    };

  } catch (error) {
    console.error("🔥 Error in getToken.js:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error", details: error.message })
    };
  }
}

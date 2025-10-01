// File: /netlify/functions/push.js
import fetch from "node-fetch";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: "Method Not Allowed" }),
      };
    }

    const { title, message, url } = JSON.parse(event.body);

    // 🔑 Environment variables set in Netlify Dashboard
    const APP_ID = process.env.ONESIGNAL_APP_ID;
    const REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

    if (!APP_ID || !REST_API_KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing OneSignal environment variables" }),
      };
    }

    const response = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Basic ${REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: APP_ID,
        included_segments: ["All"], // 🚨 For testing → sends to everyone
        headings: { en: title || "Queue Joy Update" },
        contents: { en: message || "It's your turn now!" },
        url: url || "https://queuejoy.netlify.app",
      }),
    });

    const data = await response.json();

    return {
      statusCode: response.ok ? 200 : response.status,
      body: JSON.stringify(data),
    };
  } catch (err) {
    console.error("❌ Push error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to send push notification" }),
    };
  }
}

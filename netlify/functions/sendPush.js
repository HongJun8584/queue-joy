// /netlify/functions/sendPush.js
import fetch from "node-fetch";

// ✅ Netlify serverless function
export async function handler(event, context) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { ticket, counter } = JSON.parse(event.body);

    // 🚨 Security: keep API key in Netlify env vars (Settings → Environment variables)
    const REST_API_KEY = process.env.ipp6cywtguj25lt7s2dyksa7f;
    const APP_ID = process.env.ONESIGNAL_APP_ID || "3b0fc874-4427-4278-9f5c-4edd5d92c7e2";

    if (!REST_API_KEY) {
      throw new Error("Missing OneSignal REST API Key. Add it in Netlify → Site settings → Environment variables.");
    }

    const response = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Basic ${REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: APP_ID,
        headings: { en: "Queue Joy • It's Your Turn!" },
        contents: { en: `Ticket ${ticket} → ${counter}` },
        included_segments: ["All"], // ⚠️ Sends to ALL subscribers (later you can target specific users)
        url: `https://queuejoy.netlify.app/your_turn.html?queueId=${encodeURIComponent(ticket)}`,
      }),
    });

    const data = await response.json();
    console.log("📢 OneSignal API response:", data);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, data }),
    };
  } catch (err) {
    console.error("❌ Push error:", err);
    return { statusCode: 500, body: "Push notification failed" };
  }
}

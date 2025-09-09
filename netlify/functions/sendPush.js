// /netlify/functions/sendPush.js

export async function handler(event, context) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { ticket, counter } = JSON.parse(event.body);

    const REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;
    const APP_ID = process.env.ONESIGNAL_APP_ID;

    if (!REST_API_KEY || !APP_ID) {
      throw new Error(
        "Missing OneSignal keys. Set ONESIGNAL_REST_API_KEY and ONESIGNAL_APP_ID in Netlify → Site settings → Environment variables."
      );
    }

    // Use the built-in fetch (no import needed)
    const response = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Basic ${REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: APP_ID,
        headings: { en: "Queue Joy • It's Your Turn!" },
        contents: { en: `Ticket ${ticket} → Counter ${counter}` },
        included_segments: ["All"],
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
    return { statusCode: 500, body: `Push notification failed: ${err.message}` };
  }
}

// sendPush function placeholder 
// /netlify/functions/sendPush.js
import fetch from "node-fetch";

export async function handler(event, context) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { ticket, counter } = JSON.parse(event.body);

    const response = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": "ipp6cywtguj25lt7s2dyksa7f", // ⚠️ Replace with your OneSignal REST API Key
      },
      body: JSON.stringify({
        app_id: "3b0fc874-4427-4278-9f5c-4edd5d92c7e2",
        headings: { en: "Queue Joy • It's Your Turn!" },
        contents: { en: `Ticket ${ticket} → ${counter}` },
        included_segments: ["All"], // or use filters/tags for specific users
        url: "https://queuejoy.netlify.app/your_turn.html?queueId=" + encodeURIComponent(ticket),
      }),
    });

    const data = await response.json();
    console.log("OneSignal API response:", data);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, data }),
    };
  } catch (err) {
    console.error("Error sending push:", err);
    return { statusCode: 500, body: "Push notification failed" };
  }
}

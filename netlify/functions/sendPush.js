import OneSignal from "onesignal-node";

const client = new OneSignal.Client(process.env.ONESIGNAL_APP_ID, process.env.ONESIGNAL_API_KEY);

export async function handler(event) {
  try {
    const { ticket, counter } = JSON.parse(event.body);

    if (!ticket || !counter) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing ticket or counter" }),
      };
    }

    const notification = {
      contents: { en: `Number ${ticket} → Please proceed to ${counter}` },
      included_segments: ["All"], // Or use targeting if needed
      name: "queue-notification",
    };

    const response = await client.createNotification(notification);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, response }),
    };
  } catch (err) {
    console.error("Push error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
}

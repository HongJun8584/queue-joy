// netlify/functions/sendPush.js
const OneSignal = require("onesignal-node");

// Initialize OneSignal client with env variables
const client = new OneSignal.Client(
  process.env.ONESIGNAL_APP_ID,
  process.env.ONESIGNAL_API_KEY
);

exports.handler = async function(event, context) {
  try {
    // Parse POST body
    const { ticket, counter } = JSON.parse(event.body);

    if (!ticket || !counter) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing ticket or counter" }),
      };
    }

    // Prepare notification payload
    const notification = {
      contents: { en: `Number ${ticket} → Please proceed to ${counter}` },
      included_segments: ["All"], // Adjust if you want specific targeting
      name: "queue-notification",
    };

    // Send notification
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
};

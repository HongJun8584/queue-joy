const admin = require("firebase-admin");
const crypto = require("crypto");

// Initialize Firebase if not already
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: "queue-joy-aa21b",
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
    databaseURL: "https://queue-joy-aa21b-default-rtdb.asia-southeast1.firebasedatabase.app",
  });
}

const db = admin.database();

exports.handler = async (event) => {
  try {
    const { queueKey } = JSON.parse(event.body || "{}");
    if (!queueKey) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing queueKey" }) };
    }

    // Generate random token
    const token = crypto.randomBytes(16).toString("hex");

    // Save pending link
    await db.ref(`telegramPending/${token}`).set({
      queueKey,
      createdAt: Date.now(),
    });

    const botUsername = process.env.BOT_USERNAME; // e.g. QueueJoyBot
    const link = `https://t.me/${botUsername}?start=${token}`;

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ link }),
    };
  } catch (error) {
    console.error("🔥 Error creating Telegram link:", error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

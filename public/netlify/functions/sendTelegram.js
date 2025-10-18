const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');

// Initialize Firebase
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: "queue-joy-aa21b",
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL
    }),
    databaseURL: "https://queue-joy-aa21b-default-rtdb.asia-southeast1.firebasedatabase.app"
  });
}

const db = admin.database();
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: false });

// Netlify Function handler
exports.handler = async (event, context) => {
  try {
    if (event.httpMethod === 'POST') {
      const { message } = JSON.parse(event.body || '{}');

      // Handle /start TOKEN command
      if (message && message.text && message.text.startsWith('/start ')) {
        const token = message.text.split(' ')[1];
        const chatId = message.chat.id;
        const snapshot = await db.ref(`telegramPending/${token}`).once('value');

        if (snapshot.exists()) {
          const { queueKey } = snapshot.val();

          await db.ref(`queue/${queueKey}`).update({
            telegramChatId: chatId,
            telegramConnected: true
          });

          await db.ref(`telegramPending/${token}`).remove();

          await bot.sendMessage(chatId, 
            '🎉 *Connected successfully!*\n\nYou’ll get a message here when it’s your turn 🪄', 
            { parse_mode: 'Markdown' }
          );
        } else {
          await bot.sendMessage(chatId, 
            '❌ *Invalid or expired link.*\nPlease go back and reconnect through Queue Joy.', 
            { parse_mode: 'Markdown' }
          );
        }
      } 
      
      // Handle queue notification
      else {
        const { queueKey, queueId } = JSON.parse(event.body || '{}');
        const queueSnap = await db.ref(`queue/${queueKey}`).once('value');
        const queue = queueSnap.val();

        if (queue && queue.telegramChatId) {
          await bot.sendMessage(
            queue.telegramChatId, 
            `🔔 *It’s your turn!* 🎟️\n\nQueue number *${queueId}* is now being served — please proceed to the counter.`,
            { parse_mode: 'Markdown' }
          );
        }
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Processed ✅' }),
      };
    }

    // Wrong method
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed 🚫' }),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error 💥' }),
    };
  }
};

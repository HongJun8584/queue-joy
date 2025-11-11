// /netlify/functions/sendTelegram.js
// Netlify function to send Telegram notifications when a number is called
// Environment variables required: BOT_TOKEN, FIREBASE_DB_URL (optional)

exports.handler = async (event) => {
  try {
    // Only accept POST requests
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    // Parse request body
    let requestData = {};
    try {
      requestData = JSON.parse(event.body || '{}');
    } catch (error) {
      console.error('Invalid JSON body:', error);
      return { statusCode: 400, body: 'Invalid JSON' };
    }

    const { queueNumber, counterName, message, chatId } = requestData;

    // Get environment variables
    const BOT_TOKEN = process.env.BOT_TOKEN;
    const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');

    if (!BOT_TOKEN) {
      console.error('Missing BOT_TOKEN environment variable');
      return { statusCode: 500, body: 'Server configuration error' };
    }

    // ==================== HELPER FUNCTIONS ====================

    /**
     * Send a message via Telegram Bot API
     */
    const sendTelegram = async (toChatId, text, options = {}) => {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: toChatId,
            text,
            parse_mode: options.parseMode || null,
            ...options
          }),
        });

        const responseData = await response.json().catch(() => ({}));

        if (!response.ok) {
          console.error('Telegram API error:', response.status, responseData);
          return { success: false, error: responseData };
        }

        return { success: true, data: responseData };
      } catch (error) {
        console.error('Failed to send Telegram message:', error);
        return { success: false, error: error.message };
      }
    };

    /**
     * Fetch JSON from URL
     */
    const fetchJson = async (url) => {
      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        return await response.json();
      } catch (error) {
        console.error('Fetch error:', error);
        return null;
      }
    };

    // ==================== FIND CHAT ID ====================

    let targetChatId = chatId; // Use provided chatId if available

    // If no chatId provided, try to find it from Firebase using queue number
    if (!targetChatId && FIREBASE_DB_URL && queueNumber) {
      try {
        // Try to find queue entry by queue number
        const queueUrl = `${FIREBASE_DB_URL}/queue.json?orderBy="queueId"&equalTo="${queueNumber}"`;
        const queueData = await fetchJson(queueUrl);

        if (queueData) {
          const queueEntry = Object.values(queueData)[0];
          if (queueEntry && queueEntry.chatId) {
            targetChatId = queueEntry.chatId;
            console.log('Found chatId from Firebase:', targetChatId);
          }
        }
      } catch (error) {
        console.warn('Failed to fetch chatId from Firebase:', error);
      }
    }

    if (!targetChatId) {
      console.error('No chatId provided or found in Firebase');
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'No chatId available. User may not be connected via Telegram.'
        })
      };
    }

    // ==================== SEND NOTIFICATION ====================

    // Build the message
    const notificationMessage = message || [
      '🔔 YOUR NUMBER IS CALLED!',
      '',
      `🧾 Number: ${queueNumber || 'Unknown'}`,
      `🪑 Counter: ${counterName || 'Unknown'}`,
      '',
      '👉 Please proceed to the counter now.',
      '',
      'Thank you for your patience! 😊'
    ].join('\n');

    // Send the message
    const result = await sendTelegram(targetChatId, notificationMessage);

    if (result.success) {
      console.log('Notification sent successfully:', {
        chatId: targetChatId,
        queueNumber,
        counterName
      });

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          message: 'Notification sent successfully',
          chatId: targetChatId
        })
      };
    } else {
      console.error('Failed to send notification:', result.error);
      return {
        statusCode: 500,
        body: JSON.stringify({
          success: false,
          error: 'Failed to send notification',
          details: result.error
        })
      };
    }

  } catch (error) {
    console.error('Send Telegram function error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: 'Internal server error',
        details: error.message
      })
    };
  }
};

// /netlify/functions/telegramWebhook.js
// Production-ready Telegram webhook handler for QueueJoy
// Environment variables required: BOT_TOKEN, FIREBASE_DB_URL (optional)

exports.handler = async (event) => {
  try {
    // Only accept POST requests
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    // Parse incoming update
    let update = {};
    try {
      update = JSON.parse(event.body || '{}');
    } catch (error) {
      console.error('Invalid JSON body:', error);
      return { statusCode: 400, body: 'Invalid JSON' };
    }

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
    const sendTelegram = async (chatId, text, options = {}) => {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: options.parseMode || null,
            ...options
          }),
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          console.error('Telegram API error:', response.status, error);
        }
        
        return response.ok;
      } catch (error) {
        console.error('Failed to send Telegram message:', error);
        return false;
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

    /**
     * Decode base64 JSON token
     */
    const decodeBase64Json = (token) => {
      try {
        const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
        const padding = normalized.length % 4;
        const padded = padding ? normalized + '='.repeat(4 - padding) : normalized;
        const decoded = Buffer.from(padded, 'base64').toString('utf8');
        return JSON.parse(decoded);
      } catch (error) {
        return null;
      }
    };

    // ==================== EXTRACT USER INFO ====================

    const msg = update.message || update.edited_message || update.channel_post || null;
    const callbackQuery = update.callback_query || null;
    const candidateMsg = msg || (callbackQuery && callbackQuery.message) || null;

    // Extract user chat ID
    const userChatId = (candidateMsg && candidateMsg.chat && typeof candidateMsg.chat.id !== 'undefined')
      ? candidateMsg.chat.id
      : (callbackQuery && callbackQuery.from && callbackQuery.from.id)
      ? callbackQuery.from.id
      : null;

    if (!userChatId) {
      return { statusCode: 200, body: 'No chat ID found' };
    }

    // Extract message text
    const messageText = candidateMsg && (candidateMsg.text || candidateMsg.caption)
      ? (candidateMsg.text || candidateMsg.caption).trim()
      : '';
    
    const callbackData = callbackQuery && callbackQuery.data 
      ? String(callbackQuery.data).trim() 
      : '';

    // ==================== EXTRACT /START TOKEN ====================

    let startToken = null;

    // Method 1: Extract from message text
    if (messageText) {
      const match = messageText.match(/\/start(?:@[\w_]+)?(?:\s+(.+))?$/i);
      if (match) {
        startToken = (match[1] || '').trim() || null;
      }
    }

    // Method 2: Extract from callback data
    if (!startToken && callbackData) {
      const match = callbackData.match(/start=([^&\s]+)/i);
      if (match) {
        startToken = decodeURIComponent(match[1]);
      }
    }

    // If no /start command, ignore the message
    if (startToken === null) {
      return { statusCode: 200, body: 'Not a /start command' };
    }

    // If /start without token, send instructions
    if (!startToken) {
      await sendTelegram(
        userChatId,
        '👋 Hi!\n\nTo connect your queue number, please open the QueueJoy status page you received and tap "Connect via Telegram".\n\nThe page will automatically run the /start command with your unique token.'
      );
      return { statusCode: 200, body: 'No token provided' };
    }

    // ==================== PARSE TOKEN ====================

    let queueNumber = null;
    let counterName = 'To be assigned';
    let counterId = null;

    // Try to decode as base64 JSON
    const parsedToken = decodeBase64Json(startToken);

    if (parsedToken && typeof parsedToken === 'object') {
      // Extract queue number from various possible keys
      const queueKeys = ['queueId', 'queueKey', 'queueUid', 'id', 'queue', 'number', 'ticket', 'label'];
      for (const key of queueKeys) {
        if (parsedToken[key]) {
          queueNumber = String(parsedToken[key]);
          break;
        }
      }

      // Extract counter ID from various possible keys
      const counterKeys = ['counterId', 'counterName', 'counter', 'displayName', 'counter_name'];
      for (const key of counterKeys) {
        if (parsedToken[key]) {
          counterId = String(parsedToken[key]);
          break;
        }
      }
    }

    // Try to fetch human-readable counter name from Firebase
    if (FIREBASE_DB_URL && counterId) {
      try {
        const counterData = await fetchJson(
          `${FIREBASE_DB_URL}/counters/${encodeURIComponent(counterId)}.json`
        );
        if (counterData && counterData.name) {
          counterName = counterData.name;
        }
      } catch (error) {
        console.warn('Failed to fetch counter name from Firebase:', error);
      }
    }

    // Fallback: Try delimiter-based parsing (e.g., "A001::Counter1" or "A001|Counter1")
    if (!queueNumber) {
      const delimiters = ['::', '|', ':'];
      for (const delimiter of delimiters) {
        if (startToken.includes(delimiter)) {
          const [queue, counter] = startToken.split(delimiter, 2);
          if (queue) queueNumber = queue.trim();
          if (counter) counterName = counter.trim();
          break;
        }
      }
    }

    // Fallback: Try to fetch from Firebase using token as key
    if (!queueNumber && FIREBASE_DB_URL) {
      try {
        const queueUrl = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(startToken)}.json`;
        const queueData = await fetchJson(queueUrl);
        
        if (queueData) {
          // Extract queue number
          if (queueData.queueId) queueNumber = String(queueData.queueId);
          else if (queueData.number) queueNumber = String(queueData.number);
          else if (queueData.ticket) queueNumber = String(queueData.ticket);

          // Extract and fetch counter info
          const counterIdFromQueue = queueData.counterId || queueData.counter || null;
          if (counterIdFromQueue) {
            const counterUrl = `${FIREBASE_DB_URL}/counters/${encodeURIComponent(counterIdFromQueue)}.json`;
            const counterData = await fetchJson(counterUrl);
            if (counterData) {
              counterName = counterData.name || counterData.displayName || counterData.label || counterName;
            }
          }

          // Update Firebase with Telegram connection info
          const patchUrl = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(startToken)}.json`;
          await fetch(patchUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chatId: userChatId,
              telegramConnected: true,
              connectedAt: new Date().toISOString()
            }),
          });
        }
      } catch (error) {
        console.warn('Firebase lookup failed:', error);
      }
    }

    // Final fallback: Use token as queue number if it looks like one
    if (!queueNumber) {
      const isHumanReadable = /^[A-Za-z]{1,3}\d{1,4}$/;
      queueNumber = isHumanReadable.test(startToken) ? startToken : startToken;
    }

    // Ensure we have values
    queueNumber = String(queueNumber || 'Unknown').trim();
    counterName = String(counterName || 'To be assigned').trim();

    // ==================== SEND CONFIRMATION ====================

    const confirmationMessage = [
      '👋 Hey!',
      `🧾 Number • ${queueNumber}`,
      `🪑 Counter • ${counterName}`,
      '',
      'You are now connected! You can close this app and Telegram.',
      'Everything will be automated from now on.',
      'Just sit down and relax. ☕️😌',
      '',
      'We\'ll notify you when it\'s your turn!'
    ].join('\n');

    await sendTelegram(userChatId, confirmationMessage);

    console.log('User connected:', {
      userChatId,
      queueNumber,
      counterName,
      counterId,
      token: startToken.substring(0, 20) + '...'
    });

    return { statusCode: 200, body: 'OK' };

  } catch (error) {
    console.error('Webhook handler error:', error);
    return { statusCode: 500, body: 'Internal server error' };
  }
};

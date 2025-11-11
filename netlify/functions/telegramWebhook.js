// /netlify/functions/telegramWebhook.js
// Clean Telegram webhook handler - No admin/debug logic
// Environment: BOT_TOKEN (required), CHAT_ID (optional for broadcasts)

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let update = {};
    try {
      update = JSON.parse(event.body || '{}');
    } catch (err) {
      return { statusCode: 400, body: 'Invalid JSON' };
    }

    const BOT_TOKEN = process.env.BOT_TOKEN;
    if (!BOT_TOKEN) {
      return { statusCode: 500, body: 'Missing BOT_TOKEN' };
    }

    // Telegram API helper
    async function sendTelegram(toChatId, text) {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            chat_id: toChatId, 
            text,
            parse_mode: 'HTML'
          }),
        });
        const result = await res.json();
        if (!res.ok) console.warn('Telegram API error:', result);
        return result;
      } catch (e) {
        console.error('sendTelegram failed:', e);
        throw e;
      }
    }

    // Extract message and chat info
    const msg = update.message || update.edited_message || update.channel_post || null;
    const cb = update.callback_query || null;
    
    const userChatId = (msg && msg.chat && typeof msg.chat.id !== 'undefined')
      ? msg.chat.id
      : (cb && cb.from && cb.from.id) 
        ? cb.from.id 
        : null;

    if (!userChatId) {
      return { statusCode: 200, body: 'No chat id' };
    }

    // Extract text
    const text = (msg && (msg.text || msg.caption)) ? String(msg.text || msg.caption).trim() : '';
    const cbData = (cb && cb.data) ? String(cb.data).trim() : '';

    // Parse /start token
    let tokenRaw = null;
    
    if (text) {
      const m = text.match(/\/start(?:@[\w_]+)?\s+(.+)$/i);
      if (m && m[1]) {
        tokenRaw = m[1].trim();
      }
    }
    
    if (!tokenRaw && cbData) {
      const m2 = cbData.match(/start=([^&\s]+)/i);
      if (m2) {
        tokenRaw = decodeURIComponent(m2[1]);
      } else {
        tokenRaw = cbData;
      }
    }

    // Handle non-start messages
    if (tokenRaw === null) {
      return { statusCode: 200, body: 'Ignored' };
    }

    // No token provided
    if (!tokenRaw) {
      await sendTelegram(userChatId,
        '👋 Hi! To connect your queue number, open your QueueJoy status page and tap "Connect via Telegram".'
      );
      return { statusCode: 200, body: 'No token' };
    }

    // Parse token (supports base64 JSON, delimited, or plain)
    let queueId = null;
    let counterName = 'TBD';

    // Try base64 JSON decode
    try {
      const norm = tokenRaw.replace(/-/g, '+').replace(/_/g, '/');
      const pad = norm.length % 4;
      const padded = pad ? norm + '='.repeat(4 - pad) : norm;
      const decoded = Buffer.from(padded, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      
      if (parsed && typeof parsed === 'object') {
        queueId = parsed.queueId || parsed.queueKey || null;
        counterName = parsed.counterId || parsed.counterName || 'TBD';
      }
    } catch (e) {
      // Not base64 JSON
    }

    // Try delimited format
    if (!queueId) {
      for (const delimiter of ['::', '|', ':']) {
        if (tokenRaw.includes(delimiter)) {
          const [a, b] = tokenRaw.split(delimiter, 2);
          queueId = (a || '').trim();
          counterName = (b || '').trim() || counterName;
          break;
        }
      }
    }

    // Fallback: use token as queueId
    if (!queueId) {
      queueId = tokenRaw;
    }

    queueId = String(queueId || 'TBD').trim();
    counterName = String(counterName || 'TBD').trim();

    // Send success message
    const replyText = `👋 Hey!\n🧾 Number • ${queueId}\n🪑 Counter • ${counterName}\n\nYou are now connected — you can close the browser and Telegram. Everything will be automated. ☕️😌`;

    await sendTelegram(userChatId, replyText);

    return { 
      statusCode: 200, 
      body: JSON.stringify({ 
        success: true, 
        queueId, 
        chatId: userChatId 
      }) 
    };

  } catch (err) {
    console.error('Webhook error:', err);
    return { statusCode: 500, body: 'Internal error' };
  }
};

// netlify/functions/sendTelegram.js
// Requirements:
//   BOT_TOKEN - Telegram bot token
//   FIREBASE_DB_URL - Firebase Realtime Database root URL (no trailing slash)

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');
    if (!BOT_TOKEN) {
      console.error('Missing BOT_TOKEN');
      return { statusCode: 500, body: 'Server misconfigured' };
    }

    // Parse body
    let body = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      console.error('Invalid JSON body');
      return { statusCode: 400, body: 'Invalid JSON' };
    }

    const { queueNumber, queueKey, counterName, message, chatId: providedChatId } = body;

    const fetchJson = async (url, opts = {}) => {
      try {
        const res = await fetch(url, opts);
        const data = await res.json().catch(() => null);
        return res.ok ? data : null;
      } catch (e) {
        console.error('fetchJson error', e, url);
        return null;
      }
    };

    const sendTelegram = async (chatId, text, extra = {}) => {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: extra.parse_mode || 'Markdown',
            disable_web_page_preview: true,
            ...extra
          }),
        });
        const d = await res.json().catch(() => ({}));
        return { ok: res.ok, data: d };
      } catch (e) {
        console.error('sendTelegram error', e);
        return { ok: false, error: e.message };
      }
    };

    // find chatId if not provided
    let targetChatId = providedChatId || null;
    let targetQueueKey = queueKey || null;

    if (!targetChatId && FIREBASE_DB_URL) {
      // If queueKey supplied, try to fetch that entry
      if (queueKey) {
        const entry = await fetchJson(`${FIREBASE_DB_URL}/queue/${encodeURIComponent(queueKey)}.json`);
        if (entry?.chatId) {
          targetChatId = entry.chatId;
          targetQueueKey = queueKey;
        }
      }

      // If still no chatId and queueNumber provided, try query by queueId
      if (!targetChatId && queueNumber) {
        const qnumEnc = encodeURIComponent(String(queueNumber));
        const url = `${FIREBASE_DB_URL}/queue.json?orderBy="queueId"&equalTo="${qnumEnc}"`;
        const result = await fetchJson(url);
        if (result && Object.keys(result).length) {
          const firstKey = Object.keys(result)[0];
          const entry = result[firstKey];
          if (entry?.chatId) {
            targetChatId = entry.chatId;
            targetQueueKey = firstKey;
          } else {
            // store notificationError: no-chatId
            await fetch(`${FIREBASE_DB_URL}/queue/${encodeURIComponent(firstKey)}.json`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ notificationError: 'no-chatId', notificationErrorAt: Date.now() })
            }).catch(()=>null);
          }
        }
      }
    }

    if (!targetChatId) {
      console.error('No chatId available for notification');
      return {
        statusCode: 400,
        body: JSON.stringify({ success: false, error: 'No chatId available' })
      };
    }

    const notifyText = message || [
      '🔔 *YOUR NUMBER IS CALLED!*',
      '',
      `🧾 Number: *${queueNumber || 'Unknown'}*`,
      `🪑 Counter: *${counterName || 'Unknown'}*`,
      '',
      '👉 Please proceed to the counter now.',
      '',
      'Thank you for your patience! 😊'
    ].join('\n');

    const res = await sendTelegram(targetChatId, notifyText);
    if (res.ok) {
      // mark queue entry as notified (if we have the queueKey)
      if (targetQueueKey && FIREBASE_DB_URL) {
        await fetch(`${FIREBASE_DB_URL}/queue/${encodeURIComponent(targetQueueKey)}.json`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            notificationSent: true,
            notifiedAt: Date.now(),
            notifiedVia: 'telegram'
          })
        }).catch(e => console.warn('Failed to patch queue entry after notify', e));
      }
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, chatId: targetChatId })
      };
    } else {
      // record error on the queue entry if available
      if (targetQueueKey && FIREBASE_DB_URL) {
        await fetch(`${FIREBASE_DB_URL}/queue/${encodeURIComponent(targetQueueKey)}.json`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            notificationError: res.error || 'telegram-failed',
            notificationErrorAt: Date.now()
          })
        }).catch(()=>null);
      }
      console.error('Telegram send failed', res);
      return {
        statusCode: 500,
        body: JSON.stringify({ success: false, error: res.error || 'telegram-failed' })
      };
    }

  } catch (err) {
    console.error('sendTelegram handler error', err);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Internal server error' }) };
  }
};

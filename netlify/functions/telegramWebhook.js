// /netlify/functions/telegramWebhook.js
// Netlify (Node 18+). Env: BOT_TOKEN (required), FIREBASE_DB_URL (optional).
// Handles only /start commands and sends one single friendly reply.

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let update = {};
    try { update = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');
    if (!BOT_TOKEN) return { statusCode: 500, body: 'Missing BOT_TOKEN' };

    const sendTelegram = async (toChatId, text) => {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: toChatId, text }),
        });
      } catch (err) {
        console.error('sendTelegram failed', err);
      }
    };

    const fetchJson = async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    };

    const msg = update.message || update.edited_message || update.channel_post || null;
    const cb = update.callback_query || null;
    const candidateMsg = msg || (cb && cb.message) || null;

    const userChatId = (candidateMsg && candidateMsg.chat && typeof candidateMsg.chat.id !== 'undefined')
      ? candidateMsg.chat.id
      : (cb && cb.from && cb.from.id) ? cb.from.id
      : null;

    if (!userChatId) return { statusCode: 200, body: 'No chat id' };

    const text = candidateMsg && (candidateMsg.text || candidateMsg.caption)
      ? (candidateMsg.text || candidateMsg.caption).trim()
      : '';
    const cbData = cb && cb.data ? String(cb.data).trim() : '';

    let startToken = null;
    if (text) {
      const m = text.match(/\/start(?:@[\w_]+)?(?:\s+(.+))?$/i);
      if (m) startToken = (m[1] || '').trim() || null;
    }
    if (!startToken && cbData) {
      const m2 = cbData.match(/start=([^&\s]+)/i);
      if (m2) startToken = decodeURIComponent(m2[1]);
    }

    if (startToken === null) return { statusCode: 200, body: 'Ignored non-start message' };

    if (!startToken) {
      await sendTelegram(userChatId,
        '👋 Hi — to connect your number, open the QueueJoy status page you received and tap Connect via Telegram. That page will run the /start command automatically.'
      );
      return { statusCode: 200, body: 'No token provided' };
    }

    const tryDecodeBase64Json = (s) => {
      try {
        const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
        const pad = normalized.length % 4;
        const withPad = pad ? normalized + '='.repeat(4 - pad) : normalized;
        const decoded = Buffer.from(withPad, 'base64').toString('utf8');
        return JSON.parse(decoded);
      } catch { return null; }
    };

    let queueNumber = null;
    let counterName = 'To be assigned';

    const parsed = tryDecodeBase64Json(startToken);
    if (parsed && typeof parsed === 'object') {
      const qKeys = ['queueId','queueKey','queueUid','id','queue','number','ticket','label'];
      const cKeys = ['counterId','counterName','counter','displayName','counter_name'];
      for (const k of qKeys) if (parsed[k]) { queueNumber = String(parsed[k]); break; }
      for (const k of cKeys) if (parsed[k]) { counterName = String(parsed[k]); break; }
      if (!queueNumber && parsed.data && typeof parsed.data === 'object') {
        for (const k of qKeys) if (parsed.data[k]) { queueNumber = String(parsed.data[k]); break; }
      }
    }

    if (!queueNumber) {
      const delims = ['::','|',':'];
      for (const d of delims) {
        if (startToken.includes(d)) {
          const [a,b] = startToken.split(d,2);
          if (a) queueNumber = a.trim();
          if (b) counterName = b.trim() || counterName;
          break;
        }
      }
    }

    if (!queueNumber && FIREBASE_DB_URL) {
      try {
        const qUrl = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(startToken)}.json`;
        const qEntry = await fetchJson(qUrl);
        if (qEntry) {
          if (qEntry.queueId) queueNumber = String(qEntry.queueId);
          else if (qEntry.number) queueNumber = String(qEntry.number);
          else if (qEntry.ticket) queueNumber = String(qEntry.ticket);

          const counterId = qEntry.counterId || qEntry.counter || null;
          if (counterId) {
            const cUrl = `${FIREBASE_DB_URL}/counters/${encodeURIComponent(counterId)}.json`;
            const cEntry = await fetchJson(cUrl);
            if (cEntry) {
              counterName = (cEntry.name || cEntry.displayName || cEntry.label || counterName);
            }
          }
          const patchUrl = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(startToken)}.json`;
          await fetch(patchUrl, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: userChatId, telegramConnected: true }),
          });
        }
      } catch (e) {
        console.warn('Firebase lookup failed', e);
      }
    }

    if (!queueNumber) {
      const humanMatch = startToken.match(/^[A-Za-z]{1,3}\d{1,4}$/);
      queueNumber = humanMatch ? startToken : startToken;
    }

    queueNumber = String(queueNumber || 'Unknown').trim();
    counterName = String(counterName || 'To be assigned').trim();

    const userMsg = [
      '👋 Hey!',
      `🧾 Number • ${queueNumber}`,
      `🪑 Counter • ${counterName}`,
      '',
      'You are now connected — you can close the browser and Telegram. Everything will be automated. Just sit down and relax. ☕️😌'
    ].join('\n');

    await sendTelegram(userChatId, userMsg);

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('Webhook handler error', err);
    return { statusCode: 500, body: 'Webhook handler error' };
  }
};

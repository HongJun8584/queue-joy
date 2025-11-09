// /netlify/functions/telegramWebhook.js
// Netlify (Node 18+). Env: BOT_TOKEN (required), CHAT_ID (optional admin), FIREBASE_DB_URL (optional).
// Only handles /start commands and sends one single friendly reply (human ticket + counter if available).

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let update = {};
    try { update = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const ADMIN_CHAT_ID = process.env.CHAT_ID || null;
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

    // helper to fetch JSON (used for Firebase lookups)
    const fetchJson = async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          console.warn('fetchJson non-ok', res.status, url);
          return null;
        }
        return await res.json();
      } catch (e) {
        console.warn('fetchJson failed', e, url);
        return null;
      }
    };

    // find message / callback and user chat id
    const msg = update.message || update.edited_message || update.channel_post || null;
    const cb = update.callback_query || null;
    const candidateMsg = msg || (cb && cb.message) || null;

    const userChatId = (candidateMsg && candidateMsg.chat && typeof candidateMsg.chat.id !== 'undefined')
      ? candidateMsg.chat.id
      : (cb && cb.from && cb.from.id) ? cb.from.id
      : null;

    if (!userChatId) return { statusCode: 200, body: 'No chat id' };

    // only handle /start. extract token if provided
    const text = candidateMsg && (candidateMsg.text || candidateMsg.caption) ? (candidateMsg.text || candidateMsg.caption).trim() : '';
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

    // ignore everything except /start commands
    if (startToken === null) return { statusCode: 200, body: 'Ignored non-start message' };

    // when startToken is empty -> guide user (single friendly message)
    if (!startToken) {
      await sendTelegram(userChatId,
        '👋 Hi — to connect your number, open the QueueJoy status page you received and tap Connect via Telegram. That page will run the /start command automatically.'
      );
      return { statusCode: 200, body: 'No token provided' };
    }

    // token parsing helpers
    function tryDecodeBase64Json(s) {
      try {
        const normalized = s.replace(/-/g,'+').replace(/_/g,'/');
        const pad = normalized.length % 4;
        const withPad = pad ? normalized + '='.repeat(4 - pad) : normalized;
        const decoded = Buffer.from(withPad, 'base64').toString('utf8');
        return JSON.parse(decoded);
      } catch (e) { return null; }
    }

    let queueNumber = null;
    let counterName = 'To be assigned';
    let usedFirebase = false;

    // 1) try token is base64 JSON containing human-readable fields
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

    // 2) if token contains delimiter like "A1|Counter 1"
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

    // 3) If still no human number and FIREBASE_DB_URL is provided, try to look up queue entry by token (treat token as DB key)
    if (!queueNumber && FIREBASE_DB_URL) {
      usedFirebase = true;
      try {
        const qUrl = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(startToken)}.json`;
        const qEntry = await fetchJson(qUrl);
        if (qEntry) {
          // common field used by your status page is "queueId" (human number) and "counterId"
          if (qEntry.queueId) queueNumber = String(qEntry.queueId);
          else if (qEntry.number) queueNumber = String(qEntry.number);
          else if (qEntry.ticket) queueNumber = String(qEntry.ticket);

          const counterId = qEntry.counterId || qEntry.counter || null;
          // try to fetch counter name
          if (counterId) {
            try {
              const cUrl = `${FIREBASE_DB_URL}/counters/${encodeURIComponent(counterId)}.json`;
              const cEntry = await fetchJson(cUrl);
              if (cEntry) {
                counterName = (cEntry.name || cEntry.displayName || cEntry.label || counterName);
              }
            } catch(e){ /* ignore counter fetch failure */ }
          }
          // best-effort: persist chatId & flag
          try {
            const patchUrl = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(startToken)}.json`;
            await fetch(patchUrl, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chatId: userChatId, telegramConnected: true }),
            });
          } catch(e){ /* ignore patch errors */ }
        }
      } catch (e) {
        console.warn('Firebase lookup failed', e);
      }
    }

    // 4) fallback: if still no queueNumber, try to parse if token looks like human (e.g., A123)
    if (!queueNumber) {
      // if token matches human-like pattern (letters+digits), accept it
      const humanMatch = startToken.match(/^[A-Za-z]{1,3}\d{1,4}$/);
      if (humanMatch) queueNumber = startToken;
      else queueNumber = startToken; // last resort: show token (but typically DB lookup will avoid this)
    }

    queueNumber = String(queueNumber || 'Unknown').trim();
    counterName = String(counterName || 'To be assigned').trim();

    // send single user message (exact format)
    const userMsgLines = [
      '👋 Hey!',
      `🧾 Number • ${queueNumber}`,
      `🪑 Counter • ${counterName}`,
      '',
      'You are now connected — you can close the browser and Telegram. Everything will be automated. Just sit down and relax. ☕️😌'
    ];
    const userMsg = userMsgLines.join('\n');

    await sendTelegram(userChatId, userMsg);

    // compact admin notice (if configured) — do NOT send to user
    if (ADMIN_CHAT_ID) {
      try {
        const adminLines = [
          '🔔 Connection',
          `Ticket: ${queueNumber}`,
          `Counter: ${counterName}`,
          `chatId: ${userChatId}`,
          `tokenUsedAsKeyLookup: ${usedFirebase ? 'yes' : 'no'}`,
        ];
        await sendTelegram(ADMIN_CHAT_ID, adminLines.join('\n'));
      } catch (e) { /* ignore admin errors */ }
    }

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('Webhook handler error', err);
    return { statusCode: 500, body: 'Webhook handler error' };
  }
};

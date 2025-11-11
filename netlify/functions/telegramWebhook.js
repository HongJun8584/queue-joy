// netlify/functions/telegramWebhook.js
// Requirements (Netlify environment variables):
//   BOT_TOKEN - Telegram bot token
//   FIREBASE_DB_URL - https://<your-project>.firebaseio.com (no trailing slash recommended)

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');

    if (!BOT_TOKEN) {
      console.error('Missing BOT_TOKEN env var');
      return { statusCode: 500, body: 'Server misconfigured' };
    }
    if (!FIREBASE_DB_URL) {
      console.warn('FIREBASE_DB_URL not set — webhook can still handle /start tokens but cannot lookup counters in DB.');
    }

    // helpers
    const fetchJson = async (url, opts = {}) => {
      try {
        const res = await fetch(url, opts);
        if (!res.ok) return null;
        return await res.json();
      } catch (e) {
        console.error('fetchJson error', e, url);
        return null;
      }
    };

    const patchJson = async (url, bodyObj) => {
      try {
        const res = await fetch(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyObj)
        });
        return res.ok ? await res.json() : null;
      } catch (e) {
        console.error('patchJson error', e, url);
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
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          console.warn('Telegram sendMessage failed', data);
          return { ok: false, error: data };
        }
        return { ok: true, data };
      } catch (e) {
        console.error('sendTelegram err', e);
        return { ok: false, error: e.message };
      }
    };

    // parse inbound Telegram update
    let update = {};
    try {
      update = JSON.parse(event.body || '{}');
    } catch (e) {
      console.error('Invalid JSON body');
      return { statusCode: 400, body: 'Invalid JSON' };
    }

    // get message and chatId
    const msg = update.message || update.edited_message || update.callback_query?.message || null;
    const from = update.message?.from || update.callback_query?.from || null;
    const userChatId = msg?.chat?.id ?? from?.id ?? null;

    if (!userChatId) {
      console.log('No chat id in update — ignoring.');
      return { statusCode: 200, body: 'No chat id' };
    }

    const messageText = (msg?.text || msg?.caption || '').trim();

    // utility: decode base64 JSON (JWT-like friendly)
    const tryDecodeBase64Json = (token) => {
      try {
        const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
        const pad = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : '';
        const b = Buffer.from(normalized + pad, 'base64').toString('utf8');
        return JSON.parse(b);
      } catch (e) {
        return null;
      }
    };

    // Try to parse token from /start or any text: permit /start token or raw token
    let token = null;
    const startMatch = messageText.match(/\/start(?:@[\w_]+)?(?:\s+(.+))?$/i);
    if (startMatch) {
      token = (startMatch[1] || '').trim() || null;
    } else if (messageText && messageText.length < 200) {
      // user typed something else — treat whole text as potential token
      token = messageText;
    }

    // If token looks empty, but user typed something, we still proceed to lookup by chatId
    // Strategy:
    // 1) If token present and looks like a Firebase push key (starts with '-'), treat as queueKey and attach chatId.
    // 2) If token decodes to JSON with queueKey/queueId/counterId, use that.
    // 3) If token looks like a human queueId (e.g., A001), search DB by queueId and attach chatId.
    // 4) If no token or attach failed: lookup by chatId to find queue entry and respond with number & counter.

    const attachChatToQueue = async (candidateToken) => {
      // candidateToken may be a Firebase push key, a base64 token, or a queueId string
      if (!FIREBASE_DB_URL) return { ok: false, reason: 'no-firebase' };

      // 1) If it looks like a firebase push key (starts with '-'), patch that record
      if (/^-[A-Za-z0-9_]+$/.test(candidateToken)) {
        const url = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(candidateToken)}.json`;
        const q = await fetchJson(url);
        if (!q) {
          // maybe token is queueKey string but not existing
          const patch = await patchJson(url, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
          return patch ? { ok: true, queueKey: candidateToken, patched: patch } : { ok: false, reason: 'patch-failed' };
        } else {
          // update
          const patch = await patchJson(url, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
          return patch ? { ok: true, queueKey: candidateToken, patched: patch } : { ok: false, reason: 'patch-failed' };
        }
      }

      // 2) Try decode base64 JSON
      const parsed = tryDecodeBase64Json(candidateToken);
      if (parsed && typeof parsed === 'object') {
        // try known keys
        const keys = ['queueKey', 'queueId', 'id', 'ticket', 'number'];
        let found = null;
        for (const k of keys) if (parsed[k]) { found = { key: k, value: String(parsed[k]) }; break; }

        if (found && found.key === 'queueKey' && /^-/.test(found.value)) {
          const url = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(found.value)}.json`;
          const patch = await patchJson(url, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
          return patch ? { ok: true, queueKey: found.value, patched: patch } : { ok: false, reason: 'patch-failed' };
        }

        // if we have queueId (human readable) attempt to find record by queueId
        if (found && (found.key === 'queueId' || found.key === 'number' || found.key === 'ticket' || found.key === 'id')) {
          const qid = encodeURIComponent(String(found.value));
          const url = `${FIREBASE_DB_URL}/queue.json?orderBy="queueId"&equalTo="${qid}"`;
          const result = await fetchJson(url);
          if (result && Object.keys(result).length) {
            const firstKey = Object.keys(result)[0];
            const patchUrl = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(firstKey)}.json`;
            const patch = await patchJson(patchUrl, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
            return patch ? { ok: true, queueKey: firstKey, patched: patch } : { ok: false, reason: 'patch-failed' };
          }
        }
      }

      // 3) If token looks like a readable queue id (letters+digits)
      if (/^[A-Za-z]{0,3}\d{1,5}|^[A-Za-z0-9\-_]{2,20}$/.test(candidateToken)) {
        // search by queueId
        const qid = encodeURIComponent(candidateToken);
        const url = `${FIREBASE_DB_URL}/queue.json?orderBy="queueId"&equalTo="${qid}"`;
        const result = await fetchJson(url);
        if (result && Object.keys(result).length) {
          const firstKey = Object.keys(result)[0];
          const patchUrl = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(firstKey)}.json`;
          const patch = await patchJson(patchUrl, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
          return patch ? { ok: true, queueKey: firstKey, patched: patch } : { ok: false, reason: 'patch-failed' };
        }
      }

      return { ok: false, reason: 'no-match' };
    };

    const findQueueByChatId = async (chatId) => {
      if (!FIREBASE_DB_URL) return null;
      const url = `${FIREBASE_DB_URL}/queue.json?orderBy="chatId"&equalTo="${chatId}"`;
      const q = await fetchJson(url);
      if (!q) return null;
      const key = Object.keys(q)[0];
      const entry = q[key];
      return { key, entry };
    };

    // If token present, attempt attach
    if (token) {
      const attachResult = await attachChatToQueue(token);
      if (attachResult && attachResult.ok) {
        // fetch patched/entry to get readable values
        const q = await fetchJson(`${FIREBASE_DB_URL}/queue/${encodeURIComponent(attachResult.queueKey)}.json`);
        const queueId = q?.queueId || q?.number || q?.ticket || 'Unknown';
        let counterName = 'Unassigned';
        if (q?.counterId) {
          const c = await fetchJson(`${FIREBASE_DB_URL}/counters/${encodeURIComponent(q.counterId)}.json`);
          if (c?.name) counterName = c.name;
        }
        const reply = [
          '✅ Connected to QueueJoy!',
          `🧾 Your number: *${queueId}*`,
          `🪑 Counter: *${counterName}*`,
          '',
          'We will notify you via this Telegram chat when your number is called. You can close this chat or app — notifications will arrive automatically.'
        ].join('\n');

        await sendTelegram(userChatId, reply);
        return { statusCode: 200, body: 'OK' };
      }
      // attach failed — fall through to lookup by chatId / respond with instructions
    }

    // No token or attach failed — lookup by chatId
    const found = await findQueueByChatId(userChatId);
    if (found) {
      const q = found.entry;
      const queueId = q.queueId || q.number || q.ticket || 'Unknown';
      let counterName = 'Unassigned';
      if (q.counterId && FIREBASE_DB_URL) {
        const c = await fetchJson(`${FIREBASE_DB_URL}/counters/${encodeURIComponent(q.counterId)}.json`);
        if (c?.name) counterName = c.name;
      }
      const reply = [
        'ℹ️ Queue status for this Telegram chat:',
        `🧾 Number: *${queueId}*`,
        `🪑 Counter: *${counterName}*`,
        '',
        'We will send you a message when it is your turn.'
      ].join('\n');
      await sendTelegram(userChatId, reply);
      return { statusCode: 200, body: 'OK' };
    }

    // Not connected — send friendly instructions including a /start example
    const connectInstructions = [
      '👋 Hi — I could not find a Queue entry for this Telegram chat.',
      '',
      'To connect: open the QueueJoy status page you were given and tap *Connect via Telegram*. That runs `/start <token>` automatically and connects this chat.',
      '',
      'If you prefer, paste the token here and I will try to connect you.',
      '',
      'Example token format: `/start -OaVK...` or the token link on your status page.'
    ].join('\n');

    await sendTelegram(userChatId, connectInstructions, { parse_mode: 'Markdown' });
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Handler error', err);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};

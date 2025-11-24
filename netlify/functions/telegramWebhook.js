// netlify/functions/telegramWebhook.js
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
    const answerCallback = async (callbackQueryId, text = '') => {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false })
        });
      } catch (e) { /* ignore */ }
    };

    // --- helpers for token normalization & checking telegramTokens mapping ---
    const normalizeToken = (raw) => {
      if (!raw) return null;
      let t = String(raw).trim();

      // if it's a full URL with ?start= or &start= extract token
      try {
        if (t.includes('?')) {
          const u = new URL(t, 'https://example.invalid');
          if (u.searchParams.has('start')) {
            return u.searchParams.get('start');
          }
        }
      } catch (e) {
        // not a full URL — continue
      }

      // if it looks like "https://t.me/Bot?start=TOKEN" but URL parsing failed, fallback:
      const startIdx = t.indexOf('start=');
      if (startIdx !== -1) {
        return t.slice(startIdx + 6).split('&')[0];
      }

      // bare token
      return t || null;
    };

    const checkTelegramTokenRecord = async (candidateToken) => {
      if (!FIREBASE_DB_URL || !candidateToken) return null;
      const tokenPath = `${FIREBASE_DB_URL}/telegramTokens/${encodeURIComponent(candidateToken)}.json`;
      const rec = await fetchJson(tokenPath);
      if (!rec) return null;
      // optional expiry check
      if (rec.expiresAt) {
        const expires = Date.parse(rec.expiresAt);
        if (!isNaN(expires) && Date.now() > expires) {
          return { expired: true, record: rec };
        }
      }
      return { expired: false, record: rec };
    };

    // --- parse incoming update ---
    let update = {};
    try { update = JSON.parse(event.body || '{}'); } catch (e) {
      console.error('Invalid JSON body'); return { statusCode: 400, body: 'Invalid JSON' };
    }
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data;
      const from = cb.from;
      const chatId = cb.message?.chat?.id || from?.id;
      await answerCallback(cb.id);
      if (data === 'help') {
        const helpText = [
          '*QueueJoy Help*',
          '',
          '• You will receive a Telegram message when your number is called.',
          '• Keep Telegram installed — messages arrive even if the browser is closed.',
          '• If you see a wrong connection, ask staff to reconnect your number.',
          '',
          'Commands in chat: /help and /status.'
        ].join('\n');
        await sendTelegram(chatId, helpText, { parse_mode: 'Markdown' });
        return { statusCode: 200, body: 'OK' };
      }
if (data === 'status') {
  const found = await findQueueByChatId(chatId);
  if (!found) {
    await sendTelegram(chatId, 'No queue linked to this chat. Use the status page to connect.');
    return { statusCode: 200, body: 'OK' };
  }

  const q = found.entry;
  const queueId = q.queueId || q.number || q.ticket || 'Unknown';
  let counterName = 'Unassigned';
  if (q.counterId) {
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

  await sendTelegram(chatId, reply, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [ { text: '📲 Open Queue Status', url: `https://queuejoy.netlify.app/status.html?queueId=${encodeURIComponent(found.key)}` } ],
        [ { text: '📄 Help', callback_data: 'help' }, { text: '📊 Status', callback_data: 'status' } ]
      ]
    }
  });

  return { statusCode: 200, body: 'OK' };
}

    const msg = update.message || update.edited_message || null;
    const from = update.message?.from || null;
    const userChatId = msg?.chat?.id ?? from?.id ?? null;
    if (!userChatId) {
      console.log('No chat id in update — ignoring.');
      return { statusCode: 200, body: 'No chat id' };
    }
    const messageText = (msg?.text || msg?.caption || '').trim();

    if (messageText === '/help' || messageText === '/help@QueueJoyBot') {
      const helpText = [
        '*QueueJoy Help*',
        '',
        '• You will receive a Telegram message when your number is called.',
        '• Use the *Status* button or type /status to check your number.',
        '• If something is wrong, ask staff to reconnect your number at the kiosk.'
      ].join('\n');
      await sendTelegram(userChatId, helpText, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [ { text: '📊 Status', callback_data: 'status' }, { text: '📲 Open Status Page', url: `https://queuejoy.netlify.app/status.html` } ]
          ]
        }
      });
      return { statusCode: 200, body: 'OK' };
    }
    if (messageText === '/status' || messageText === '/status@QueueJoyBot') {
      const found = await (async (chatId) => {
        if (!FIREBASE_DB_URL) return null;
        const url = `${FIREBASE_DB_URL}/queue.json?orderBy="chatId"&equalTo="${chatId}"`;
        const q = await fetchJson(url);
        if (!q) return null;
        const key = Object.keys(q)[0];
        return { key, entry: q[key] };
      })(userChatId);
      if (found) {
        const q = found.entry;
        const queueId = q.queueId || q.number || q.ticket || 'Unknown';
        const counterName = q.counterId ? ((await fetchJson(`${FIREBASE_DB_URL}/counters/${encodeURIComponent(q.counterId)}.json`))?.name || q.counterId) : 'Unassigned';
        const reply = `ℹ️ Queue status:\n🧾 Number: *${queueId}*\n🪑 Counter: *${counterName}*`;
        await sendTelegram(userChatId, reply, { parse_mode: 'Markdown' });
      } else {
        await sendTelegram(userChatId, 'No queue linked to this chat. Connect via the status page or paste your token here.');
      }
      return { statusCode: 200, body: 'OK' };
    }

    const tryDecodeBase64Json = (token) => {
      try { const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
        const pad = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : ''; const b = Buffer.from(normalized + pad, 'base64').toString('utf8'); return JSON.parse(b); } catch (e) { return null; }
    };

    let token = null;
    const startMatch = messageText.match(/\/start(?:@[\w_]+)?(?:\s+(.+))?$/i);
    if (startMatch) {
      token = (startMatch[1] || '').trim() || null;
    } else if (messageText && messageText.length < 200) {
      token = messageText;
    }

    const attachChatToQueue = async (candidateToken) => {
      if (!FIREBASE_DB_URL) return { ok: false, reason: 'no-firebase' };

      // normalize token (strip url parts if user pasted a full link)
      const normalized = normalizeToken(candidateToken);
      if (!normalized) return { ok: false, reason: 'empty-token' };

      // --- 1) CHECK telegramTokens mapping first (tokens generated by createTelegramLink.js) ---
      try {
        const tokenRec = await checkTelegramTokenRecord(normalized);
        if (tokenRec) {
          if (tokenRec.expired) {
            console.warn('Token found but expired:', normalized);
            return { ok: false, reason: 'token-expired' };
          }
          const rec = tokenRec.record;
          // require a queueKey to be present on the token record
          if (rec && rec.queueKey) {
            const qKey = String(rec.queueKey);
            // patch the queue entry
            const queueUrl = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(qKey)}.json`;
            const patched = await patchJson(queueUrl, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
            if (patched) {
              // mark token used (non-fatal)
              try {
                await patchJson(`${FIREBASE_DB_URL}/telegramTokens/${encodeURIComponent(normalized)}.json`, {
                  used: true,
                  usedAt: new Date().toISOString(),
                  chatId: userChatId,
                  linkedQueueKey: qKey
                });
              } catch (e) { /* ignore token mark failures */ }
              return { ok: true, queueKey: qKey, via: 'telegramTokens' };
            } else {
              return { ok: false, reason: 'patch-failed' };
            }
          }
        }
      } catch (e) {
        console.warn('Error checking telegramTokens mapping', e);
      }

      // --- existing heuristics (unchanged) ---
      if (/^-[A-Za-z0-9_]+$/.test(normalized)) {
        const url = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(normalized)}.json`;
        const patch = await patchJson(url, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
        return patch ? { ok: true, queueKey: normalized, patched: patch } : { ok: false, reason: 'patch-failed' };
      }
      const parsed = tryDecodeBase64Json(normalized);
      if (parsed && typeof parsed === 'object') {
        const keys = ['queueKey', 'queueId', 'id', 'ticket', 'number'];
        let found = null;
        for (const k of keys) if (parsed[k]) { found = { key: k, value: String(parsed[k]) }; break; }
        if (found && found.key === 'queueKey' && /^-/.test(found.value)) {
          const url = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(found.value)}.json`;
          const patch = await patchJson(url, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
          return patch ? { ok: true, queueKey: found.value, patched: patch } : { ok: false, reason: 'patch-failed' };
        }
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
      if (/^[A-Za-z]{0,3}\d{1,5}|^[A-Za-z0-9\-_]{2,20}$/.test(normalized)) {
        const qid = encodeURIComponent(normalized);
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

    if (token) {
const attachResult = await attachChatToQueue(token);

if (attachResult && attachResult.ok) {

  // --- record user chatId for announcements (push into /announcement/chatIds) ---
  if (userChatId) {
    const chatIdRef = `${FIREBASE_DB_URL}/announcement/chatIds/${userChatId}.json`;
    await fetch(chatIdRef, {
      method: 'PUT',  // PUT = create or overwrite (idempotent)
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(true)
    });
    console.log('Added chatId to /announcement/chatIds (object):', userChatId);
  }

  // existing code: fetch queue & counter info
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
        await sendTelegram(userChatId, reply, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [ { text: '📲 Open Queue Status', url: `https://queuejoy.netlify.app/status.html?queueId=${encodeURIComponent(attachResult.queueKey)}` } ],
              [ { text: '📄 Help', callback_data: 'help' }, { text: '📊 Status', callback_data: 'status' } ]
            ]
          }
        });
        return { statusCode: 200, body: 'OK' };
      }
    }

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
      await sendTelegram(userChatId, reply, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [ [ { text: '📄 Help', callback_data: 'help' }, { text: '📊 Status', callback_data: 'status' } ] ] }
      });
      return { statusCode: 200, body: 'OK' };
    }

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

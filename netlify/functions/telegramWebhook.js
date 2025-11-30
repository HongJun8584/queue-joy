// netlify/functions/telegramWebhook.js
const fetch = globalThis.fetch || require('node-fetch');

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

    // ---- Helpers ----
    const fetchJson = async (url, opts = {}) => {
      try {
        const res = await fetch(url, opts);
        const txt = await res.text().catch(() => null);
        if (!res.ok) {
          console.warn('fetchJson non-ok', res.status, url, txt);
          return null;
        }
        try { return JSON.parse(txt); } catch (e) { return txt; }
      } catch (e) {
        console.error('fetchJson error', e, url);
        return null;
      }
    };

    const patchJson = async (url, body) => {
      try {
        const res = await fetch(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!res.ok) { console.warn('patchJson failed', res.status, url); return null; }
        return await res.json();
      } catch (e) { console.error('patchJson error', e, url); return null; }
    };

    const putJson = async (url, body) => {
      try {
        const res = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!res.ok) { console.warn('putJson failed', res.status, url); return null; }
        return await res.json();
      } catch (e) { console.error('putJson error', e, url); return null; }
    };

    const sendTelegram = async (chatId, text, extra = {}) => {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
      try {
        const body = {
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
          ...extra
        };
        if (!body.parse_mode) body.parse_mode = 'Markdown';
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
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

    // basic Markdown escape (for Markdown, not MarkdownV2)
    const escapeForMarkdown = (s = '') => {
      return String(s)
        .replace(/\\/g, '\\\\')
        .replace(/\*/g, '\\*')
        .replace(/_/g, '\\_')
        .replace(/`/g, '\\`')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');
    };

    // ---- Token helpers ----
    const normalizeToken = (raw) => {
      if (!raw) return null;
      let t = String(raw).trim();
      try {
        if (t.includes('?')) {
          const u = new URL(t, 'https://example.invalid');
          if (u.searchParams.has('start')) return u.searchParams.get('start');
        }
      } catch (e) {}
      const startIdx = t.indexOf('start=');
      if (startIdx !== -1) return t.slice(startIdx + 6).split('&')[0];
      return t || null;
    };

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

    const checkTelegramTokenRecord = async (candidateToken) => {
      if (!FIREBASE_DB_URL || !candidateToken) return null;
      const tokenPath = `${FIREBASE_DB_URL}/telegramTokens/${encodeURIComponent(candidateToken)}.json`;
      return await fetchJson(tokenPath);
    };

    // ---- Firebase helpers ----
    // Safe RTDB query for chatId
    const findQueueByChatId = async (chatId) => {
      if (!FIREBASE_DB_URL) return null;
      try {
        // 1) Proper equalTo query (JSON encoded)
        const qUrl = `${FIREBASE_DB_URL}/queue.json?orderBy="chatId"&equalTo=${encodeURIComponent(JSON.stringify(chatId))}`;
        const q = await fetchJson(qUrl);
        if (q && Object.keys(q).length) {
          const key = Object.keys(q)[0];
          return { key, entry: q[key] };
        }
        // 2) Fallback: fetch all and scan (handles types or DB differences)
        const all = await fetchJson(`${FIREBASE_DB_URL}/queue.json`);
        if (!all) return null;
        for (const k of Object.keys(all)) {
          const e = all[k];
          if (!e) continue;
          if (e.chatId === chatId || String(e.chatId) === String(chatId)) {
            return { key: k, entry: e };
          }
        }
        return null;
      } catch (e) {
        console.error('findQueueByChatId', e);
        return null;
      }
    };

    const resolveCounterName = async (counterId) => {
      if (!counterId || !FIREBASE_DB_URL) return 'Unassigned';
      try {
        const c = await fetchJson(`${FIREBASE_DB_URL}/counters/${encodeURIComponent(counterId)}.json`);
        return c?.name || counterId || 'Unassigned';
      } catch (e) {
        return counterId || 'Unassigned';
      }
    };

    // Attach chat to queue using various heuristics
    const attachChatToQueue = async (candidateToken, userChatId) => {
      if (!FIREBASE_DB_URL) return { ok: false, reason: 'no-firebase' };
      const normalized = normalizeToken(candidateToken);
      if (!normalized) return { ok: false, reason: 'empty-token' };

      // 1) check telegramTokens mapping (if used)
      try {
        const rec = await checkTelegramTokenRecord(normalized);
        if (rec) {
          if (rec.expiresAt && Date.now() > Date.parse(rec.expiresAt)) {
            return { ok: false, reason: 'token-expired' };
          }
          if (rec.queueKey) {
            const qKey = String(rec.queueKey);
            const patched = await patchJson(`${FIREBASE_DB_URL}/queue/${encodeURIComponent(qKey)}.json`, {
              chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString()
            });
            if (patched) {
              // mark token used (best-effort)
              try {
                await patchJson(`${FIREBASE_DB_URL}/telegramTokens/${encodeURIComponent(normalized)}.json`, {
                  used: true, usedAt: new Date().toISOString(), chatId: userChatId, linkedQueueKey: qKey
                });
              } catch (e) {}
              return { ok: true, queueKey: qKey, via: 'telegramTokens' };
            }
            return { ok: false, reason: 'patch-failed' };
          }
        }
      } catch (e) {
        console.warn('checkTelegramTokenRecord error', e);
      }

      // 2) direct queue key style (starts with -)
      if (/^-[A-Za-z0-9_]+$/.test(normalized)) {
        const url = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(normalized)}.json`;
        const patch = await patchJson(url, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
        return patch ? { ok: true, queueKey: normalized } : { ok: false, reason: 'patch-failed' };
      }

      // 3) decode base64 JSON and look for queueKey/queueId/id/ticket/number
      const parsed = tryDecodeBase64Json(normalized);
      if (parsed && typeof parsed === 'object') {
        const keys = ['queueKey', 'queueId', 'id', 'ticket', 'number'];
        for (const k of keys) {
          if (parsed[k]) {
            const val = String(parsed[k]);
            if (k === 'queueKey' && /^-/.test(val)) {
              const patch = await patchJson(`${FIREBASE_DB_URL}/queue/${encodeURIComponent(val)}.json`, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
              return patch ? { ok: true, queueKey: val } : { ok: false, reason: 'patch-failed' };
            } else {
              // search by queueId
              const url = `${FIREBASE_DB_URL}/queue.json?orderBy="queueId"&equalTo=${encodeURIComponent(JSON.stringify(val))}`;
              const res = await fetchJson(url);
              if (res && Object.keys(res).length) {
                const firstKey = Object.keys(res)[0];
                const patch = await patchJson(`${FIREBASE_DB_URL}/queue/${encodeURIComponent(firstKey)}.json`, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
                return patch ? { ok: true, queueKey: firstKey } : { ok: false, reason: 'patch-failed' };
              }
            }
            break;
          }
        }
      }

      // 4) try matching by plain queueId pattern
      if (/^[A-Za-z0-9\-_]{2,30}$/.test(normalized)) {
        const val = String(normalized);
        const url = `${FIREBASE_DB_URL}/queue.json?orderBy="queueId"&equalTo=${encodeURIComponent(JSON.stringify(val))}`;
        const res = await fetchJson(url);
        if (res && Object.keys(res).length) {
          const firstKey = Object.keys(res)[0];
          const patch = await patchJson(`${FIREBASE_DB_URL}/queue/${encodeURIComponent(firstKey)}.json`, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
          return patch ? { ok: true, queueKey: firstKey } : { ok: false, reason: 'patch-failed' };
        }
      }

      return { ok: false, reason: 'no-match' };
    };

    // ---- Parse incoming update ----
    let update = {};
    try { update = JSON.parse(event.body || '{}'); } catch (e) { console.error('invalid json body'); return { statusCode: 400, body: 'Invalid JSON' }; }

    // handle callback_query
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data;
      const from = cb.from;
      const chatId = cb.message?.chat?.id || from?.id;
      await answerCallback(cb.id);

      if (data === 'help') {
        const helpText = [
          '*Need a Hand?*',
          '',
          'Check your number and counter with /status anytime.',
          '',
          'Telegram will notify you when it\'s your number — no need to keep the browser and telegram open.',
          '',
          'Relax and do your thing — we\'ll handle the queue.'
        ].join('\n');
        await sendTelegram(chatId, helpText);
        return { statusCode: 200, body: 'OK' };
      }

      if (data === 'status') {
        const found = await findQueueByChatId(chatId);
        if (found) {
          const q = found.entry;
          const queueId = q.queueId || q.number || q.ticket || 'Unknown';
          const counterName = await resolveCounterName(q.counterId);
          const reply = [
            '✅ Connected to QueueJoy!',
            `🧾 Your number: *${escapeForMarkdown(queueId)}*`,
            `🪑 Counter: *${escapeForMarkdown(counterName)}*`,
            '',
            'We will notify you via this Telegram chat when your number is called. You can close this chat or app — notifications will arrive automatically.'
          ].join('\n');
          await sendTelegram(chatId, reply);
        } else {
          await sendTelegram(chatId, 'No queue linked to this chat. Connect via the status page or paste your token here.');
        }
        return { statusCode: 200, body: 'OK' };
      }

      return { statusCode: 200, body: 'OK' };
    }

    // message handling
    const msg = update.message || update.edited_message || null;
    const from = msg?.from || null;
    const userChatId = msg?.chat?.id ?? from?.id ?? null;

    if (!userChatId) {
      console.log('No chat id in update — ignoring.');
      return { statusCode: 200, body: 'No chat id' };
    }

    const messageText = (msg?.text || msg?.caption || '').trim();

    // /help
    if (messageText === '/help' || messageText === '/help@QueueJoyBot') {
      const helpText = [
        '*Need a Hand?*',
        '',
        'Check your number and counter with /status anytime.',
        '',
        'Telegram will notify you when it\'s your number — no need to keep the browser and telegram open.',
        '',
        'Relax and do your thing — we\'ll handle the queue.'
      ].join('\n');
      await sendTelegram(userChatId, helpText, {
        reply_markup: {
          inline_keyboard: [
            [ { text: '📊 Status', callback_data: 'status' }, { text: '📲 Open Status Page', url: `https://queuejoy.netlify.app/status.html` } ]
          ]
        }
      });
      return { statusCode: 200, body: 'OK' };
    }

    // /status
    if (messageText === '/status' || messageText === '/status@QueueJoyBot') {
      const found = await findQueueByChatId(userChatId);
      if (found) {
        const q = found.entry;
        const queueId = q.queueId || q.number || q.ticket || 'Unknown';
        const counterName = await resolveCounterName(q.counterId);
        const reply = [
          '✅ Connected to QueueJoy!',
          `🧾 Your number: *${escapeForMarkdown(queueId)}*`,
          `🪑 Counter: *${escapeForMarkdown(counterName)}*`,
          '',
          'We will notify you via this Telegram chat when your number is called. You can close this chat or app — notifications will arrive automatically.'
        ].join('\n');
        await sendTelegram(userChatId, reply, {
          reply_markup: {
            inline_keyboard: [ [ { text: '📄 Help', callback_data: 'help' } ] ]
          }
        });
      } else {
        await sendTelegram(userChatId, 'No queue linked to this chat. Connect via the status page or paste your token here.');
      }
      return { statusCode: 200, body: 'OK' };
    }

    // parse /start <token> or token text
    let token = null;
    const startMatch = messageText.match(/^\/start(?:@[\w_]+)?(?:\s+(.+))?$/i);
    if (startMatch) {
      token = (startMatch[1] || '').trim() || null;
      // if just /start with no token, show helpful message
      if (!token) {
        const text = 'To connect your Telegram chat to your queue, open the status page from the kiosk and tap *Connect via Telegram*, or paste the token here (example: `/start -OaVK...`).';
        await sendTelegram(userChatId, text);
        return { statusCode: 200, body: 'OK' };
      }
    } else if (messageText && messageText.length < 200) {
      // maybe user pasted the token directly
      token = messageText;
    }

    if (token) {
      const attachResult = await attachChatToQueue(token, userChatId);
      if (attachResult && attachResult.ok) {
        // add to announcement list (idempotent)
        if (FIREBASE_DB_URL) {
          try {
            await putJson(`${FIREBASE_DB_URL}/announcement/chatIds/${encodeURIComponent(userChatId)}.json`, true);
            console.log('Added chatId to announcements:', userChatId);
          } catch (e) { console.warn('announce put failed', e); }
        }

        const q = await fetchJson(`${FIREBASE_DB_URL}/queue/${encodeURIComponent(attachResult.queueKey)}.json`);
        const queueId = q?.queueId || q?.number || q?.ticket || 'Unknown';
        const counterName = await resolveCounterName(q?.counterId);
        const reply = [
          '✅ Connected to QueueJoy!',
          `🧾 Your number: *${escapeForMarkdown(queueId)}*`,
          `🪑 Counter: *${escapeForMarkdown(counterName)}*`,
          '',
          'We will notify you via this Telegram chat when your number is called. You can close this chat or app — notifications will arrive automatically.'
        ].join('\n');

        await sendTelegram(userChatId, reply, {
          reply_markup: {
            inline_keyboard: [
              [ { text: '📲 Open Queue Status', url: `https://queuejoy.netlify.app/status.html?queueId=${encodeURIComponent(attachResult.queueKey)}` } ],
              [ { text: '📄 Help', callback_data: 'help' } ]
            ]
          }
        });

        return { statusCode: 200, body: 'OK' };
      } else {
        console.log('attach failed', attachResult);
        await sendTelegram(userChatId, 'Could not connect with that token. Please check the token or open your status page and use *Connect via Telegram*.');
        return { statusCode: 200, body: 'OK' };
      }
    }

    // fallback: if chat already linked, show summary
    const found = await findQueueByChatId(userChatId);
    if (found) {
      const q = found.entry;
      const queueId = q.queueId || q.number || q.ticket || 'Unknown';
      const counterName = await resolveCounterName(q.counterId);
      const reply = [
        'ℹ️ Queue status for this Telegram chat:',
        `🧾 Number: *${escapeForMarkdown(queueId)}*`,
        `🪑 Counter: *${escapeForMarkdown(counterName)}*`,
        '',
        'We will send you a message when it is your turn.'
      ].join('\n');
      await sendTelegram(userChatId, reply, {
        reply_markup: { inline_keyboard: [ [ { text: '📄 Help', callback_data: 'help' } ] ] }
      });
      return { statusCode: 200, body: 'OK' };
    }

    // final fallback: show connect instructions
    const connectInstructions = [
      '👋 Hi — I could not find a Queue entry for this Telegram chat.',
      '',
      'To connect: open the QueueJoy status page you were given and tap *Connect via Telegram*. That runs `/start <token>` automatically and connects this chat.',
      '',
      'If you prefer, paste the token here and I will try to connect you.',
      '',
      'Example token format: `/start -OaVK...` or the token link on your status page.'
    ].join('\n');

    await sendTelegram(userChatId, connectInstructions);
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Handler error', err);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};

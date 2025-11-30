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

    // --- helpers ---
    const fetchJson = async (url, opts = {}) => {
      try {
        const res = await fetch(url, opts);
        if (!res.ok) {
          const txt = await res.text().catch(() => null);
          console.warn('fetchJson non-ok', res.status, url, txt);
          return null;
        }
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
        if (!res.ok) {
          const txt = await res.text().catch(() => null);
          console.warn('patchJson failed', res.status, url, txt);
          return null;
        }
        return await res.json();
      } catch (e) {
        console.error('patchJson error', e, url);
        return null;
      }
    };

    const putJson = async (url, bodyObj) => {
      try {
        const res = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyObj)
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => null);
          console.warn('putJson failed', res.status, url, txt);
          return null;
        }
        return await res.json();
      } catch (e) {
        console.error('putJson error', e, url);
        return null;
      }
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
        // default to MarkdownV2 for safer escaping when we provide escaped text
        if (!body.parse_mode) body.parse_mode = 'MarkdownV2';
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

    // Escape for MarkdownV2 (Telegram) so user-supplied text doesn't break formatting.
    const escapeMarkdownV2 = (s = '') => {
      return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
    };

    // --- token helpers ---
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

      // fallback: start= inside string
      const startIdx = t.indexOf('start=');
      if (startIdx !== -1) {
        return t.slice(startIdx + 6).split('&')[0];
      }

      return t || null;
    };

    const checkTelegramTokenRecord = async (candidateToken) => {
      if (!FIREBASE_DB_URL || !candidateToken) return null;
      const tokenPath = `${FIREBASE_DB_URL}/telegramTokens/${encodeURIComponent(candidateToken)}.json`;
      const rec = await fetchJson(tokenPath);
      if (!rec) return null;
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

    // callbacks (inline buttons)
    if (update.callback_query) {
      const cb = update.callback_query;
      const data = cb.data;
      const from = cb.from;
      const chatId = cb.message?.chat?.id || from?.id;
      await answerCallback(cb.id);

      if (data === 'help') {
        const helpText = [
          '*Need a Hand\\?*',
          '',
          'Check your number and counter with /status anytime.',
          '',
          'Telegram will notify you when it’s your number — no need to keep the browser and telegram open.',
          '',
          'Relax and do your thing — we’ll handle the queue.'
        ].join('\n');
        // Use MarkdownV2; message is already plain text so fine to send.
        await sendTelegram(chatId, helpText, { parse_mode: 'MarkdownV2' });
        return { statusCode: 200, body: 'OK' };
      }
      if (data === 'status') {
        // reuse later code path: try to fetch by chatId and reply
        // We'll call the same function below by building a small wrapper:
        const replyByChatId = async (cid) => {
          const found = await findQueueByChatId(cid);
          if (found) {
            const q = found.entry;
            const queueId = q.queueId || q.number || q.ticket || 'Unknown';
            const counterName = await resolveCounterName(q.counterId);
            const reply = buildConnectedReply(queueId, counterName);
            await sendTelegram(cid, reply, { parse_mode: 'MarkdownV2' });
          } else {
            await sendTelegram(cb.from.id, 'No queue linked to this chat. Connect via the status page or paste your token here.');
          }
        };
        await replyByChatId(chatId);
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

    // HELP command
    if (messageText === '/help' || messageText === '/help@QueueJoyBot') {
      const helpText = [
        '*Need a Hand\\?*',
        '',
        'Check your number and counter with /status anytime.',
        '',
        'Telegram will notify you when it’s your number — no need to keep the browser and telegram open.',
        '',
        'Relax and do your thing — we’ll handle the queue.'
      ].join('\n');

      await sendTelegram(userChatId, helpText, {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [
            [ { text: '📊 Status', callback_data: 'status' }, { text: '📲 Open Status Page', url: `https://queuejoy.netlify.app/status.html` } ]
          ]
        }
      });
      return { statusCode: 200, body: 'OK' };
    }

    // /status command
    if (messageText === '/status' || messageText === '/status@QueueJoyBot') {
      const found = await (async (chatId) => {
        return await findQueueByChatId(chatId);
      })(userChatId);

      if (found) {
        const q = found.entry;
        const queueId = q.queueId || q.number || q.ticket || 'Unknown';
        const counterName = await resolveCounterName(q.counterId);
        const reply = buildConnectedReply(queueId, counterName);
        await sendTelegram(userChatId, reply, { parse_mode: 'MarkdownV2' });
      } else {
        await sendTelegram(userChatId, 'No queue linked to this chat. Connect via the status page or paste your token here.');
      }
      return { statusCode: 200, body: 'OK' };
    }

    // --- utility: resolve counter name from counterId ---
    async function resolveCounterName(counterId) {
      if (!counterId || !FIREBASE_DB_URL) return 'Unassigned';
      try {
        const c = await fetchJson(`${FIREBASE_DB_URL}/counters/${encodeURIComponent(counterId)}.json`);
        if (c?.name) return c.name;
      } catch (e) { /* ignore */ }
      return counterId || 'Unassigned';
    }

    // Format the connected reply using MarkdownV2 and escaped dynamic values
    function buildConnectedReply(queueIdRaw, counterNameRaw) {
      const queueId = escapeMarkdownV2(queueIdRaw);
      const counterName = escapeMarkdownV2(counterNameRaw);
      const lines = [
        '✅ Connected to QueueJoy!',
        `🧾 Your number: *${queueId}*`,
        `🪑 Counter: *${counterName}*`,
        '',
        'We will notify you via this Telegram chat when your number is called. You can close this chat or app — notifications will arrive automatically.'
      ];
      return lines.join('\n');
    }

    // --- try decode start token if user pasted /start or token text ---
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

    // --- attach chat to queue logic (uses FIREBASE) ---
    const attachChatToQueue = async (candidateToken) => {
      if (!FIREBASE_DB_URL) return { ok: false, reason: 'no-firebase' };

      const normalized = normalizeToken(candidateToken);
      if (!normalized) return { ok: false, reason: 'empty-token' };

      // 1) Check telegramTokens first
      try {
        const tokenRec = await checkTelegramTokenRecord(normalized);
        if (tokenRec) {
          if (tokenRec.expired) {
            console.warn('Token found but expired:', normalized);
            return { ok: false, reason: 'token-expired' };
          }
          const rec = tokenRec.record;
          if (rec && rec.queueKey) {
            const qKey = String(rec.queueKey);
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
              } catch (e) { /* ignore */ }
              return { ok: true, queueKey: qKey, via: 'telegramTokens' };
            } else {
              return { ok: false, reason: 'patch-failed' };
            }
          }
        }
      } catch (e) {
        console.warn('Error checking telegramTokens mapping', e);
      }

      // heuristics: direct queue key (starts with -)
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
          const qid = String(found.value);
          const url = `${FIREBASE_DB_URL}/queue.json?orderBy="queueId"&equalTo=${encodeURIComponent(JSON.stringify(qid))}`;
          const result = await fetchJson(url);
          if (result && Object.keys(result).length) {
            const firstKey = Object.keys(result)[0];
            const patchUrl = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(firstKey)}.json`;
            const patch = await patchJson(patchUrl, { chatId: userChatId, telegramConnected: true, connectedAt: new Date().toISOString() });
            return patch ? { ok: true, queueKey: firstKey, patched: patch } : { ok: false, reason: 'patch-failed' };
          }
        }
      }

      // try match by queueId/string pattern
      if (/^[A-Za-z]{0,3}\d{1,5}|^[A-Za-z0-9\-_]{2,20}$/.test(normalized)) {
        const qid = String(normalized);
        const url = `${FIREBASE_DB_URL}/queue.json?orderBy="queueId"&equalTo=${encodeURIComponent(JSON.stringify(qid))}`;
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

    // find queue by chatId with robust fallback
    const findQueueByChatId = async (chatId) => {
      if (!FIREBASE_DB_URL) return null;
      try {
        // 1) try a proper RTDB query (equalTo must be JSON encoded)
        const url = `${FIREBASE_DB_URL}/queue.json?orderBy="chatId"&equalTo=${encodeURIComponent(JSON.stringify(chatId))}`;
        const q = await fetchJson(url);
        if (q && Object.keys(q).length) {
          const key = Object.keys(q)[0];
          return { key, entry: q[key] };
        }

        // 2) fallback: fetch all queue entries and scan for matching chatId (handles cases where types differ)
        const all = await fetchJson(`${FIREBASE_DB_URL}/queue.json`);
        if (!all) return null;
        for (const k of Object.keys(all)) {
          const e = all[k];
          if (e && (e.chatId === chatId || String(e.chatId) === String(chatId))) {
            return { key: k, entry: e };
          }
        }
        return null;
      } catch (e) {
        console.error('findQueueByChatId error', e);
        return null;
      }
    };

    // If user sent a token (via /start or pasted) try to attach
    let token = null;
    const startMatch = messageText.match(/\/start(?:@[\w_]+)?(?:\s+(.+))?$/i);
    if (startMatch) {
      token = (startMatch[1] || '').trim() || null;
    } else if (messageText && messageText.length < 200) {
      token = messageText;
    }

    if (token) {
      const attachResult = await attachChatToQueue(token);

      if (attachResult && attachResult.ok) {
        // record chatId for announcements
        if (userChatId && FIREBASE_DB_URL) {
          try {
            const chatIdRef = `${FIREBASE_DB_URL}/announcement/chatIds/${encodeURIComponent(userChatId)}.json`;
            await putJson(chatIdRef, true);
            console.log('Added chatId to /announcement/chatIds:', userChatId);
          } catch (e) {
            console.warn('Failed to add chatId to announcement list', e);
          }
        }

        // fetch queue info to craft reply
        const q = await fetchJson(`${FIREBASE_DB_URL}/queue/${encodeURIComponent(attachResult.queueKey)}.json`);
        const queueId = q?.queueId || q?.number || q?.ticket || 'Unknown';
        let counterName = 'Unassigned';
        if (q?.counterId) {
          counterName = await resolveCounterName(q.counterId);
        }

        const reply = buildConnectedReply(queueId, counterName);
        await sendTelegram(userChatId, reply, {
          reply_markup: {
            inline_keyboard: [
              [ { text: '📲 Open Queue Status', url: `https://queuejoy.netlify.app/status.html?queueId=${encodeURIComponent(attachResult.queueKey)}` } ],
              [ { text: '📄 Help', callback_data: 'help' } ]
            ]
          }
        });

        return { statusCode: 200, body: 'OK' };
      }
      // if not ok, continue on to "not found" messages below
    }

    // If we get here, no token attach happened — check if a queue is already linked
    const found = await findQueueByChatId(userChatId);
    if (found) {
      const q = found.entry;
      const queueId = q.queueId || q.number || q.ticket || 'Unknown';
      const counterName = await resolveCounterName(q.counterId);
      const reply = [
        'ℹ️ Queue status for this Telegram chat:',
        `🧾 Number: *${escapeMarkdownV2(queueId)}*`,
        `🪑 Counter: *${escapeMarkdownV2(counterName)}*`,
        '',
        'We will send you a message when it is your turn.'
      ].join('\n');
      await sendTelegram(userChatId, reply, {
        reply_markup: { inline_keyboard: [ [ { text: '📄 Help', callback_data: 'help' } ] ] }
      });
      return { statusCode: 200, body: 'OK' };
    }

    // no queue associated; send connect instructions
    const connectInstructions = [
      '👋 Hi — I could not find a Queue entry for this Telegram chat.',
      '',
      'To connect: open the QueueJoy status page you were given and tap *Connect via Telegram*. That runs `/start <token>` automatically and connects this chat.',
      '',
      'If you prefer, paste the token here and I will try to connect you.',
      '',
      'Example token format: `/start -OaVK...` or the token link on your status page.'
    ].join('\n');

    await sendTelegram(userChatId, connectInstructions, { parse_mode: 'MarkdownV2' });
    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Handler error', err);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};

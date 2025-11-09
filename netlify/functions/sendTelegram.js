// /netlify/functions/telegramWebhook.js
// Netlify (Node 18+). Env: BOT_TOKEN (required), CHAT_ID (optional admin).
//
// IMPORTANT: deploy this and then trigger a /start from your status page.
// The function will send a debug dump of the received "update" to your ADMIN chat so you can inspect it.

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed. Use POST.' };
    }

    let update = {};
    try {
      update = JSON.parse(event.body || '{}');
    } catch (err) {
      console.error('Invalid JSON body', err);
      return { statusCode: 400, body: 'Invalid JSON' };
    }

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const ADMIN_CHAT_ID = process.env.CHAT_ID || null;

    if (!BOT_TOKEN) {
      console.error('Missing BOT_TOKEN env');
      return { statusCode: 500, body: 'Missing BOT_TOKEN' };
    }

    async function sendTelegram(toChatId, text) {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: toChatId, text }),
        });
        try {
          const j = await res.json().catch(()=>null);
          if (!res.ok) console.warn('Telegram API non-ok', res.status, j);
        } catch(e){}
      } catch (e) {
        console.error('Failed to call Telegram API', e);
      }
    }

    // small helper to safely stringify + truncate
    function shortJSON(obj, max = 1500) {
      try {
        const s = JSON.stringify(obj, null, 0);
        if (s.length <= max) return s;
        return s.slice(0, max-3) + '...';
      } catch (e) {
        return String(obj).slice(0, max);
      }
    }

    // try to locate a message/chat id
    const msg = update.message || update.edited_message || update.channel_post || null;
    const chatId = (msg && msg.chat && typeof msg.chat.id !== 'undefined') ? msg.chat.id : null;
    // If chat id missing but callback_query exists, use that
    const cb = update.callback_query || null;
    if (!chatId && cb && cb.from && cb.from.id) {
      // not typical for /start, but support it
      // note: callback_query.chat_instance may not give chat id; use cb.message.chat.id if available
      if (cb.message && cb.message.chat && typeof cb.message.chat.id !== 'undefined') {
        // use cb.message.chat.id
      }
    }

    // For diagnostics: send the raw update (truncated) to admin chat
    if (ADMIN_CHAT_ID) {
      const dbg = `📡 Webhook received update:\n\n${shortJSON(update, 1800)}\n\n(Truncated)`;
      // send debug async but don't await too long
      try { await sendTelegram(ADMIN_CHAT_ID, dbg); } catch(e){ console.warn('Admin debug send failed', e); }
    }

    // If no message-like payload, nothing to do
    if (!msg && !cb) {
      return { statusCode: 200, body: 'No message or callback to handle' };
    }

    // Determine the user's chat id (for sending a DM reply)
    const userChatId = (msg && msg.chat && typeof msg.chat.id !== 'undefined') ? msg.chat.id
                      : (cb && cb.message && cb.message.chat && typeof cb.message.chat.id !== 'undefined') ? cb.message.chat.id
                      : (cb && cb.from && cb.from.id) ? cb.from.id
                      : null;

    if (!userChatId) {
      // still no user chat id: just return OK (admin already got raw update)
      return { statusCode: 200, body: 'No user chat id' };
    }

    // Token extraction strategy: try multiple places
    //  - message.text (most common)
    //  - message.caption (unlikely here)
    //  - callback_query.data
    //  - message.entities / bot_command combined remainder
    //  - full update text search for "/start <token>"
    //  - if token looks like URL, we'll attempt to extract queueId from its query param
    const text = String((msg && (msg.text || msg.caption)) || '').trim();
    const cbData = cb && cb.data ? String(cb.data).trim() : '';
    let tokenRaw = null;
    let debugSteps = [];

    // 1) Prefer message text: look for "/start" followed by something
    if (text) {
      // match "/start <anything>" - allow multiple spaces
      const m = text.match(/\/start(?:@[\w_]+)?\s+(.+)$/i);
      if (m && m[1]) {
        tokenRaw = m[1].trim();
        debugSteps.push('token from message text after /start');
      } else {
        // If text equals exactly "/start" then token may be missing here
        if (/^\/start(?:@[\w_]+)?$/i.test(text)) {
          debugSteps.push('message text is only /start (no token)');
        } else {
          // maybe user copied full t.me link into chat text; find token candidate in text
          const urlMatch = text.match(/t\.me\/[A-Za-z0-9_]+[?&]start=([^ \n]+)/i);
          if (urlMatch && urlMatch[1]) {
            tokenRaw = decodeURIComponent(urlMatch[1]);
            debugSteps.push('token extracted from t.me link in message text');
          }
        }
      }
    }

    // 2) callback query data
    if (!tokenRaw && cbData) {
      // callback data might contain "start=<token>" or just a token
      const m = cbData.match(/start=([^&\s]+)/i);
      if (m && m[1]) {
        tokenRaw = decodeURIComponent(m[1]);
        debugSteps.push('token from callback_query.data start param');
      } else {
        // fallback: use whole cbData as token candidate
        tokenRaw = cbData;
        debugSteps.push('token from callback_query.data (whole payload)');
      }
    }

    // 3) message.entities approach: if entities include bot_command, extract remainder of text after that entity
    if (!tokenRaw && msg && msg.entities && Array.isArray(msg.entities) && msg.text) {
      // find first bot_command entity
      const bc = msg.entities.find(e => e.type === 'bot_command' && e.offset === 0);
      if (bc) {
        const after = msg.text.slice(bc.length ? (bc.length + 0) : bc.offset); // fallback
        const remainder = msg.text.slice(bc.offset + bc.length).trim();
        if (remainder) {
          tokenRaw = remainder;
          debugSteps.push('token from text remainder after bot_command entity');
        }
      }
    }

    // 4) fallback: search anywhere for pattern "/start <token>" across the entire update JSON string
    if (!tokenRaw) {
      const ustr = JSON.stringify(update);
      const m = ustr.match(/\/start(?:@[\w_]+)?\s*([^"\\\s,\]\}]+)/i);
      if (m && m[1]) {
        tokenRaw = m[1];
        debugSteps.push('token found by regex scanning full update JSON');
      }
    }

    // Final fallback: if token is still null, double-check cb.message.text (if callback present)
    if (!tokenRaw && cb && cb.message && cb.message.text) {
      const m2 = String(cb.message.text).match(/\/start(?:@[\w_]+)?\s+(.+)$/i);
      if (m2 && m2[1]) {
        tokenRaw = m2[1].trim();
        debugSteps.push('token from callback.message.text after /start');
      }
    }

    // Short-circuit: if no token found, instruct user to use status page
    if (!tokenRaw) {
      await sendTelegram(userChatId,
        "Hi — to link your number open the QueueJoy status page you received and tap Connect via Telegram. The status page will run `/start <TOKEN>` for you. (This message is automatic.)"
      );

      // also notify admin with debug steps so you can see why no token was extracted
      if (ADMIN_CHAT_ID) {
        const adminDbg = `⚠️ No token extracted for a /start attempt.\nuserChatId: ${userChatId}\nsteps: ${debugSteps.join(' || ') || '(none)'}\nReceived text: ${text.slice(0,200)}\nCallback data: ${cbData.slice(0,200)}\n\nRaw update (truncated):\n${shortJSON(update, 1200)}`;
        try { await sendTelegram(ADMIN_CHAT_ID, adminDbg); } catch(e){console.warn('admin notify failed', e);}
      }

      return { statusCode: 200, body: 'No token provided' };
    }

    // Now we have tokenRaw — attempt to decode base64 JSON token or parse delimited token
    tokenRaw = String(tokenRaw).trim();
    let queueId = null;
    let counterName = 'TBD';
    const debugTokenInfo = [];

    // try base64 JSON decode
    try {
      const norm = tokenRaw.replace(/-/g, '+').replace(/_/g, '/');
      const pad = norm.length % 4;
      const padded = pad ? norm + '='.repeat(4 - pad) : norm;
      const decoded = Buffer.from(padded, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed === 'object') {
        if (parsed.queueId) queueId = String(parsed.queueId);
        if (parsed.queueId === undefined && parsed.queueKey) queueId = String(parsed.queueKey);
        if (parsed.counterId) counterName = String(parsed.counterId);
        if (parsed.counterName) counterName = String(parsed.counterName);
        debugTokenInfo.push('decoded base64 JSON token');
      }
    } catch (e) {
      // not base64 JSON — ignore
    }

    // if still not parsed, check for delimiters like '|' or ':' or '::'
    if (!queueId) {
      const delimiters = ['::', '|', ':'];
      for (const d of delimiters) {
        if (tokenRaw.includes(d)) {
          const [a,b] = tokenRaw.split(d,2);
          queueId = (a||'').trim();
          counterName = (b||'').trim() || counterName;
          debugTokenInfo.push(`parsed token with delimiter "${d}"`);
          break;
        }
      }
    }

    // if still not, if tokenRaw looks like URL with query containing queueId or start param
    if (!queueId && /^https?:\/\//i.test(tokenRaw)) {
      try {
        const u = new URL(tokenRaw);
        if (u.searchParams.has('queueId')) { queueId = u.searchParams.get('queueId'); debugTokenInfo.push('parsed queueId from URL param'); }
        else if (u.searchParams.has('start')) { queueId = u.searchParams.get('start'); debugTokenInfo.push('parsed start param from URL'); }
      } catch(e){}
    }

    // fallback: treat token as the queueId
    if (!queueId) {
      queueId = tokenRaw;
      debugTokenInfo.push('fallback token used as queueId');
    }

    queueId = String(queueId || 'TBD').trim();
    counterName = String(counterName || 'TBD').trim();

    // Build the friendly reply
    const replyLines = [
      '👋 Hey!',
      `🧾 Number • ${queueId}`,
      `🪑 Counter • ${counterName}`,
      '',
      'You are now connected — you can close the browser and Telegram. Everything will be automated. Just sit down and relax. ☕️😌'
    ];
    const replyText = replyLines.join('\n');

    // Send DM to user
    await sendTelegram(userChatId, replyText);

    // Notify admin about the connection + debug info
    if (ADMIN_CHAT_ID) {
      const adminMsg = `✅ User connected\nqueue: ${queueId}\ncounter: ${counterName}\nuserChatId: ${userChatId}\nrawToken: ${tokenRaw}\nparseSteps: ${debugSteps.join(' | ')}\nparseToken: ${debugTokenInfo.join(' | ')}\n\nRaw update (truncated):\n${shortJSON(update, 1200)}`;
      try { await sendTelegram(ADMIN_CHAT_ID, adminMsg); } catch(e){ console.warn('admin notify failed', e); }
    }

    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Unhandled webhook error', err);
    return { statusCode: 500, body: 'Webhook handler error' };
  }
};

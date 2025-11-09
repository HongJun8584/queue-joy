// /netlify/functions/telegramWebhook.js
// Netlify (Node 18+). Env: BOT_TOKEN (required), CHAT_ID (optional admin).
// Only handles /start commands and sends a single friendly reply to the user.

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let update = {};
    try { update = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const ADMIN_CHAT_ID = process.env.CHAT_ID || null;
    if (!BOT_TOKEN) return { statusCode: 500, body: 'Missing BOT_TOKEN' };

    // safe send helper
    async function sendTelegram(toChatId, text) {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: toChatId, text }),
        });
      } catch (e) { console.error('sendTelegram failed', e); }
    }

    // quick type checks to ensure this is a Telegram update we care about
    // Telegram updates normally include update_id; also require message object or callback_query
    const isTelegramUpdate = typeof update === 'object' && (typeof update.update_id !== 'undefined' || typeof update.message !== 'undefined' || typeof update.callback_query !== 'undefined');
    if (!isTelegramUpdate) return { statusCode: 200, body: 'Ignored non-Telegram payload' };

    // prefer message / edited_message / callback_query.message
    const rawMsg = (update.message && typeof update.message === 'object') ? update.message
                 : (update.edited_message && typeof update.edited_message === 'object') ? update.edited_message
                 : (update.channel_post && typeof update.channel_post === 'object') ? update.channel_post
                 : null;

    const cb = update.callback_query && typeof update.callback_query === 'object' ? update.callback_query : null;

    // determine user chat id
    const userChatId = (rawMsg && rawMsg.chat && typeof rawMsg.chat.id !== 'undefined') ? rawMsg.chat.id
                      : (cb && cb.message && cb.message.chat && typeof cb.message.chat.id !== 'undefined') ? cb.message.chat.id
                      : (cb && cb.from && cb.from.id) ? cb.from.id
                      : null;

    if (!userChatId) return { statusCode: 200, body: 'No chat id' };

    // find candidate text where /start may appear (only if message is object and contains text/caption)
    const text = rawMsg && (typeof rawMsg.text === 'string' || typeof rawMsg.caption === 'string')
                 ? (rawMsg.text || rawMsg.caption).trim()
                 : '';
    const cbData = cb && typeof cb.data === 'string' ? cb.data.trim() : '';

    // Only handle /start commands. If no /start found, ignore.
    // Accept forms like "/start", "/start TOKEN", "/start@BotName TOKEN"
    let startToken = null;
    if (text) {
      const m = text.match(/\/start(?:@[\w_]+)?(?:\s+(.+))?$/i);
      if (m) {
        startToken = (m[1] || '').trim() || null;
      }
    }
    // also accept callback_query data containing start=...
    if (!startToken && cbData) {
      const m2 = cbData.match(/start=([^&\s]+)/i);
      if (m2) startToken = decodeURIComponent(m2[1]);
    }

    // If there's no /start at all, ignore (this prevents processing the "now serving" sends)
    if (startToken === null) {
      return { statusCode: 200, body: 'Ignored non-start message' };
    }

    // If /start was sent but with no token, guide the user (friendly)
    if (!startToken) {
      await sendTelegram(userChatId,
        '👋 Hi — to connect your number, open the QueueJoy status page you received and tap Connect via Telegram. That page will run the /start command automatically.'
      );
      return { statusCode: 200, body: 'No token provided' };
    }

    // token parsing helpers (base64 JSON support + common delimited forms)
    function tryDecodeBase64Json(s) {
      try {
        const normalized = s.replace(/-/g,'+').replace(/_/g,'/');
        const pad = normalized.length % 4;
        const withPad = pad ? normalized + '='.repeat(4 - pad) : normalized;
        const decoded = Buffer.from(withPad, 'base64').toString('utf8');
        return JSON.parse(decoded);
      } catch (e) { return null; }
    }

    // robustly pick a human-friendly queue number and counter name from token
    let queueNumber = null;
    let counterName = 'To be assigned';

    // 1) try base64 JSON
    const parsed = tryDecodeBase64Json(startToken);
    if (parsed && typeof parsed === 'object') {
      // try many possible key names (support queueUid, queueId, ticket, number, etc)
      const qKeys = ['queueId','queueKey','queueUid','id','queue','number','ticket','queue_id','queue_uid','label'];
      const cKeys = ['counterId','counterName','counter','displayName','counter_name','counter_id'];

      for (const k of qKeys) if (parsed[k]) { queueNumber = String(parsed[k]); break; }
      for (const k of cKeys) if (parsed[k]) { counterName = String(parsed[k]); break; }
      // nested data object support
      if (!queueNumber && parsed.data && typeof parsed.data === 'object') {
        for (const k of qKeys) if (parsed.data[k]) { queueNumber = String(parsed.data[k]); break; }
      }
    }

    // 2) delimiter fallback (e.g., "A1|Counter 1" or "A1:Counter 1")
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

    // 3) url param fallback (if token was a url)
    if (!queueNumber && /^https?:\/\//i.test(startToken)) {
      try {
        const url = new URL(startToken);
        if (url.searchParams.has('queueId')) queueNumber = url.searchParams.get('queueId');
        else if (url.searchParams.has('start')) queueNumber = url.searchParams.get('start');
      } catch(e){}
    }

    // 4) final fallback: use token itself
    if (!queueNumber) queueNumber = String(startToken);

    // sanitize small (if token is a DB push id like -Odb..., there's nothing we can map without DB)
    queueNumber = String(queueNumber || 'Unknown').trim();
    counterName = String(counterName || 'To be assigned').trim();

    // Build single friendly message (exact format you requested)
    const lines = [
      '👋 Hey!',
      `🧾 Number • ${queueNumber}`,
      `🪑 Counter • ${counterName}`,
      '',
      'You are now connected — you can close the browser and Telegram. Everything will be automated. Just sit down and relax. ☕️😌'
    ];
    const reply = lines.join('\n');

    // Send one message to user
    await sendTelegram(userChatId, reply);

    // Optionally notify admin (compact; not shown to user) so you can monitor connections
    if (ADMIN_CHAT_ID) {
      try {
        const adminText = `🔔 Connected: ${queueNumber} • ${counterName}\nchatId: ${userChatId}`;
        await sendTelegram(ADMIN_CHAT_ID, adminText);
      } catch (e) { /* ignore admin errors */ }
    }

    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('Webhook handler error', err);
    return { statusCode: 500, body: 'Webhook handler error' };
  }
};

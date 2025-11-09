// /netlify/functions/telegramWebhook.js
// Node 18+ runtime (Netlify). Env: BOT_TOKEN (required), CHAT_ID (optional admin)

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed. Use POST.' };
    }

    let update;
    try {
      update = JSON.parse(event.body || '{}');
    } catch (err) {
      console.error('Invalid JSON body', err);
      return { statusCode: 400, body: 'Invalid JSON' };
    }

    const msg = update.message || update.edited_message;
    if (!msg || !msg.chat || typeof msg.chat.id === 'undefined') {
      return { statusCode: 200, body: 'No chat message to handle' };
    }

    const chatId = msg.chat.id;
    const rawText = String(msg.text || '').trim();
    const parts = rawText.split(/\s+/).filter(Boolean);
    const cmd = (parts[0] || '').toLowerCase();
    const tokenPart = parts.slice(1).join(' ') || null; // allow spaces inside token if encoded

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

    if (cmd !== '/start') {
      return { statusCode: 200, body: 'Ignored non-start message' };
    }

    if (!tokenPart) {
      // No token provided -> instruct how to connect
      await sendTelegram(chatId,
        "Hi — to link your number open the QueueJoy status page you received and tap Connect via Telegram. The status page will run `/start <TOKEN>` for you. (This message is automatic.)"
      );
      return { statusCode: 200, body: 'No token provided' };
    }

    const tokenRaw = String(tokenPart).trim();

    // Utility: try decode base64 JSON (URL-safe)
    function tryDecodeBase64Json(s) {
      try {
        const normalized = s.replace(/-/g,'+').replace(/_/g,'/');
        const pad = normalized.length % 4;
        const withPad = pad ? normalized + '='.repeat(4 - pad) : normalized;
        const decoded = Buffer.from(withPad, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (e) {}
      return null;
    }

    // Utility: try parse token from full URL (either token present as last path segment, or query param queueId/start)
    async function tryFetchUrlToken(urlStr) {
      try {
        const u = new URL(urlStr);
        // common: the connect flow might create a URL like https://.../status.html?queueId=ABC or include ?start=<token>
        const q = u.searchParams;
        if (q.has('queueId')) return { queueId: q.get('queueId') };
        if (q.has('start')) {
          const t = q.get('start');
          // see if start is base64 JSON
          const parsed = tryDecodeBase64Json(t);
          if (parsed) return parsed;
          return { queueId: t };
        }

        // as fallback: try to fetch the URL and look for obvious tokens in the html
        const res = await fetch(urlStr);
        if (!res.ok) return null;
        const html = await res.text();
        // attempt regex: queueId in query param placed as text (rare since status.html uses client JS)
        const qMatch = html.match(/[?&]queueId=([A-Za-z0-9_\-]+)/);
        if (qMatch && qMatch[1]) return { queueId: decodeURIComponent(qMatch[1]) };

        // attempt to read any embedded JSON object (look for "queueId":"...") in page source
        const jsonMatch = html.match(/"queueId"\s*:\s*"([^"]+)"/);
        if (jsonMatch && jsonMatch[1]) return { queueId: jsonMatch[1] };

      } catch (e) {
        // ignore
      }
      return null;
    }

    // Start parsing token
    let queueId = null;
    let counterName = 'TBD';
    let debugInfo = { tokenRaw };

    // 1) If token looks like a full URL -> try GET & parsing
    if (/^https?:\/\//i.test(tokenRaw)) {
      const parsed = await tryFetchUrlToken(tokenRaw);
      if (parsed) {
        if (parsed.queueId) queueId = String(parsed.queueId);
        if (parsed.counterName) counterName = String(parsed.counterName);
        debugInfo.urlParsed = true;
      }
    }

    // 2) Try base64 JSON decode of token
    if (!queueId) {
      const parsed = tryDecodeBase64Json(tokenRaw);
      if (parsed) {
        if (parsed.queueId) queueId = String(parsed.queueId);
        if (parsed.counterId) counterName = String(parsed.counterId);
        if (parsed.counterName) counterName = String(parsed.counterName);
        debugInfo.base64Json = true;
      }
    }

    // 3) If token contains delimiter like pipe or colon (e.g. "A023|Counter 1")
    if (!queueId) {
      const delim = tokenRaw.includes('|') ? '|' : (tokenRaw.includes(':') ? ':' : null);
      if (delim) {
        const [a,b] = tokenRaw.split(delim,2);
        if (a) queueId = String(a).trim();
        if (b) counterName = String(b).trim();
        debugInfo.delimited = delim;
      }
    }

    // 4) fallback: token as queueId
    if (!queueId) {
      // if token is short enough to be an id, accept it
      queueId = tokenRaw;
      debugInfo.fallback = true;
    }

    queueId = String(queueId || '').trim() || 'TBD';
    counterName = String(counterName || '').trim() || 'TBD';

    // Build reply
    const replyLines = [
      '👋 Hey!',
      `🧾 Number • ${queueId}`,
      `🪑 Counter • ${counterName}`,
      '',
      'You are now connected — you can close the browser and Telegram. Everything will be automated. Just sit down and relax. ☕️😌'
    ];
    const replyText = replyLines.join('\n');

    // Send DM to user
    await sendTelegram(chatId, replyText);

    // Notify admin with debug info so you can see the raw token if something's off
    if (ADMIN_CHAT_ID) {
      try {
        const adminMsg = `User connected: ${queueId} — Counter ${counterName}\nchatId: ${chatId}\nraw token: ${tokenRaw}\n_debug: ${JSON.stringify(debugInfo)}`;
        await sendTelegram(ADMIN_CHAT_ID, adminMsg);
      } catch (e) { /* ignore */ }
    }

    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Unhandled webhook error', err);
    return { statusCode: 500, body: 'Webhook handler error' };
  }
};

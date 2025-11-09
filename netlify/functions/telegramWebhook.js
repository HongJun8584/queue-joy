// /netlify/functions/telegramWebhook.js
// CommonJS for Netlify. Uses global fetch (Node 18+ runtime).
// Env required: BOT_TOKEN, CHAT_ID (optional admin notifications)

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

    // Accept new messages and edited messages
    const msg = update.message || update.edited_message;
    if (!msg || !msg.chat || typeof msg.chat.id === 'undefined') {
      return { statusCode: 200, body: 'No chat message to handle' };
    }

    const chatId = msg.chat.id;
    const rawText = String(msg.text || '').trim();
    const parts = rawText.split(/\s+/).filter(Boolean);
    const cmd = (parts[0] || '').toLowerCase();
    const token = parts[1] || null; // expected token from /start <token>

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const ADMIN_CHAT_ID = process.env.CHAT_ID || null;

    if (!BOT_TOKEN) {
      console.error('Missing BOT_TOKEN env');
      return { statusCode: 500, body: 'Missing BOT_TOKEN' };
    }

    // helper to send a telegram message (no external libs)
    async function sendTelegram(toChatId, text) {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: toChatId, text }),
        });
        // best-effort logging
        try {
          const j = await res.json().catch(() => null);
          if (!res.ok) console.warn('Telegram API non-ok', res.status, j);
        } catch (e) {}
      } catch (e) {
        console.error('Failed to call Telegram API', e);
      }
    }

    // Only handle /start commands
    if (cmd !== '/start') {
      return { statusCode: 200, body: 'Ignored non-start message' };
    }

    // If no token -> instruct user how to connect (we can't look up DB here)
    if (!token) {
      await sendTelegram(chatId,
        "Hi — to link your number open the QueueJoy status page you received and tap Connect via Telegram. The status page will run `/start <TOKEN>` for you. (This message is automatic.)"
      );
      return { statusCode: 200, body: 'No token provided' };
    }

    // sanitize token acceptance: allow common safe chars (alphanumeric plus few separators and base64 =)
    const rawToken = String(token).trim();
    if (!/^[A-Za-z0-9_\-.:|=]+$/.test(rawToken)) {
      await sendTelegram(chatId, "Token appears invalid. Please use the Connect button from the QueueJoy status page.");
      return { statusCode: 200, body: 'Invalid token format' };
    }

    // Heuristic parsing: try to extract queueId and counterName from token
    // Supports:
    //  - plain queueId (e.g., A023)
    //  - queueId|counterName  queueId:counterName  queueId::counterName
    //  - base64 JSON with {queueId, counterName}
    //  - fallback -> queueId = token, counterName = 'TBD'
    let queueId = null;
    let counterName = 'TBD';

    // helper: try base64 decode then JSON parse
    function tryParseBase64Json(str) {
      try {
        // normalize base64 url-safe
        const s = str.replace(/-/g, '+').replace(/_/g, '/');
        // pad
        const pad = s.length % 4;
        const padded = pad ? s + '='.repeat(4 - pad) : s;
        const decoded = Buffer.from(padded, 'base64').toString('utf8');
        const json = JSON.parse(decoded);
        if (json && typeof json === 'object') return json;
      } catch (e) {}
      return null;
    }

    // 1) If token looks like base64 JSON, try that first
    const maybeJson = tryParseBase64Json(rawToken);
    if (maybeJson) {
      if (maybeJson.queueId) queueId = String(maybeJson.queueId);
      if (maybeJson.counterName) counterName = String(maybeJson.counterName);
    }

    // 2) If not, try common delimiters
    if (!queueId) {
      const delimCandidates = ['::', '|', ':', '__'];
      let used = null;
      for (const d of delimCandidates) {
        if (rawToken.includes(d)) { used = d; break; }
      }
      if (used) {
        const [q, c] = rawToken.split(used, 2);
        if (q) queueId = q;
        if (c) counterName = c || counterName;
      }
    }

    // 3) fallback: treat token as queueId
    if (!queueId) queueId = rawToken;

    // sanitize small outputs
    queueId = String(queueId).trim() || 'TBD';
    counterName = String(counterName).trim() || 'TBD';

    // Format user reply with friendly closing copy you requested
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

    // Optionally notify admin chat with a short copy (if configured)
    if (ADMIN_CHAT_ID) {
      try {
        const adminMsg = `User connected: ${queueId} — Counter ${counterName} (chatId: ${chatId})`;
        await sendTelegram(ADMIN_CHAT_ID, adminMsg);
      } catch (e) { /* ignore */ }
    }

    return { statusCode: 200, body: 'OK' };

  } catch (err) {
    console.error('Unhandled webhook error', err);
    return { statusCode: 500, body: 'Webhook handler error' };
  }
};

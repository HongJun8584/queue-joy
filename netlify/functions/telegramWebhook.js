// /netlify/functions/telegramWebhook.js
// CommonJS for Netlify. Uses global fetch (Node 18+ runtime).
// Env: BOT_TOKEN (required), CHAT_ID (optional), FIREBASE_DB_URL (optional)

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
    const token = parts[1] || null; // expected token from /start <token>

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const ADMIN_CHAT_ID = process.env.CHAT_ID || null;
    const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');

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
        try { const j = await res.json().catch(()=>null); if (!res.ok) console.warn('Telegram API non-ok', res.status, j); } catch(e){}
      } catch (e) {
        console.error('Failed to call Telegram API', e);
      }
    }

    // Only handle /start commands
    if (cmd !== '/start') {
      return { statusCode: 200, body: 'Ignored non-start message' };
    }

    // If no token -> instruct user how to connect properly
    if (!token) {
      await sendTelegram(chatId,
        "Hi — to link your number open the QueueJoy status page you received and tap *Connect via Telegram*. The status page will invoke `/start <TOKEN>` for you. (This message is automatic.)"
      );
      return { statusCode: 200, body: 'No token provided' };
    }

    // token sanitization: allow alphanumeric, dash, underscore
    const safeToken = String(token).trim();
    if (!/^[\w-]+$/.test(safeToken)) {
      await sendTelegram(chatId, "Token appears invalid. Please use the Connect button from the QueueJoy status page.");
      return { statusCode: 200, body: 'Invalid token format' };
    }

    // Try to read queue entry from Firebase Realtime DB if configured
    let queueEntry = null;
    let counterEntry = null;
    if (FIREBASE_DB_URL) {
      try {
        const qUrl = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(safeToken)}.json`;
        const qRes = await fetch(qUrl, { method: 'GET' });
        if (qRes.ok) queueEntry = await qRes.json();
        else console.warn('Firebase queue GET non-ok', qRes.status);
      } catch (e) {
        console.warn('Firebase queue GET failed', e);
      }
    } else {
      console.warn('FIREBASE_DB_URL not set; cannot lookup queue entry');
    }

    // If queue entry missing -> inform user (no fake numbers)
    if (!queueEntry) {
      // fallback: tell user how to connect from the status page
      await sendTelegram(chatId,
        "We couldn't find a queue entry for that token. Open the QueueJoy status page (the page that gave you the token) and press the Telegram Connect button — it will run `/start <TOKEN>` automatically."
      );
      return { statusCode: 200, body: 'Queue entry not found' };
    }

    // require queueId
    const queueId = queueEntry.queueId || null; // e.g. "A023"
    const counterId = queueEntry.counterId || null;
    if (!queueId) {
      await sendTelegram(chatId,
        "We found your connection token but your queue number isn't assigned yet. Please stay on the status page and try Connect again once your number appears."
      );
      return { statusCode: 200, body: 'Queue entry missing queueId' };
    }

    // look up counter name if possible
    let counterName = null;
    if (counterId && FIREBASE_DB_URL) {
      try {
        const cUrl = `${FIREBASE_DB_URL}/counters/${encodeURIComponent(counterId)}.json`;
        const cRes = await fetch(cUrl, { method: 'GET' });
        if (cRes.ok) counterEntry = await cRes.json();
      } catch (e) {
        console.warn('Firebase counter GET failed', e);
      }
    }
    counterName = (counterEntry && (counterEntry.name || counterEntry.displayName)) || (counterId || 'TBD');

    // Attempt to persist chatId & connected flag back to the queue entry (best-effort)
    if (FIREBASE_DB_URL) {
      try {
        const patchUrl = `${FIREBASE_DB_URL}/queue/${encodeURIComponent(safeToken)}.json`;
        await fetch(patchUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId: chatId, telegramConnected: true }),
        });
      } catch (err) {
        console.warn('Failed to write chatId to Firebase (non-fatal)', err);
      }
    }

    // Build reply (only Hey, number, counter, and short hint)
    const replyLines = [
      '👋 Hey!',
      `🧾 Number • ${queueId}`,
      `🪑 Counter • ${counterName}`,
      '',
      'QueueJoy is keeping your spot in line.',
      "Leave this page open in the background (don't close it) — Telegram will DM you when it's your turn. 🎮"
    ];
    const replyText = replyLines.join('\n');

    // Send DM to user
    await sendTelegram(chatId, replyText);

    // Optionally notify admin chat with a short copy (if configured) so staff know user connected
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

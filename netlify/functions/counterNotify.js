// netlify/functions/notifyCounter.js
// POST JSON body:
// {
//   "calledFull": "A001",           // REQUIRED - the number called (prefix+number)
//   "counterName": "Service Desk",  // OPTIONAL - human name / display for the counter
//   "recipients": [
//     { "chatId": "123456", "theirNumber": "A003", "ticketId": "t-abc" },
//     ...
//   ]
// }
// Returns per-recipient results JSON.
//
// Env required: BOT_TOKEN
// Optional: CHAT_ID (ignored here except if no recipients provided)

export async function handler(event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Only POST allowed' }) };
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const FALLBACK_CHAT = process.env.CHAT_ID || null;

  if (!BOT_TOKEN) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing BOT_TOKEN env' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const calledFull = String(payload.calledFull || '').trim();
  const counterName = payload.counterName ? String(payload.counterName).trim() : '';
  const recipients = Array.isArray(payload.recipients) ? payload.recipients : [];

  if (!calledFull) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'calledFull is required' }) };
  }

  // Helper: safe sendMessage to Telegram
  const tgSendMessage = async (chatId, text) => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: String(chatId),
          text: String(text),
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });
      const bodyText = await res.text().catch(() => null);
      let bodyJson = null;
      try { bodyJson = bodyText ? JSON.parse(bodyText) : null; } catch(e){ /* not JSON */ }
      return { ok: res.ok, status: res.status, bodyJson, bodyText };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  };

  // Build the two message forms exactly as you requested
  const buildText = (called, theirNumber, counter) => {
    // if it's the same number (theirNumber == called) -> urgent message
    if (theirNumber && String(called).toLowerCase() === String(theirNumber).toLowerCase()) {
      // include counterName if provided
      return `🎯 Number ${called} is called — it's your turn! Please proceed to the counter${counter ? ' ' + counter : ''}.`;
    }
    // otherwise the exact phrase you asked
    return `Number ${called} is called. Your number is ${theirNumber}. Stay tuned!`;
  };

  // If no recipients provided, return error rather than broadcast (you said NO STAFF GROUP MESSAGE YET)
  if (!recipients.length) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'No recipients provided. Add recipients array with chatId and theirNumber.' })
    };
  }

  // send sequentially but fast; collect results
  const results = [];
  for (const r of recipients) {
    const chatId = r && (r.chatId || r.chat_id || r.id);
    const theirNumber = r && (r.theirNumber || r.number || r.recipientFull || r.fullNumber || '');
    const ticketId = r && (r.ticketId || r.ticket || null);

    if (!chatId) {
      results.push({ ok: false, error: 'missing chatId', recipient: r });
      continue;
    }

    const text = buildText(calledFull, theirNumber, counterName || '');
    // IMPORTANT: send to the user's chat id
    const sendRes = await tgSendMessage(chatId, text);
    results.push({ recipient: chatId, ticketId, theirNumber, result: sendRes });
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      calledFull,
      counterName,
      results
    })
  };
}

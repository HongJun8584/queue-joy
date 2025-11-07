// netlify/functions/announce.js
// Minimal, safe, production-ready announcer using BOT_TOKEN + CHAT_ID
// - Accepts POST JSON: { "message": "Hello", "parse_mode": "HTML" }
// - If MASTER_API_KEY env exists, requests must include header x-master-key or Authorization: Bearer <key>
// - Supports browser calls (CORS) and returns helpful JSON

export async function handler(event) {
  // CORS: allow browser clients (adjust origin if needed)
  const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-master-key',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
  };

  // OPTIONS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Only POST allowed' })
    };
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const CHAT_ID = process.env.CHAT_ID;
  const MASTER_KEY = process.env.MASTER_API_KEY || '';

  if (!BOT_TOKEN || !CHAT_ID) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'BOT_TOKEN and CHAT_ID must be set in environment' })
    };
  }

  // If MASTER_API_KEY is set, require caller to present it
  if (MASTER_KEY) {
    const provided =
      (event.headers && (event.headers['x-master-key'] || event.headers['X-Master-Key'])) ||
      (event.headers && event.headers['authorization']);
    const token = provided && String(provided).startsWith('Bearer ')
      ? String(provided).slice(7)
      : provided;
    if (!token || token !== MASTER_KEY) {
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Unauthorized (missing or invalid master key)' })
      };
    }
  }

  // parse body
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  const message = (payload.message || '').toString().trim();
  if (!message) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Missing message field' })
    };
  }

  // optional parse_mode (HTML or MarkdownV2)
  const parse_mode = (payload.parse_mode || 'HTML').toString();
  // Telegram max message length ~4096; truncate politely
  const MAX_LEN = 4000;
  const finalMessage = message.length > MAX_LEN ? message.slice(0, MAX_LEN) + '…' : message;

  // send to Telegram
  const api = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const bodyToSend = {
    chat_id: String(CHAT_ID),
    text: finalMessage,
    parse_mode,
    disable_web_page_preview: true
  };

  try {
    const res = await fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyToSend)
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      // Pass along Telegram error when possible
      const errMsg = (json && json.description) ? json.description : `Telegram error ${res.status}`;
      return {
        statusCode: 502,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Telegram send failed', detail: errMsg, raw: json })
      };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ok: true, deliveredTo: CHAT_ID, telegram: json })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Internal error sending to Telegram', detail: String(err) })
    };
  }
}

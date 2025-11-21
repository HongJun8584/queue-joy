// netlify/functions/announce.js
// CommonJS version for Netlify (no export keyword, no import syntax)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-master-key',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Only POST allowed' }) };
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const FIREBASE_DR_URL = (process.env.FIREBASE_DR_URL || '').trim();
  const MASTER_KEY = (process.env.MASTER_API_KEY || '').trim();

  const TELEGRAM_MAX_BYTES = parseInt(process.env.TELEGRAM_MAX_BYTES || String(5 * 1024 * 1024), 10);
  const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '4', 10);

  if (!BOT_TOKEN) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'BOT_TOKEN required' }) };
  }

  // Auth check
  if (MASTER_KEY) {
    const provided =
      event.headers['x-master-key'] ||
      event.headers['X-Master-Key'] ||
      event.headers['authorization'] ||
      event.headers['Authorization'];

    const token = provided && provided.startsWith('Bearer ')
      ? provided.slice(7)
      : provided;

    if (!token || token !== MASTER_KEY) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
  }

  // Parse body
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const message = (payload.message || '').toString();
  const media = payload.media || '';
  const mediaType = payload.mediaType || '';

  // Load dependencies (CommonJS)
  let fetch = global.fetch;
  if (!fetch) {
    try { fetch = require('node-fetch'); }
    catch (e) { return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'fetch not available' }) }; }
  }

  let FormData = global.FormData;
  if (!FormData) {
    try { FormData = require('form-data'); }
    catch (e) { return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'FormData not available' }) }; }
  }

  // Load DB (Firebase or local fallback)
  let root = null;
  const LOCAL_DB = '/mnt/data/queue-joy-aa21b-default-rtdb-export (4).json';

  try {
    if (FIREBASE_DR_URL) {
      const base = FIREBASE_DR_URL.replace(/\/$/, '');
      const r = await fetch(base + '.json');
      if (!r.ok) throw new Error('firebase fetch error');
      root = await r.json();
    } else {
      const fs = require('fs');
      if (fs.existsSync(LOCAL_DB)) {
        root = JSON.parse(fs.readFileSync(LOCAL_DB, 'utf8'));
      }
    }
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'DB load failed', detail: String(err) }) };
  }

  // Recursive chatId finder
  const results = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const k in node) {
      const lower = k.toLowerCase();
      const val = node[k];
      if (lower === 'chatid') {
        if (typeof val === 'number') results.add(val);
        else if (typeof val === 'string' && /^\d+$/.test(val)) results.add(Number(val));
      }
      if (val && typeof val === 'object') walk(val);
    }
  };

  walk(root);
  const recipients = Array.from(results);

  if (!recipients.length) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No chatId found in DB' }) };
  }

  // Prepare media buffer
  let buffer = null;
  if (media && mediaType) {
    try {
      const b64 = media.includes(',') ? media.split(',')[1] : media;
      buffer = Buffer.from(b64, 'base64');
    } catch (e) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid media base64' }) };
    }
  }

  // Helper for text only
  const sendText = async (chatId) => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const body = {
      chat_id: String(chatId),
      text: message,
      disable_web_page_preview: true
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return r.json();
  };

  // Helper for media
  const sendMedia = async (chatId) => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', message);

    // telegram chooses endpoint by type
    let endpoint = '';

    if (mediaType.startsWith('image/') && mediaType !== 'image/gif') {
      endpoint = 'sendPhoto';
      form.append('photo', buffer, { filename: 'photo.jpg', contentType: mediaType });
    } else if (mediaType === 'image/gif') {
      endpoint = 'sendAnimation';
      form.append('animation', buffer, { filename: 'anim.gif', contentType: 'image/gif' });
    } else if (mediaType.startsWith('video/')) {
      endpoint = 'sendVideo';
      form.append('video', buffer, { filename: 'video.mp4', contentType: mediaType });
    } else if (mediaType.startsWith('audio/')) {
      endpoint = 'sendAudio';
      form.append('audio', buffer, { filename: 'audio.mp3', contentType: mediaType });
    } else {
      endpoint = 'sendDocument';
      form.append('document', buffer, { filename: 'file.bin', contentType: mediaType });
    }

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`;
    const r = await fetch(url, {
      method: 'POST',
      body: form,
      headers: form.getHeaders()
    });

    return r.json();
  };

  // Send to all (sequential to avoid rate limits)
  const summary = [];

  for (const chatId of recipients) {
    try {
      let res;

      if (buffer) {
        if (buffer.length > TELEGRAM_MAX_BYTES) {
          summary.push({ chatId, ok: false, error: 'Media exceeds Telegram 5MB limit' });
          continue;
        }
        res = await sendMedia(chatId);
      } else {
        res = await sendText(chatId);
      }

      if (!res.ok) {
        summary.push({ chatId, ok: false, error: res.description });
      } else {
        summary.push({ chatId, ok: true });
      }

      await new Promise(r => setTimeout(r, 50)); // small delay

    } catch (err) {
      summary.push({ chatId, ok: false, error: String(err) });
    }
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      ok: true,
      total: recipients.length,
      results: summary
    })
  };
};

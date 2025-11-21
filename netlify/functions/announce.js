// netlify/functions/announce.js
// Sends a broadcast to Telegram chatIds stored under /telegramUsers in your Firebase RTDB.
//
// Env:
//  - BOT_TOKEN (required)
//  - FIREBASE_DB_URL (required)  e.g. https://your-db.firebaseio.com
//  - MASTER_API_KEY (optional)  - when set, requires X-Master-Key header (or Authorization Bearer) to call
//  - TELEGRAM_MAX_BYTES (optional) default 5MB
//  - MAX_CONCURRENCY (optional) default 4
//  - MAX_RETRIES (optional) default 3
//
// POST body JSON:
// {
//   "message": "text to send",           // required (string)
//   "media": "<base64-data or dataURI>", // optional
//   "mediaType": "image/png"             // optional (mime-type)
//   "queueKey": "-Oe_..."                // optional: only send to users with this queueKey
//   "chatIds": [123, 456]                // optional: explicit recipients override telegramUsers
// }

const fetch = global.fetch || (() => {
  try { return require('node-fetch'); } catch (e) { return null; }
})();

const FormDataImpl = global.FormData || (() => {
  try { return require('form-data'); } catch (e) { return null; }
})();

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-master-key',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Only POST allowed' }) };

  const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
  const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');
  const MASTER_KEY = (process.env.MASTER_API_KEY || '').trim();
  const TELEGRAM_MAX_BYTES = parseInt(process.env.TELEGRAM_MAX_BYTES || String(5 * 1024 * 1024), 10);
  const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '4', 10);
  const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);

  if (!BOT_TOKEN) return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'BOT_TOKEN required' }) };
  if (!FIREBASE_DB_URL) return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'FIREBASE_DB_URL required' }) };

  // Optional master-key auth
  if (MASTER_KEY) {
    const provided = event.headers['x-master-key'] || event.headers['X-Master-Key'] || event.headers['authorization'] || event.headers['Authorization'];
    const token = provided && provided.startsWith('Bearer ') ? provided.slice(7) : provided;
    if (!token || token !== MASTER_KEY) return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // parse body
  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }
  const message = (payload.message ?? '').toString();
  const media = payload.media || '';
  const mediaType = payload.mediaType || '';
  const filterQueueKey = payload.queueKey || null;
  const explicitChatIds = Array.isArray(payload.chatIds) ? payload.chatIds.map(String) : null; // override if provided

  if (!message && !media) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Provide message or media' }) };

  // fetch /telegramUsers
  let usersObj = null;
  try {
    const resp = await fetch(`${FIREBASE_DB_URL}/telegramUsers.json`);
    if (!resp.ok) throw new Error(`Firebase returned ${resp.status}`);
    usersObj = await resp.json();
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to fetch telegramUsers', detail: String(err) }) };
  }

  // build recipient list
  let recipients = [];
  if (explicitChatIds && explicitChatIds.length) {
    recipients = explicitChatIds;
  } else {
    if (!usersObj || typeof usersObj !== 'object') {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No telegramUsers found' }) };
    }
    for (const key of Object.keys(usersObj)) {
      // key is chatId string; value may contain queueKey metadata
      const val = usersObj[key];
      if (filterQueueKey) {
        if (val && String(val.queueKey || '') === String(filterQueueKey)) recipients.push(String(key));
      } else {
        recipients.push(String(key));
      }
    }
  }

  // dedupe and validate numeric chatIds
  recipients = Array.from(new Set(recipients)).filter(id => id && /^-?\d+$/.test(String(id)));
  if (!recipients.length) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No recipients found' }) };

  // prepare media buffer
  let buffer = null;
  if (media && mediaType) {
    try {
      const b64 = (typeof media === 'string' && media.includes(',')) ? media.split(',')[1] : media;
      buffer = Buffer.from(b64, 'base64');
      if (buffer.length > TELEGRAM_MAX_BYTES) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'media-too-large' }) };
      }
    } catch (e) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid media base64', detail: String(e) }) };
    }
  }

  // helper type checks
  const isVideo = t => !!(t && t.startsWith && t.startsWith('video/'));
  const isGif = t => t === 'image/gif';
  const isPhoto = t => !!(t && t.startsWith && t.startsWith('image/') && !isGif(t));
  const isAudio = t => !!(t && t.startsWith && t.startsWith('audio/'));

  // choose fetch implementation
  let f = fetch;
  if (!f) {
    try { f = require('node-fetch'); } catch (e) { return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'fetch not available' }) }; }
  }

  // send single recipient
  const sendTo = async (chatId) => {
    // if media present, use multipart/form-data
    if (buffer && mediaType) {
      if (!FormDataImpl) return { ok: false, error: 'FormData not available' };
      const form = new FormDataImpl();
      form.append('chat_id', String(chatId));
      if (message) form.append('caption', message);

      let endpoint = 'sendDocument';
      if (isPhoto(mediaType)) { endpoint = 'sendPhoto'; form.append('photo', buffer, { filename: 'photo.jpg', contentType: mediaType }); }
      else if (isGif(mediaType)) { endpoint = 'sendAnimation'; form.append('animation', buffer, { filename: 'anim.gif', contentType: 'image/gif' }); }
      else if (isVideo(mediaType)) { endpoint = 'sendVideo'; form.append('video', buffer, { filename: 'video.mp4', contentType: mediaType }); }
      else if (isAudio(mediaType)) { endpoint = 'sendAudio'; form.append('audio', buffer, { filename: 'audio.mp3', contentType: mediaType }); }
      else { endpoint = 'sendDocument'; form.append('document', buffer, { filename: 'file.bin', contentType: mediaType || 'application/octet-stream' }); }

      const url = `https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`;
      const headers = (form.getHeaders && typeof form.getHeaders === 'function') ? form.getHeaders() : {};
      const res = await f(url, { method: 'POST', body: form, headers });
      let j = null;
      try { j = await res.json(); } catch (e) { j = null; }
      if (!res.ok || (j && j.ok === false)) return { ok: false, error: (j && j.description) ? j.description : `status ${res.status}`, raw: j };
      return { ok: true, result: j };
    }

    // text-only sendMessage
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const body = { chat_id: String(chatId), text: message, disable_web_page_preview: true };
    const res = await f(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (!res.ok || (j && j.ok === false)) return { ok: false, error: (j && j.description) ? j.description : `status ${res.status}`, raw: j };
    return { ok: true, result: j };
  };

  // concurrency limiter
  const pLimit = (concurrency) => {
    let active = 0, q = [];
    const next = () => {
      if (!q.length) return;
      if (active >= concurrency) return;
      active++;
      const job = q.shift();
      job.fn().then(job.resolve).catch(job.reject).finally(()=>{ active--; next(); });
    };
    return (fn) => new Promise((resolve, reject)=>{ q.push({ fn, resolve, reject }); next(); });
  };
  const limit = pLimit(MAX_CONCURRENCY);

  // run tasks with retries
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tasks = recipients.map(cid => limit(async () => {
    let attempt = 0;
    while (++attempt <= MAX_RETRIES) {
      try {
        const r = await sendTo(cid);
        if (r.ok) return { chatId: cid, ok: true };
        // handle Telegram rate limit instructing retry_after
        if (r.raw && r.raw.parameters && r.raw.parameters.retry_after) {
          const wait = (r.raw.parameters.retry_after + 1) * 1000;
          await sleep(wait);
          continue;
        }
        // don't retry on other Telegram errors except network/timeouts
        return { chatId: cid, ok: false, error: r.error, raw: r.raw || null };
      } catch (err) {
        const se = String(err || '');
        if (/Too Many Requests|retry after/i.test(se)) {
          await sleep(1000 * attempt);
          continue;
        }
        // transient network? retry a few times
        if (attempt < MAX_RETRIES) { await sleep(500 * attempt); continue; }
        return { chatId: cid, ok: false, error: se };
      }
    }
    return { chatId: cid, ok: false, error: 'max-retries' };
  })));

  let results = [];
  try { results = await Promise.all(tasks); } catch (e) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'broadcast-failed', detail: String(e) }) };
  }

  const sent = results.filter(r => r.ok).length;
  const failed = results.length - sent;

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      ok: true,
      totalRecipients: recipients.length,
      sent,
      failed,
      sample: results.slice(0, 10)
    })
  };
};

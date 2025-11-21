// netlify/functions/announce.js
// CommonJS - will prefer local DB export if present, otherwise use FIREBASE_DR_URL
const fs = require('fs');
const path = require('path');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-master-key',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Only POST allowed' }) };

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const FIREBASE_DR_URL = (process.env.FIREBASE_DR_URL || '').trim();
  const MASTER_KEY = (process.env.MASTER_API_KEY || '').trim();
  const TELEGRAM_MAX_BYTES = parseInt(process.env.TELEGRAM_MAX_BYTES || String(5 * 1024 * 1024), 10);
  const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '4', 10);

  if (!BOT_TOKEN) return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'BOT_TOKEN required' }) };

  // require auth only if MASTER_KEY set
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

  // local DB export path (your uploaded file)
  const LOCAL_DB = '/mnt/data/queue-joy-aa21b-default-rtdb-export (4).json';

  // pick fetch implementation
  let fetchImpl = global.fetch;
  if (!fetchImpl) {
    try { fetchImpl = require('node-fetch'); } catch (e) { /* will error later if needed */ }
  }

  // Try to load local export first (this is the key change)
  let root = null;
  try {
    if (fs.existsSync(LOCAL_DB)) {
      const txt = fs.readFileSync(LOCAL_DB, 'utf8');
      root = JSON.parse(txt);
    } else if (FIREBASE_DR_URL) {
      if (!fetchImpl) return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'fetch not available to reach FIREBASE_DR_URL' }) };
      const base = FIREBASE_DR_URL.replace(/\/$/, '');
      const resp = await fetchImpl(`${base}.json`);
      if (!resp.ok) throw new Error(`Firebase fetch failed status ${resp.status}`);
      root = await resp.json();
    } else {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No local DB export found and FIREBASE_DR_URL not set' }) };
    }
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to read DB root', detail: String(err) }) };
  }

  // recursively collect chatId keys (case-insensitive)
  const found = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
      const low = k.toLowerCase();
      const val = node[k];
      if (low === 'chatid') {
        if (typeof val === 'number') found.add(Number(val));
        else if (typeof val === 'string' && /^\d+$/.test(val)) found.add(Number(val));
      }
      if (val && typeof val === 'object') walk(val);
    }
  };
  walk(root);

  const recipients = Array.from(found);
  if (!recipients.length) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No chatId found in DB' }) };
  }

  // prepare media (if any)
  let buffer = null;
  if (media && mediaType) {
    try {
      const b64 = typeof media === 'string' && media.includes(',') ? media.split(',')[1] : media;
      buffer = Buffer.from(b64, 'base64');
    } catch (e) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid media base64', detail: String(e) }) };
    }
  }

  // prepare FormData
  let FormDataImpl = global.FormData;
  if (!FormDataImpl) {
    try { FormDataImpl = require('form-data'); } catch (e) { FormDataImpl = null; }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isVideo = t => !!(t && t.startsWith && t.startsWith('video/'));
  const isGif = t => t === 'image/gif';
  const isPhoto = t => !!(t && t.startsWith && t.startsWith('image/') && !isGif(t));
  const isAudio = t => !!(t && t.startsWith && t.startsWith('audio/'));

  // send single
  const sendTo = async (chatId) => {
    // handle large media
    if (buffer && buffer.length > TELEGRAM_MAX_BYTES) {
      return { ok: false, error: 'media-too-large' };
    }

    if (buffer && mediaType) {
      if (!FormDataImpl) return { ok: false, error: 'FormData not available on server' };
      const form = new FormDataImpl();
      form.append('chat_id', String(chatId));
      if (message) form.append('caption', message);

      let endpoint = 'sendDocument';
      if (isPhoto(mediaType)) { endpoint = 'sendPhoto'; form.append('photo', buffer, { filename: 'photo.jpg', contentType: mediaType }); }
      else if (isGif(mediaType)) { endpoint = 'sendAnimation'; form.append('animation', buffer, { filename: 'anim.gif', contentType: 'image/gif' }); }
      else if (isVideo(mediaType)) { endpoint = 'sendVideo'; form.append('video', buffer, { filename: 'video.mp4', contentType: mediaType }); }
      else if (isAudio(mediaType)) { endpoint = 'sendAudio'; form.append('audio', buffer, { filename: 'audio.mp3', contentType: mediaType }); }
      else { endpoint = 'sendDocument'; form.append('document', buffer, { filename: 'file.bin', contentType: mediaType || 'application/octet-stream' }); }

      // use fetchImpl if available, otherwise require node-fetch
      let f = global.fetch;
      if (!f) {
        try { f = require('node-fetch'); } catch (e) { return { ok: false, error: 'fetch-not-available' }; }
      }

      const url = `https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`;
      const res = await f(url, { method: 'POST', body: form, headers: form.getHeaders ? form.getHeaders() : {} });
      let j = null;
      try { j = await res.json(); } catch (e) { j = null; }
      if (!res.ok || (j && j.ok === false)) return { ok: false, error: (j && j.description) ? j.description : `status ${res.status}`, raw: j };
      return { ok: true, result: j };
    }

    // text only
    {
      let f = global.fetch;
      if (!f) {
        try { f = require('node-fetch'); } catch (e) { return { ok: false, error: 'fetch-not-available' }; }
      }
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
      const body = { chat_id: String(chatId), text: message, disable_web_page_preview: true };
      const res = await f(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      let j = null;
      try { j = await res.json(); } catch (e) { j = null; }
      if (!res.ok || (j && j.ok === false)) return { ok: false, error: (j && j.description) ? j.description : `status ${res.status}`, raw: j };
      return { ok: true, result: j };
    }
  };

  // send with small concurrency and retries
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

  const tasks = recipients.map(cid => limit(async () => {
    const maxRetries = 3;
    let attempt = 0;
    while (++attempt <= maxRetries) {
      try {
        const r = await sendTo(cid);
        if (r.ok) return { chatId: cid, ok: true };
        // if Telegram asked retry_after, backoff (raw.parameters)
        if (r.raw && r.raw.parameters && r.raw.parameters.retry_after) {
          const wait = (r.raw.parameters.retry_after + 1) * 1000;
          await sleep(wait);
          continue;
        }
        // otherwise stop retrying
        return { chatId: cid, ok: false, error: r.error, raw: r.raw || null };
      } catch (err) {
        if (/Too Many Requests|retry after/i.test(String(err))) { await sleep(1000 * attempt); continue; }
        return { chatId: cid, ok: false, error: String(err) };
      }
    }
    return { chatId: cid, ok: false, error: 'max-retries' };
  })));

  let results = [];
  try { results = await Promise.all(tasks); } catch (e) { return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'broadcast-failed', detail: String(e) }) }; }

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
      resultsSample: results.slice(0, 10)
    })
  };
};

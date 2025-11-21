// netlify/functions/announce.js
// Sends EXACTLY the message supplied by admin and any attached media to every connected Telegram chatId.
// - Scans your Firebase Realtime DB root (FIREBASE_DR_URL) for any property named "chatId" (case-insensitive).
// - Fallback: reads local DB export file at /mnt/data/queue-joy-aa21b-default-rtdb-export (4).json if FIREBASE_DR_URL not set.
// - Sends media (photo/animation/video/audio/document) or text only. Does NOT add extra text.
// - If media > TELEGRAM_MAX_BYTES: will upload to S3 (if configured) and send as document URL with caption === message ONLY.
//   If no S3 configured and media too large, the function returns an error and does NOT send partial messages.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-master-key',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Only POST allowed' }) };

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const FIREBASE_DR_URL = (process.env.FIREBASE_DR_URL || '').trim();
  const MASTER_KEY = (process.env.MASTER_API_KEY || '').trim();
  const TELEGRAM_MAX_BYTES = parseInt(process.env.TELEGRAM_MAX_BYTES || String(5 * 1024 * 1024), 10);
  const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '4', 10);

  if (!BOT_TOKEN) return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'BOT_TOKEN required' }) };

  // auth if MASTER_KEY present
  if (MASTER_KEY) {
    const provided =
      (event.headers && (event.headers['x-master-key'] || event.headers['X-Master-Key'])) ||
      (event.headers && (event.headers['authorization'] || event.headers['Authorization']));
    const token = provided && String(provided).startsWith('Bearer ') ? String(provided).slice(7) : provided;
    if (!token || token !== MASTER_KEY) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unauthorized (missing/invalid master key)' }) };
    }
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  // EXACT message from admin (no modification)
  const message = (payload.message || '').toString();
  const media = payload.media || '';
  const mediaType = payload.mediaType || '';

  // local DB export path (developer provided)
  const LOCAL_DB_EXPORT = '/mnt/data/queue-joy-aa21b-default-rtdb-export (4).json';

  // import fetch
  let fetch;
  try { fetch = (await import('node-fetch')).default; } catch (e) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'node-fetch import failed', detail: String(e) }) };
  }

  // read Firebase (or local file) and gather all chatId occurrences (recursively)
  let rootObj = null;
  try {
    if (FIREBASE_DR_URL) {
      const base = FIREBASE_DR_URL.replace(/\/$/, '');
      const resp = await fetch(`${base}.json`, { method: 'GET' });
      if (!resp.ok) throw new Error(`Firebase fetch failed ${resp.status}`);
      rootObj = await resp.json();
    } else {
      // local fallback
      const fs = await import('fs');
      if (!fs.existsSync(LOCAL_DB_EXPORT)) {
        rootObj = null;
      } else {
        const text = fs.readFileSync(LOCAL_DB_EXPORT, 'utf8');
        rootObj = JSON.parse(text);
      }
    }
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to read DB', detail: String(err) }) };
  }

  // traverse and collect chatIds (deduped)
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
      // also handle nested objects that might directly be a chatId node (e.g. { chatId: 123 })
      if (val && typeof val === 'object') walk(val);
    }
  };
  if (rootObj) walk(rootObj);

  const recipients = Array.from(found);
  if (!recipients.length) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No chatId found in DB' }) };
  }

  // prepare media buffer (if provided)
  let buffer = null;
  if (media && mediaType) {
    try {
      const base64 = (typeof media === 'string' && media.includes(',')) ? media.split(',')[1] : media;
      buffer = Buffer.from(base64, 'base64');
    } catch (err) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid base64 media', detail: String(err) }) };
    }
  }

  // optional S3 init
  let s3Client = null;
  try {
    if (process.env.AWS_S3_BUCKET && process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
      s3Client = new S3Client({ region: process.env.AWS_REGION, credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }});
      s3Client._PutObjectCommand = PutObjectCommand;
    }
  } catch (e) {
    s3Client = null;
  }

  // helpers
  const FormData = (await import('form-data')).default;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isVideo = t => !!(t && t.startsWith && t.startsWith('video/'));
  const isGif = t => t === 'image/gif';
  const isPhoto = t => !!(t && t.startsWith && t.startsWith('image/') && !isGif(t));
  const isAudio = t => !!(t && t.startsWith && t.startsWith('audio/'));

  const sendRaw = async (url, opts) => {
    const r = await fetch(url, opts);
    let json = null;
    try { json = await r.json(); } catch (e) { json = null; }
    if (!r.ok || (json && json.ok === false)) {
      const desc = json && json.description ? json.description : `status ${r.status}`;
      const err = new Error(desc);
      err.raw = json;
      err.status = r.status;
      throw err;
    }
    return json;
  };

  const uploadToS3 = async (buffer, name, contentType) => {
    if (!s3Client) throw new Error('S3-not-configured');
    const key = `announce/${Date.now()}-${Math.random().toString(36).slice(2,8)}-${name}`;
    const cmd = new s3Client._PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType || 'application/octet-stream',
      ACL: 'public-read'
    });
    await s3Client.send(cmd);
    return `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${encodeURIComponent(key)}`;
  };

  // send exactly the admin message (no edit) and media (caption === message)
  const sendToChat = async (chatId) => {
    // if media present and too big
    if (buffer && buffer.length > TELEGRAM_MAX_BYTES) {
      if (s3Client) {
        const ext = (mediaType && mediaType.split('/').pop()) || 'bin';
        const url = await uploadToS3(buffer, `file.${ext}`, mediaType);
        // send as document by URL with caption EXACTLY message
        return await sendRaw(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: String(chatId), document: url, caption: message || undefined })
        });
      } else {
        const e = new Error('MEDIA_TOO_LARGE');
        e.code = 'MEDIA_TOO_LARGE';
        throw e;
      }
    }

    // send small media via multipart
    if (buffer && mediaType) {
      const form = new FormData();
      form.append('chat_id', String(chatId));

      if (isVideo(mediaType)) {
        form.append('video', buffer, { filename: 'video.mp4', contentType: mediaType });
        if (message) form.append('caption', message);
        return await sendRaw(`https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`, { method: 'POST', body: form, headers: form.getHeaders() });
      }
      if (isGif(mediaType)) {
        form.append('animation', buffer, { filename: 'anim.gif', contentType: 'image/gif' });
        if (message) form.append('caption', message);
        return await sendRaw(`https://api.telegram.org/bot${BOT_TOKEN}/sendAnimation`, { method: 'POST', body: form, headers: form.getHeaders() });
      }
      if (isPhoto(mediaType)) {
        form.append('photo', buffer, { filename: 'photo.jpg', contentType: mediaType });
        if (message) form.append('caption', message);
        return await sendRaw(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form, headers: form.getHeaders() });
      }
      if (isAudio(mediaType)) {
        form.append('audio', buffer, { filename: 'audio.mp3', contentType: mediaType });
        if (message) form.append('caption', message);
        return await sendRaw(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, { method: 'POST', body: form, headers: form.getHeaders() });
      }
      // generic: document
      form.append('document', buffer, { filename: 'file.bin', contentType: mediaType || 'application/octet-stream' });
      if (message) form.append('caption', message);
      return await sendRaw(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: form, headers: form.getHeaders() });
    }

    // text only — send EXACT message (no parse_mode)
    if (message !== undefined && message !== null) {
      return await sendRaw(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: String(chatId), text: message, disable_web_page_preview: true })
      });
    }

    throw new Error('nothing-to-send');
  };

  // concurrency limiter
  const pLimit = (concurrency) => {
    let active = 0;
    const q = [];
    const next = () => {
      if (!q.length) return;
      if (active >= concurrency) return;
      active++;
      const job = q.shift();
      job.fn().then(job.resolve).catch(job.reject).finally(() => { active--; next(); });
    };
    return (fn) => new Promise((resolve, reject) => { q.push({ fn, resolve, reject }); next(); });
  };
  const limit = pLimit(MAX_CONCURRENCY);

  const sendTasks = recipients.map(chatId => limit(async () => {
    const maxRetries = 3;
    let attempt = 0;
    while (++attempt <= maxRetries) {
      try {
        const res = await sendToChat(chatId);
        return { chatId, ok: true, attempt, res };
      } catch (err) {
        // respect Telegram retry_after if present
        const raw = err.raw || {};
        if (raw && raw.parameters && raw.parameters.retry_after) {
          const waitMs = (raw.parameters.retry_after + 1) * 1000;
          await sleep(waitMs);
          continue;
        }
        if (err.message && /Too Many Requests|retry after/i.test(err.message)) {
          await sleep(1000 * attempt);
          continue;
        }
        if (err.code === 'MEDIA_TOO_LARGE') return { chatId, ok: false, error: 'media-too-large-no-s3' };
        // non-retryable or final attempt
        return { chatId, ok: false, error: String(err.message || err), raw: err.raw || null, attempt };
      }
    }
    return { chatId, ok: false, error: 'max-retries-exceeded' };
  })));

  let results = [];
  try {
    results = await Promise.all(sendTasks);
  } catch (e) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unexpected broadcast error', detail: String(e) }) };
  }

  const sent = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const failedList = results.filter(r => !r.ok).map(r => ({ chatId: r.chatId, error: r.error || r.raw }));

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      ok: true,
      total: results.length,
      sent,
      failed,
      telegram_limit_bytes: TELEGRAM_MAX_BYTES,
      s3_available: !!s3Client,
      failedList
    })
  };
}

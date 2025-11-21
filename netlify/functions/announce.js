// netlify/functions/announce.js
// Robust announcer - sends EXACT admin message + media to every chatId found in your RealtimeDB export or live DB.
// Required env: BOT_TOKEN
// Optional env: FIREBASE_DR_URL, MASTER_API_KEY, TELEGRAM_MAX_BYTES (default 5MB), MAX_CONCURRENCY (default 4)
// Optional S3 for >limit fallback: AWS_S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-master-key',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Only POST allowed' }) };

  // env
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const FIREBASE_DR_URL = (process.env.FIREBASE_DR_URL || '').trim();
  const MASTER_KEY = (process.env.MASTER_API_KEY || '').trim();
  const TELEGRAM_MAX_BYTES = parseInt(process.env.TELEGRAM_MAX_BYTES || String(5 * 1024 * 1024), 10);
  const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '4', 10);

  if (!BOT_TOKEN) return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'BOT_TOKEN required' }) };

  // auth if configured
  if (MASTER_KEY) {
    const provided =
      (event.headers && (event.headers['x-master-key'] || event.headers['X-Master-Key'])) ||
      (event.headers && (event.headers['authorization'] || event.headers['Authorization']));
    const token = provided && String(provided).startsWith('Bearer ') ? String(provided).slice(7) : provided;
    if (!token || token !== MASTER_KEY) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unauthorized (missing/invalid master key)' }) };
    }
  }

  // parse payload
  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const message = (payload.message ?? '').toString();
  const media = payload.media || '';
  const mediaType = payload.mediaType || '';

  // choose fetch implementation (prefer global fetch)
  let fetchImpl = globalThis.fetch;
  if (!fetchImpl) {
    try { fetchImpl = (await import('node-fetch')).default; } catch (e) {
      return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'fetch not available and node-fetch import failed', detail: String(e) }) };
    }
  }

  // read DB root (live firebase or local export)
  let root = null;
  const LOCAL_DB_EXPORT = '/mnt/data/queue-joy-aa21b-default-rtdb-export (4).json';
  try {
    if (FIREBASE_DR_URL) {
      const base = FIREBASE_DR_URL.replace(/\/$/, '');
      const r = await fetchImpl(`${base}.json`);
      if (!r.ok) throw new Error(`Firebase fetch failed status ${r.status}`);
      root = await r.json();
    } else {
      // local fallback
      const fs = await import('fs');
      if (!fs.existsSync(LOCAL_DB_EXPORT)) {
        root = null;
      } else {
        const txt = fs.readFileSync(LOCAL_DB_EXPORT, 'utf8');
        root = JSON.parse(txt);
      }
    }
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to read DB root', detail: String(err) }) };
  }

  // recursively find all chatId keys (case-insensitive), dedupe numeric ids
  const found = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      const lower = key.toLowerCase();
      const val = node[key];
      if (lower === 'chatid') {
        if (typeof val === 'number') found.add(Number(val));
        else if (typeof val === 'string' && /^\d+$/.test(val)) found.add(Number(val));
      }
      if (val && typeof val === 'object') walk(val);
    }
  };
  if (root) walk(root);

  const recipients = Array.from(found);
  if (!recipients.length) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No chatId found in DB root' }) };
  }

  // build media buffer if present
  let buffer = null;
  if (media && mediaType) {
    try {
      const base64 = (typeof media === 'string' && media.includes(',')) ? media.split(',')[1] : media;
      buffer = Buffer.from(base64, 'base64');
    } catch (e) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid base64 media', detail: String(e) }) };
    }
  }

  // prepare FormData (use global if available)
  let FormDataImpl = globalThis.FormData;
  if (!FormDataImpl) {
    try { FormDataImpl = (await import('form-data')).default; } catch (e) { FormDataImpl = null; }
  }

  // optional S3 client if env present
  let s3Client = null;
  if (process.env.AWS_S3_BUCKET && process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    try {
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
      s3Client = new S3Client({ region: process.env.AWS_REGION, credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }});
      s3Client._PutObjectCommand = PutObjectCommand;
    } catch (e) {
      s3Client = null;
    }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isVideo = t => !!(t && t.startsWith && t.startsWith('video/'));
  const isGif = t => t === 'image/gif';
  const isPhoto = t => !!(t && t.startsWith && t.startsWith('image/') && !isGif(t));
  const isAudio = t => !!(t && t.startsWith && t.startsWith('audio/'));

  // helper to POST and throw on non-ok
  const postJson = async (url, bodyObj) => {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj) });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!res.ok || (json && json.ok === false)) {
      const desc = (json && json.description) ? json.description : `status ${res.status}`;
      const err = new Error(desc);
      err.raw = json;
      throw err;
    }
    return json;
  };

  const uploadToS3 = async (buf, name, contentType) => {
    if (!s3Client) throw new Error('S3-not-configured');
    const key = `announce/${Date.now()}-${Math.random().toString(36).slice(2,8)}-${name}`;
    const cmd = new s3Client._PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: key,
      Body: buf,
      ContentType: contentType || 'application/octet-stream',
      ACL: 'public-read'
    });
    await s3Client.send(cmd);
    return `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${encodeURIComponent(key)}`;
  };

  // send EXACT message + media (caption === message)
  const sendToChat = async (chatId) => {
    if (buffer && buffer.length > TELEGRAM_MAX_BYTES) {
      // if S3 available, upload and send URL as document
      if (s3Client) {
        const ext = (mediaType && mediaType.split('/').pop()) || 'bin';
        const url = await uploadToS3(buffer, `file.${ext}`, mediaType);
        return await postJson(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { chat_id: String(chatId), document: url, caption: message || undefined });
      }
      const e = new Error('MEDIA_TOO_LARGE');
      e.code = 'MEDIA_TOO_LARGE';
      throw e;
    }

    if (buffer && mediaType) {
      // multipart/form-data
      if (!FormDataImpl) throw new Error('FormData unavailable (add form-data to dependencies)');
      const form = new FormDataImpl();
      form.append('chat_id', String(chatId));
      if (isVideo(mediaType)) { form.append('video', buffer, { filename: 'video.mp4', contentType: mediaType }); if (message) form.append('caption', message); return await fetchImpl(`https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`, { method: 'POST', body: form, headers: form.getHeaders ? form.getHeaders() : {} }).then(r=>r.json()); }
      if (isGif(mediaType)) { form.append('animation', buffer, { filename: 'anim.gif', contentType: 'image/gif' }); if (message) form.append('caption', message); return await fetchImpl(`https://api.telegram.org/bot${BOT_TOKEN}/sendAnimation`, { method: 'POST', body: form, headers: form.getHeaders ? form.getHeaders() : {} }).then(r=>r.json()); }
      if (isPhoto(mediaType)) { form.append('photo', buffer, { filename: 'photo.jpg', contentType: mediaType }); if (message) form.append('caption', message); return await fetchImpl(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form, headers: form.getHeaders ? form.getHeaders() : {} }).then(r=>r.json()); }
      if (isAudio(mediaType)) { form.append('audio', buffer, { filename: 'audio.mp3', contentType: mediaType }); if (message) form.append('caption', message); return await fetchImpl(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, { method: 'POST', body: form, headers: form.getHeaders ? form.getHeaders() : {} }).then(r=>r.json()); }
      // document fallback
      form.append('document', buffer, { filename: 'file.bin', contentType: mediaType || 'application/octet-stream' });
      if (message) form.append('caption', message);
      return await fetchImpl(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: form, headers: form.getHeaders ? form.getHeaders() : {} }).then(r=>r.json());
    }

    // text only; send EXACT message (no parse_mode)
    if (message !== undefined && message !== null) {
      return await postJson(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: String(chatId), text: message, disable_web_page_preview: true });
    }
    throw new Error('nothing-to-send');
  };

  // concurrency limiter
  const pLimit = (concurrency) => {
    let active = 0;
    const queue = [];
    const next = () => {
      if (!queue.length) return;
      if (active >= concurrency) return;
      active++;
      const job = queue.shift();
      job.fn().then(job.resolve).catch(job.reject).finally(() => { active--; next(); });
    };
    return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
  };
  const limit = pLimit(MAX_CONCURRENCY);

  const tasks = recipients.map(chatId => limit(async () => {
    const maxRetries = 3;
    let attempt = 0;
    while (++attempt <= maxRetries) {
      try {
        const res = await sendToChat(chatId);
        return { chatId, ok: true, attempt, res };
      } catch (err) {
        const raw = err.raw || {};
        if (raw && raw.parameters && raw.parameters.retry_after) {
          await sleep((raw.parameters.retry_after + 1) * 1000);
          continue;
        }
        if (err.message && /Too Many Requests|retry after/i.test(err.message)) {
          await sleep(1000 * attempt);
          continue;
        }
        if (err.code === 'MEDIA_TOO_LARGE') return { chatId, ok: false, error: 'media-too-large-no-s3' };
        return { chatId, ok: false, error: String(err.message || err), raw: err.raw || null, attempt };
      }
    }
    return { chatId, ok: false, error: 'max-retries-exceeded' };
  })));

  let results = [];
  try { results = await Promise.all(tasks); } catch (e) { return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unexpected broadcast error', detail: String(e) }) }; }

  const sent = results.filter(r => r.ok).length;
  const failed = results.length - sent;
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

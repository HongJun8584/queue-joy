// netlify/functions/announce.js
// Broadcast to all saved recipients in Realtime DB: /linkedUsers/{uid}/chatId
// POST body: { message: "Hello", media: "<dataURI or base64>", mediaType: "image/jpeg" }
// Env vars:
//   BOT_TOKEN (required)
//   FIREBASE_DR_URL (optional - if missing, reads local export file at LOCAL_DB_EXPORT)
//   MASTER_API_KEY (optional - require callers to provide x-master-key or Authorization: Bearer <key>)
//   TELEGRAM_MAX_BYTES (optional, default 5*1024*1024)
//   MAX_CONCURRENCY (optional, default 4)
// Optional S3 (for >limit fallback):
//   AWS_S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-master-key',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Only POST allowed' }) };

  // quick parse + auth
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const FIREBASE_DR_URL = process.env.FIREBASE_DR_URL || '';
  const MASTER_KEY = process.env.MASTER_API_KEY || '';
  const TELEGRAM_MAX_BYTES = parseInt(process.env.TELEGRAM_MAX_BYTES || String(5 * 1024 * 1024), 10);
  const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '4', 10);

  if (!BOT_TOKEN) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'BOT_TOKEN required' }) };
  }

  if (MASTER_KEY) {
    const provided =
      (event.headers && (event.headers['x-master-key'] || event.headers['X-Master-Key'])) ||
      (event.headers && (event.headers['authorization'] || event.headers['Authorization']));
    const token = provided && String(provided).startsWith('Bearer ') ? String(provided).slice(7) : provided;
    if (!token || token !== MASTER_KEY) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unauthorized (missing/invalid master key)' }) };
    }
  }

  let payload = {};
  try { payload = JSON.parse(event.body || '{}'); } catch (err) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const message = (payload.message || '').toString().trim();
  const media = payload.media || '';
  const mediaType = payload.mediaType || '';

  // LOCAL fallback file (you uploaded an export). We'll use it if FIREBASE_DR_URL is not set.
  const LOCAL_DB_EXPORT = '/mnt/data/queue-joy-aa21b-default-rtdb-export (4).json';

  // helper fetch (node-fetch will be dynamically imported)
  let fetch;
  try {
    fetch = (await import('node-fetch')).default;
  } catch (e) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'node-fetch import failed', detail: String(e) }) };
  }

  // --- read linkedUsers either from realtime DB or local export ---
  let linkedUsersObj = null;
  try {
    if (FIREBASE_DR_URL) {
      // Ensure url ends with no trailing slash, then append /linkedUsers.json
      const base = FIREBASE_DR_URL.replace(/\/$/, '');
      const url = `${base}/linkedUsers.json`;
      const r = await fetch(url, { method: 'GET' });
      if (!r.ok) throw new Error(`Firebase fetch failed ${r.status}`);
      linkedUsersObj = await r.json();
    } else {
      // local fallback: read the uploaded export file (useful for testing)
      const fs = await import('fs');
      if (!fs.existsSync(LOCAL_DB_EXPORT)) {
        linkedUsersObj = null;
      } else {
        const txt = fs.readFileSync(LOCAL_DB_EXPORT, 'utf8');
        linkedUsersObj = JSON.parse(txt).linkedUsers || JSON.parse(txt);
      }
    }
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to read linkedUsers', detail: String(err) }) };
  }

  // collect numeric chatIds
  const recipients = [];
  if (linkedUsersObj && typeof linkedUsersObj === 'object') {
    for (const uid of Object.keys(linkedUsersObj)) {
      const node = linkedUsersObj[uid];
      if (!node) continue;
      const chat = node.chatId || node.chatid || node.chatID;
      if (typeof chat === 'number' || (typeof chat === 'string' && /^\d+$/.test(chat))) {
        const id = Number(chat);
        if (!Number.isNaN(id)) recipients.push(id);
      }
    }
  }

  if (!recipients.length) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'No recipients found in /linkedUsers' }) };
  }

  // prepare media buffer if present
  let buffer = null;
  if (media && mediaType) {
    try {
      const base64Data = (typeof media === 'string' && media.includes(',')) ? media.split(',')[1] : media;
      buffer = Buffer.from(base64Data, 'base64');
    } catch (err) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid base64 media', detail: String(err) }) };
    }
  }

  // optional S3 client - only initialize if env present
  let s3Client = null;
  try {
    if (process.env.AWS_S3_BUCKET && process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
      s3Client = new S3Client({ region: process.env.AWS_REGION, credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }});
      s3Client._PutObjectCommand = PutObjectCommand;
    }
  } catch (e) {
    // ignore S3 init errors; we'll fallback to not using S3
    s3Client = null;
  }

  const FormData = (await import('form-data')).default;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const sendRaw = async (url, opts) => {
    const res = await fetch(url, opts);
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!res.ok || (json && json.ok === false)) {
      const desc = json && json.description ? json.description : `status ${res.status}`;
      const err = new Error(desc);
      err.raw = json;
      err.status = res.status;
      throw err;
    }
    return json;
  };

  const isVideo = t => !!(t && t.startsWith && t.startsWith('video/'));
  const isGif = t => t === 'image/gif';
  const isPhoto = t => !!(t && t.startsWith && t.startsWith('image/') && !isGif(t));
  const isAudio = t => !!(t && t.startsWith && t.startsWith('audio/'));

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

  const sendToChat = async (chatId) => {
    // if media exists but too big
    if (buffer && buffer.length > TELEGRAM_MAX_BYTES) {
      if (s3Client) {
        // upload to s3 and ask telegram to fetch it as document
        const ext = (mediaType && mediaType.split('/').pop()) || 'bin';
        const url = await uploadToS3(buffer, `file.${ext}`, mediaType);
        // try to send as document by URL
        try {
          return await sendRaw(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: String(chatId), document: url, caption: message || undefined })
          });
        } catch (err) {
          // fallback: send text + url
          return await sendRaw(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: String(chatId), text: `${message ? message + '\n\n' : ''}Download: ${url}`, disable_web_page_preview: true })
          });
        }
      } else {
        const e = new Error('MEDIA_TOO_LARGE');
        e.code = 'MEDIA_TOO_LARGE';
        throw e;
      }
    }

    // send small media via multipart/form-data
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
      // fallback document
      form.append('document', buffer, { filename: 'file.bin', contentType: mediaType || 'application/octet-stream' });
      if (message) form.append('caption', message);
      return await sendRaw(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: form, headers: form.getHeaders() });
    }

    // text only
    if (message) {
      return await sendRaw(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: String(chatId), text: message, parse_mode: 'HTML', disable_web_page_preview: true })
      });
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

  // Fire off sends with retries and proper handling of Telegram 429 retry_after
  const sendPromises = recipients.map(chatId => limit(async () => {
    const maxRetries = 4;
    let attempt = 0;
    while (++attempt <= maxRetries) {
      try {
        const res = await sendToChat(chatId);
        return { chatId, ok: true, attempt, result: res };
      } catch (err) {
        // If Telegram returns retry_after, respect it
        const raw = err.raw || {};
        if (raw && raw.parameters && raw.parameters.retry_after) {
          const wait = (raw.parameters.retry_after + 1) * 1000;
          await sleep(wait);
          continue;
        }
        // handle explicit 429 message
        if (err.message && /Too Many Requests|retry after/i.test(err.message)) {
          // small backoff
          await sleep(1000 * attempt);
          continue;
        }
        // unrecoverable
        if (err.code === 'MEDIA_TOO_LARGE') return { chatId, ok: false, error: 'media-too-large-no-s3' };
        return { chatId, ok: false, error: String(err.message || err), raw: err.raw || null, attempt };
      }
    }
    return { chatId, ok: false, error: 'max-retries-exceeded' };
  })));

  let results = [];
  try {
    results = await Promise.all(sendPromises);
  } catch (e) {
    // Promise.all should not throw, but catch unexpected
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unexpected broadcast error', detail: String(e) }) };
  }

  // Build summary
  const success = results.filter(r => r.ok).length;
  const failed = results.length - success;
  const failedList = results.filter(r => !r.ok).map(r => ({ chatId: r.chatId, error: r.error || r.raw }));

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      ok: true,
      sent: success,
      failed,
      total: results.length,
      telegram_limit_bytes: TELEGRAM_MAX_BYTES,
      s3_available: !!s3Client,
      failedList
    })
  };
}

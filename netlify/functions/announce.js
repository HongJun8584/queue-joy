// netlify/functions/announce.js
// Broadcast to all saved recipients in Firebase RealtimeDB /linkedUsers
// POST body: { message: "Hello", media: "<dataURI or base64>", mediaType: "image/jpeg" }
// If MASTER_API_KEY env set, client must provide x-master-key or Authorization: Bearer <key>

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-master-key',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Only POST allowed' }) };

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const FIREBASE_DR_URL = process.env.FIREBASE_DR_URL;
  const MASTER_KEY = process.env.MASTER_API_KEY || '';
  const TELEGRAM_MAX_BYTES = parseInt(process.env.TELEGRAM_MAX_BYTES || String(5 * 1024 * 1024), 10);
  const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '6', 10);

  if (!BOT_TOKEN || !FIREBASE_DR_URL) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'BOT_TOKEN and FIREBASE_DR_URL required' }) };
  }

  // simple auth if MASTER_KEY set
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

  const message = (payload.message || '').toString().trim();
  const media = payload.media || '';
  const mediaType = payload.mediaType || '';

  // fetch recipients from Firebase Realtime DB: /linkedUsers.json
  const fetch = (await import('node-fetch')).default;
  const firebaseUrl = `${FIREBASE_DR_URL.replace(/\/$/, '')}/linkedUsers.json`;
  let linkedUsers;
  try {
    const resp = await fetch(firebaseUrl);
    linkedUsers = await resp.json();
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Failed to read Firebase linkedUsers', detail: String(err) }) };
  }

  // collect numeric chatIds
  const recipients = [];
  if (linkedUsers && typeof linkedUsers === 'object') {
    for (const key of Object.keys(linkedUsers)) {
      const node = linkedUsers[key];
      if (node && (typeof node.chatId === 'number' || /^\d+$/.test(String(node.chatId)))) {
        const id = Number(node.chatId);
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
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid base64 media' }) };
    }
  }

  // optional S3 uploader for >limit fallback
  let s3Client = null;
  if (process.env.AWS_S3_BUCKET && process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    try {
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
      s3Client = new S3Client({ region: process.env.AWS_REGION, credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }});
      s3Client._PutObjectCommand = PutObjectCommand;
    } catch (err) {
      // keep s3Client null if fails
      s3Client = null;
    }
  }

  const FormData = (await import('form-data')).default;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const sendWithFetch = async (endpoint, options) => {
    const res = await fetch(endpoint, options);
    const json = await res.json().catch(() => null);
    if (!res.ok || (json && json.ok === false)) {
      const desc = json && json.description ? json.description : `status ${res.status}`;
      const e = new Error(`Telegram API error: ${desc}`);
      e.raw = json;
      throw e;
    }
    return json;
  };

  const isVideo = t => t.startsWith('video/');
  const isGif = t => t === 'image/gif';
  const isPhoto = t => t.startsWith('image/') && !isGif(t);
  const isAudio = t => t.startsWith('audio/');

  const uploadToS3 = async (buffer, filename, contentType) => {
    if (!s3Client) throw new Error('S3-not-configured');
    const key = `announce/${Date.now()}-${Math.random().toString(36).slice(2,10)}-${filename}`;
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

  // send media or text to single chat
  const sendToChat = async (chatId) => {
    if (buffer && mediaType) {
      // oversized?
      if (buffer.length > TELEGRAM_MAX_BYTES) {
        if (s3Client) {
          const ext = mediaType.split('/').pop().split('+')[0] || 'bin';
          const url = await uploadToS3(buffer, `file.${ext}`, mediaType);
          // try let telegram fetch url as document
          try {
            return await sendWithFetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: String(chatId), document: url, caption: message || undefined })
            });
          } catch (err) {
            // fallback: send message with link
            return await sendWithFetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: String(chatId), text: `${message ? message + "\n\n" : ''}Download: ${url}`, disable_web_page_preview: true })
            });
          }
        } else {
          const e = new Error('MEDIA_TOO_LARGE');
          e.code = 'MEDIA_TOO_LARGE';
          throw e;
        }
      }

      // size ok -> send via form-data
      const form = new FormData();
      form.append('chat_id', String(chatId));
      if (isVideo(mediaType)) {
        form.append('video', buffer, { filename: 'video.mp4', contentType: mediaType });
        if (message) form.append('caption', message);
        return await sendWithFetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`, { method: 'POST', body: form, headers: form.getHeaders() });
      }
      if (isGif(mediaType)) {
        form.append('animation', buffer, { filename: 'anim.gif', contentType: 'image/gif' });
        if (message) form.append('caption', message);
        return await sendWithFetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAnimation`, { method: 'POST', body: form, headers: form.getHeaders() });
      }
      if (isPhoto(mediaType)) {
        form.append('photo', buffer, { filename: 'photo.jpg', contentType: mediaType });
        if (message) form.append('caption', message);
        return await sendWithFetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form, headers: form.getHeaders() });
      }
      if (isAudio(mediaType)) {
        form.append('audio', buffer, { filename: 'audio.mp3', contentType: mediaType });
        if (message) form.append('caption', message);
        return await sendWithFetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, { method: 'POST', body: form, headers: form.getHeaders() });
      }
      // generic fallback -> document
      form.append('document', buffer, { filename: 'file.bin', contentType: mediaType || 'application/octet-stream' });
      if (message) form.append('caption', message);
      return await sendWithFetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: form, headers: form.getHeaders() });
    } else if (message) {
      return await sendWithFetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: String(chatId), text: message, parse_mode: 'HTML', disable_web_page_preview: true })
      });
    } else {
      throw new Error('nothing-to-send');
    }
  };

  // concurrency limiter
  const pLimit = (concurrency) => {
    let active = 0;
    const queue = [];
    const next = () => {
      if (!queue.length) return;
      if (active >= concurrency) return;
      active++;
      const { fn, resolve, reject } = queue.shift();
      fn().then(v => { resolve(v); active--; next(); }).catch(e => { reject(e); active--; next(); });
    };
    return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
  };
  const limit = pLimit(MAX_CONCURRENCY);

  const resultsPromises = recipients.map(chatId => limit(async () => {
    const maxRetries = 3;
    let attempt = 0;
    while (++attempt <= maxRetries) {
      try {
        const res = await sendToChat(chatId);
        return { chatId, ok: true, attempt, telegram: res };
      } catch (err) {
        // unrecoverable: user blocked or media too large without s3
        if (err.code === 'MEDIA_TOO_LARGE') return { chatId, ok: false, error: 'media-too-large', attempt };
        const msg = String(err.message || '');
        const isRetryable = /Too Many Requests|retry after|timeout|5../i.test(msg);
        if (!isRetryable || attempt === maxRetries) return { chatId, ok: false, error: msg, raw: err.raw || null, attempt };
        // backoff
        const wait = 500 * Math.pow(2, attempt);
        await sleep(wait);
      }
    }
    return { chatId, ok: false, error: 'max-retries' };
  })));

  const resolved = await Promise.all(resultsPromises);

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      ok: true,
      recipients_count: recipients.length,
      telegram_limit_bytes: TELEGRAM_MAX_BYTES,
      s3_available: !!s3Client,
      results: resolved
    })
  };
}

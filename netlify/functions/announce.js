// netlify/functions/announce.js
// Sends announcement (text + optional media) to ALL past customers only.
// Required env: BOT_TOKEN
// Optional env: FIREBASE_DB_URL (defaults to your public DB from status.html)
// POST JSON: { message: "Hello", media: "data:...base64..." | "plainBase64", mediaType: "image/jpeg" }

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
  const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://queue-joy-aa21b-default-rtdb.asia-southeast1.firebasedatabase.app';

  if (!BOT_TOKEN) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'BOT_TOKEN must be set in environment' })
    };
  }

  // parse body
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }
  const message = (payload.message || '').toString();
  const media = payload.media;         // base64 or data:* URI
  const mediaType = payload.mediaType; // MIME like image/jpeg
  const concurrency = Number.isFinite(payload.concurrency) ? Math.max(1, Math.floor(payload.concurrency)) : 6;

  // fetch availability (Node 18 in Netlify should have global.fetch)
  let fetchFn = global.fetch;
  if (!fetchFn) {
    try {
      const nf = await import('node-fetch');
      fetchFn = nf.default;
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'No fetch available' }) };
    }
  }

  // helpers
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function collectChatIdsFromObj(obj, set) {
    if (!obj || typeof obj !== 'object') return;
    // look for common chat id keys
    const keys = ['chatId','chat_id','chat','telegramId','telegram_id','tgChatId','tg_chat_id','telegram'];
    for (const k of keys) {
      if (k in obj && obj[k]) {
        set.add(String(obj[k]));
      }
    }
    // recurse
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') collectChatIdsFromObj(v, set);
    }
  }

  function collectFromQueueEntries(queueObj, set) {
    if (!queueObj || typeof queueObj !== 'object') return;
    Object.values(queueObj).forEach(entry => {
      if (!entry || typeof entry !== 'object') return;
      const status = (entry.status || '').toString().toLowerCase();
      // consider these as past/served
      if (['done','served','completed','finished'].includes(status) || entry.served === true || entry.completed === true) {
        // known chat keys inside entry
        const chatKeys = ['chatId','chat_id','chat','telegramId','telegram_id','tgChatId','tg_chat_id'];
        for (const k of chatKeys) {
          if (k in entry && entry[k]) {
            set.add(String(entry[k]));
            break;
          }
        }
      }
    });
  }

  async function gatherRecipients() {
    const set = new Set();
    const endpoints = [
      `${FIREBASE_DB_URL.replace(/\/$/,'')}/served.json`,
      `${FIREBASE_DB_URL.replace(/\/$/,'')}/pastCustomers.json`,
      `${FIREBASE_DB_URL.replace(/\/$/,'')}/customers.json`,
      `${FIREBASE_DB_URL.replace(/\/$/,'')}/queue.json`,
      `${FIREBASE_DB_URL.replace(/\/$/,'')}/users.json`,
      `${FIREBASE_DB_URL.replace(/\/$/,'')}/.json`
    ];

    for (const url of endpoints) {
      try {
        const res = await fetchFn(url);
        if (!res.ok) continue;
        const j = await res.json();
        if (!j) continue;
        if (url.endsWith('/queue.json') || url.endsWith('/served.json')) {
          collectFromQueueEntries(j, set);
        } else {
          collectChatIdsFromObj(j, set);
        }
      } catch (e) {
        // ignore endpoint errors, continue others
      }
    }

    // sanity filter (chat ids should be at least length 4)
    return Array.from(set).filter(id => id && String(id).length >= 4);
  }

  // Telegram helpers
  async function sendText(chatId, text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const body = { chat_id: String(chatId), text, parse_mode: 'HTML', disable_web_page_preview: true };
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await r.json().catch(()=>({ ok: false, description: 'invalid-json' }));
    if (!r.ok || json.ok === false) throw new Error(json.description || `HTTP ${r.status}`);
    return json;
  }

  async function sendMedia(chatId, buf, mType, caption) {
    const FormDataLib = (await import('form-data')).default;
    const form = new FormDataLib();
    form.append('chat_id', String(chatId));

    const isVideo = mType && mType.startsWith('video/');
    const isGif = mType === 'image/gif';
    const isPhoto = mType && mType.startsWith('image/') && !isGif;
    const isAudio = mType && mType.startsWith('audio/');

    if (isVideo) {
      form.append('video', buf, { filename: 'video.mp4', contentType: mType });
      if (caption) form.append('caption', caption);
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`;
      const r = await fetchFn(url, { method: 'POST', body: form, headers: form.getHeaders ? form.getHeaders() : {} });
      const json = await r.json().catch(()=>({ ok: false }));
      if (!r.ok || json.ok === false) throw new Error(json.description || `HTTP ${r.status}`);
      return json;
    } else if (isGif) {
      form.append('animation', buf, { filename: 'anim.gif', contentType: 'image/gif' });
      if (caption) form.append('caption', caption);
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendAnimation`;
      const r = await fetchFn(url, { method: 'POST', body: form, headers: form.getHeaders ? form.getHeaders() : {} });
      const json = await r.json().catch(()=>({ ok: false }));
      if (!r.ok || json.ok === false) throw new Error(json.description || `HTTP ${r.status}`);
      return json;
    } else if (isPhoto) {
      form.append('photo', buf, { filename: 'photo.jpg', contentType: mType });
      if (caption) form.append('caption', caption);
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
      const r = await fetchFn(url, { method: 'POST', body: form, headers: form.getHeaders ? form.getHeaders() : {} });
      const json = await r.json().catch(()=>({ ok: false }));
      if (!r.ok || json.ok === false) throw new Error(json.description || `HTTP ${r.status}`);
      return json;
    } else if (isAudio) {
      form.append('audio', buf, { filename: 'audio.mp3', contentType: mType });
      if (caption) form.append('caption', caption);
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`;
      const r = await fetchFn(url, { method: 'POST', body: form, headers: form.getHeaders ? form.getHeaders() : {} });
      const json = await r.json().catch(()=>({ ok: false }));
      if (!r.ok || json.ok === false) throw new Error(json.description || `HTTP ${r.status}`);
      return json;
    } else {
      throw new Error('Unsupported media type');
    }
  }

  // retry logic for transient errors
  async function sendWithRetry(chatId, buf, mType, caption, textOnly) {
    const maxRetries = 2;
    let attempt = 0;
    let lastErr = null;
    while (attempt <= maxRetries) {
      try {
        if (buf && mType) {
          return await sendMedia(chatId, buf, mType, caption);
        } else {
          return await sendText(chatId, caption || textOnly || '');
        }
      } catch (e) {
        lastErr = e;
        const msg = String(e && e.message ? e.message : e);
        // permanent failures: bot blocked / chat not found
        if (/blocked|user is deactivated|chat not found|not_found|have no rights/i.test(msg)) {
          throw e;
        }
        // backoff then retry
        await sleep(200 + attempt * 300);
        attempt++;
      }
    }
    throw lastErr || new Error('Unknown send error');
  }

  // simple async pool
  async function asyncPool(poolLimit, array, iteratorFn) {
    const ret = [];
    const executing = [];
    for (const item of array) {
      const p = Promise.resolve().then(() => iteratorFn(item));
      ret.push(p);
      if (poolLimit <= array.length) {
        const e = p.then(() => executing.splice(executing.indexOf(e), 1));
        executing.push(e);
        if (executing.length >= poolLimit) {
          await Promise.race(executing);
        }
      }
    }
    return Promise.all(ret);
  }

  // build recipients
  let recipients = [];
  try {
    recipients = await gatherRecipients();
  } catch (e) {
    recipients = [];
  }

  // prepare media buffer
  let buffer = null;
  if (media && mediaType) {
    const base64 = (typeof media === 'string' && media.includes(',')) ? media.split(',')[1] : media;
    try {
      buffer = Buffer.from(base64 || '', 'base64');
    } catch (e) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid base64 media' }) };
    }
  }

  // if no recipients, return success with zero
  if (!recipients || recipients.length === 0) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, total: 0, success: 0, failedCount: 0, results: [] })
    };
  }

  // send
  const results = [];
  await asyncPool(concurrency, recipients, async (id) => {
    try {
      if (buffer && mediaType) {
        const res = await sendWithRetry(id, buffer, mediaType, message);
        results.push({ chatId: id, ok: true, telegram: { result: res }});
      } else if (message) {
        const res = await sendWithRetry(id, null, null, message, true);
        results.push({ chatId: id, ok: true, telegram: { result: res }});
      } else {
        results.push({ chatId: id, ok: false, error: 'No message or media' });
      }
      // small jitter to be gentle on rate limits
      await sleep(60 + Math.floor(Math.random()*120));
    } catch (e) {
      const errMsg = (e && e.message) ? e.message : String(e);
      results.push({ chatId: id, ok: false, error: errMsg });
    }
  });

  const total = results.length;
  const success = results.filter(r => r.ok).length;
  const failedList = results.filter(r => !r.ok);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok: true, total, success, failedCount: failedList.length, results })
  };
}

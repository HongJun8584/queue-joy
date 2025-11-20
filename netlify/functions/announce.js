// netlify/functions/announce.js
// Multi-recipient announcer for QueueJoy
// Required env: BOT_TOKEN, CHAT_ID (admin receives summary)
// Optional env: FIREBASE_DB_URL (defaults to your public DB from status.html)
// POST JSON: { message: "Hello", media: "base64...", mediaType: "image/jpeg" }

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
  const ADMIN_CHAT_ID = process.env.CHAT_ID;
  const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://queue-joy-aa21b-default-rtdb.asia-southeast1.firebasedatabase.app';

  if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'BOT_TOKEN and CHAT_ID (admin) must be set in environment' })
    };
  }

  // Parse request
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }
  const message = (payload.message || '').toString();
  const media = payload.media;         // optional base64 string (data:* or plain)
  const mediaType = payload.mediaType; // optional MIME like image/jpeg

  // Ensure global fetch exists (Netlify Node 18 usually has it). If not, try to import node-fetch.
  let fetchFn = global.fetch;
  if (!fetchFn) {
    try {
      const nf = await import('node-fetch');
      fetchFn = nf.default;
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'No fetch available' }) };
    }
  }

  // Recursively scan object for keys that look like chat IDs
  function collectChatIdsFromObj(obj, set) {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      try {
        const v = obj[k];
        if (k.toLowerCase() === 'chatid' || k.toLowerCase() === 'chat_id' || k.toLowerCase() === 'chat') {
          if (v) set.add(String(v));
        } else if (typeof v === 'object') {
          collectChatIdsFromObj(v, set);
        } else {
          // sometimes queued items store 'chatId' in nested strings; ignore others
        }
      } catch (e) { /* ignore */ }
    }
  }

  // Fetch firebase blobs to find recipients
  async function gatherRecipients() {
    const set = new Set();

    // Try known endpoints: /queue.json and /customers.json, and root .json (careful)
    const endpoints = [
      `${FIREBASE_DB_URL.replace(/\/$/,'')}/queue.json`,
      `${FIREBASE_DB_URL.replace(/\/$/,'')}/customers.json`,
      `${FIREBASE_DB_URL.replace(/\/$/,'')}/users.json`,
      `${FIREBASE_DB_URL.replace(/\/$/,'')}/.json`
    ];

    for (const url of endpoints) {
      try {
        const res = await fetchFn(url);
        if (!res.ok) continue;
        const j = await res.json();
        if (!j) continue;
        collectChatIdsFromObj(j, set);
      } catch (e) {
        // ignore fetch errors for an endpoint, continue others
      }
    }

    // Filter out admin chat id (we don't want to spam admin unless they are also a user)
    set.delete(String(ADMIN_CHAT_ID));

    // Convert to array, drop non-numeric / very short values (basic sanity)
    const arr = Array.from(set).filter(id => {
      if (!id) return false;
      // Telegram chat ids can be negative (groups) or long ints; keep strings longer than 3
      return String(id).length >= 4;
    });

    return arr;
  }

  // Telegram send helpers
  async function sendText(chatId, text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const body = { chat_id: String(chatId), text, parse_mode: 'HTML', disable_web_page_preview: true };
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await r.json().catch(()=>({ ok: false, description: 'invalid-json' }));
    if (!r.ok || json.ok === false) {
      throw new Error(json.description || `HTTP ${r.status}`);
    }
    return json;
  }

  async function sendMedia(chatId, buf, mType, caption) {
    // use form-data for Node environment
    const FormDataLib = (await import('form-data')).default;
    const form = new FormDataLib();
    form.append('chat_id', String(chatId));

    const isVideo = mType && mType.startsWith('video/');
    const isGif = mType === 'image/gif' || (mType && mType === 'image/gif');
    const isPhoto = mType && mType.startsWith('image/') && !isGif;

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
    } else {
      throw new Error('Unsupported media type');
    }
  }

  // Build recipients list
  let recipients = [];
  try {
    recipients = await gatherRecipients();
  } catch (e) {
    recipients = [];
  }

  // If none found, fallback to admin only (to preserve previous behavior)
  if (!recipients || recipients.length === 0) {
    recipients = [String(ADMIN_CHAT_ID)];
  }

  // Prepare media buffer if any
  let buffer = null;
  if (media && mediaType) {
    const base64 = (typeof media === 'string' && media.includes(',')) ? media.split(',')[1] : media;
    try {
      buffer = Buffer.from(base64 || '', 'base64');
    } catch (e) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid base64 media' }) };
    }
  }

  // Send to recipients sequentially (simple rate-limiting)
  const results = [];
  for (const id of recipients) {
    try {
      if (buffer && mediaType) {
        const res = await sendMedia(id, buffer, mediaType, message || undefined);
        results.push({ chatId: id, ok: true, telegram: { result: res }});
      } else if (message) {
        const res = await sendText(id, message);
        results.push({ chatId: id, ok: true, telegram: { result: res }});
      } else {
        results.push({ chatId: id, ok: false, error: 'No message or media' });
      }
      // small delay to reduce risk of hitting Telegram rate limits
      await new Promise(r => setTimeout(r, 70));
    } catch (e) {
      const errMsg = (e && e.message) ? e.message : String(e);
      results.push({ chatId: id, ok: false, error: errMsg });
    }
  }

  // send admin summary to CHAT_ID
  const total = results.length;
  const success = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  const summaryText = `📣 Announcement completed\nTotal: ${total}\nSuccess: ${success}\nFailed: ${failed.length}\nErrors (first 5):\n${failed.slice(0,5).map(f=>`${f.chatId}: ${f.error}`).join('\n')}`;

  try {
    await sendText(String(ADMIN_CHAT_ID), summaryText);
  } catch (e) {
    // if admin message fails, keep moving — but include in response
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ ok: true, total, success, failedCount: failed.length, results })
  };
}

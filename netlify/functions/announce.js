// announce.js  (Netlify function) -- no external installs required
// Expects environment vars (preferred):
//   TELEGRAM_BOT_TOKEN  - your Telegram bot token
//   FIREBASE_DB_URL     - root URL of your RTDB, e.g. https://your-project.firebaseio.com
//
// Or include telegramBotToken / firebaseDbUrl in the POST body.
// POST body JSON accepted fields:
//   message: string (optional, default provided)
//   media: string (optional) - must be a public URL or Telegram file_id (NOT data: base64)
//   mediaType: string (optional) - hint like "image", "video", "audio", "document", "animation"
//   chatIds: [ "123", "456" ] (optional) - if absent, function will pull keys from /telegramUsers
//
// Returns JSON summary: { success, failed, errors: [...] }

const MAX_RETRIES = 3;
const BATCH_SIZE = 25;        // how many parallel requests per batch
const BATCH_DELAY_MS = 700;   // pause between batches to reduce rate-limit chances
const RETRY_BASE_MS = 600;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isLikelyUrl(s) {
  return typeof s === 'string' && (/^https?:\/\//i).test(s);
}

function isDataUri(s) {
  return typeof s === 'string' && s.startsWith('data:');
}

async function fetchJsonWithRetries(url, opts = {}, attempt = 0) {
  try {
    const res = await fetch(url, opts);
    const text = await res.text().catch(()=>null);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch(e){ /* not json */ }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    // network-level error
    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
      return fetchJsonWithRetries(url, opts, attempt + 1);
    }
    throw err;
  }
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed. Use POST.' })
    };
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const msg = (body.message || '').trim();
    const media = body.media;         // URL or file_id (NOT base64)
    const mediaTypeHint = (body.mediaType || '').toLowerCase();
    const providedChatIds = Array.isArray(body.chatIds) ? body.chatIds.map(String) : null;

    // Resolve token & firebase url (env var preferred)
    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || body.telegramBotToken;
    const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || body.firebaseDbUrl;

    if (!TELEGRAM_BOT_TOKEN) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing Telegram bot token. Set TELEGRAM_BOT_TOKEN env or include telegramBotToken in body.' })
      };
    }

    // Get chatIds
    let chatIds = [];
    if (providedChatIds && providedChatIds.length > 0) {
      chatIds = providedChatIds.filter(Boolean);
    } else {
      // Try to fetch from Firebase /telegramUsers (keys are chat ids per your structure)
      if (!FIREBASE_DB_URL) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'No chatIds provided and FIREBASE_DB_URL not set. Provide chatIds or set FIREBASE_DB_URL.' })
        };
      }

      // ensure /telegramUsers.json
      const url = FIREBASE_DB_URL.replace(/\/$/, '') + '/telegramUsers.json';
      let fetched;
      try {
        fetched = await fetchJsonWithRetries(url, { method: 'GET' });
      } catch (err) {
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: `Failed to fetch telegramUsers from Firebase: ${err.message}` })
        };
      }

      if (!fetched.ok) {
        // firebase returns 200 with null if no data
        if (fetched.status === 404 || fetched.json === null) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'No telegramUsers found at provided FIREBASE_DB_URL.' })
          };
        } else {
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: `Firebase fetch returned status ${fetched.status}`, detail: fetched.text || null })
          };
        }
      }

      const firebaseObj = fetched.json || {};
      // extract keys as chatIds (your example uses chatId as key like "6426424898")
      chatIds = Object.keys(firebaseObj || {}).filter(k => !!k);
      if (chatIds.length === 0) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'No chat IDs found under /telegramUsers in Firebase.' })
        };
      }
    }

    // Validate media:
    if (media) {
      if (isDataUri(media)) {
        // We refuse base64/data URIs because we don't want to require multipart/form-data libs
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Base64/data-URI media not supported by this function (no external libs). Use a public URL or Telegram file_id.' })
        };
      }
      if (!isLikelyUrl(media) && typeof media !== 'string') {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Media must be a public URL or Telegram file_id string.' })
        };
      }
    }

    // Prepare sender function with retries
    async function sendToChat(chatId) {
      const base = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/`;
      let method = 'sendMessage';
      let payload = {};

      if (media) {
        // pick method by hint or fallback by URL extension
        if (mediaTypeHint.includes('image') || /\.(jpeg|jpg|png|webp|bmp|tiff)(\?|$)/i.test(media)) {
          method = 'sendPhoto';
          payload.photo = media;
          if (msg) payload.caption = msg;
        } else if (mediaTypeHint.includes('video') || /\.(mp4|mov|webm|mkv)(\?|$)/i.test(media)) {
          method = 'sendVideo';
          payload.video = media;
          if (msg) payload.caption = msg;
        } else if (mediaTypeHint.includes('audio') || /\.(mp3|wav|m4a|ogg)(\?|$)/i.test(media)) {
          method = 'sendAudio';
          payload.audio = media;
          if (msg) payload.caption = msg;
        } else if (mediaTypeHint.includes('animation') || /\.(gif)(\?|$)/i.test(media)) {
          method = 'sendAnimation';
          payload.animation = media;
          if (msg) payload.caption = msg;
        } else {
          // fallback to document
          method = 'sendDocument';
          payload.document = media;
          if (msg) payload.caption = msg;
        }
      } else {
        method = 'sendMessage';
        payload.text = msg || 'Announcement from Queue Joy';
        payload.disable_web_page_preview = true;
        payload.parse_mode = 'HTML';
      }

      payload.chat_id = chatId;

      // try with retries for transient errors (429 / 5xx) up to MAX_RETRIES
      let attempt = 0;
      while (attempt <= MAX_RETRIES) {
        try {
          const res = await fetch(base + method, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          const data = await res.json().catch(()=>({ ok: res.ok, description: 'Invalid JSON response' }));

          if (res.ok && data && data.ok) {
            return { ok: true };
          }

          // If Telegram says 429 or server error, treat as retryable
          const code = res.status;
          const description = (data && data.description) || 'Unknown Telegram error';

          if ((code === 429 || (code >= 500 && code < 600)) && attempt < MAX_RETRIES) {
            // respect Telegram's retry_after if present
            const retryAfter = data && data.retry_after ? (Number(data.retry_after) * 1000) : (RETRY_BASE_MS * Math.pow(2, attempt));
            await sleep(retryAfter);
            attempt++;
            continue;
          }

          // non-retryable or maxed out
          return { ok: false, error: description, status: code, raw: data };
        } catch (err) {
          if (attempt < MAX_RETRIES) {
            await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
            attempt++;
            continue;
          }
          return { ok: false, error: err.message || String(err) };
        }
      }

      return { ok: false, error: 'Max retries reached' };
    }

    // send in batches
    const results = { success: 0, failed: 0, errors: [] };
    for (let i = 0; i < chatIds.length; i += BATCH_SIZE) {
      const batch = chatIds.slice(i, i + BATCH_SIZE);
      const promises = batch.map(id => sendToChat(id).then(r => ({ id, r })));
      const settled = await Promise.all(promises);
      settled.forEach(item => {
        if (item.r && item.r.ok) {
          results.success++;
        } else {
          results.failed++;
          results.errors.push({ chatId: item.id, error: (item.r && (item.r.error || item.r.raw)) || 'Unknown' });
        }
      });
      // small delay between batches
      if (i + BATCH_SIZE < chatIds.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: 'Announcement processed',
        totalTargets: chatIds.length,
        success: results.success,
        failed: results.failed,
        errors: results.errors
      })
    };

  } catch (err) {
    console.error('announce.js error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || String(err) })
    };
  }
};

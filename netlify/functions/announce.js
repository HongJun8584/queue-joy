// netlify/functions/announce.js
// Enhanced announcer supporting text, images, videos, and GIFs
// Accepts POST JSON: { "message": "Hello", "media": "base64...", "mediaType": "image/jpeg" }
// If MASTER_API_KEY env exists, requests must include header x-master-key or Authorization: Bearer <key>

export async function handler(event) {
  // CORS: allow browser clients
  const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-master-key',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
  };

  // OPTIONS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Only POST allowed' })
    };
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const CHAT_ID = process.env.CHAT_ID;
  const MASTER_KEY = process.env.MASTER_API_KEY || '';

  if (!BOT_TOKEN || !CHAT_ID) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'BOT_TOKEN and CHAT_ID must be set in environment' })
    };
  }

  // If MASTER_API_KEY is set, require caller to present it
  if (MASTER_KEY) {
    const provided =
      (event.headers && (event.headers['x-master-key'] || event.headers['X-Master-Key'])) ||
      (event.headers && event.headers['authorization']);
    const token = provided && String(provided).startsWith('Bearer ')
      ? String(provided).slice(7)
      : provided;
    if (!token || token !== MASTER_KEY) {
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Unauthorized (missing or invalid master key)' })
      };
    }
  }

  // Parse body
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  const message = (payload.message || '').toString().trim();
  const media = payload.media;
  const mediaType = payload.mediaType || '';

  // Send media if provided, otherwise send text
  let apiEndpoint;
  let bodyToSend;

  if (media && mediaType) {
    // Detect media type
    const isVideo = mediaType.startsWith('video/');
    const isGif = mediaType === 'image/gif' || media.includes('data:image/gif');
    const isPhoto = mediaType.startsWith('image/') && !isGif;

    // Convert base64 to buffer
    const base64Data = media.split(',')[1] || media;
    const buffer = Buffer.from(base64Data, 'base64');

    // Use FormData to send media
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('chat_id', String(CHAT_ID));

    if (isVideo) {
      apiEndpoint = `https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`;
      form.append('video', buffer, { filename: 'video.mp4', contentType: mediaType });
      if (message) form.append('caption', message);
    } else if (isGif) {
      apiEndpoint = `https://api.telegram.org/bot${BOT_TOKEN}/sendAnimation`;
      form.append('animation', buffer, { filename: 'animation.gif', contentType: 'image/gif' });
      if (message) form.append('caption', message);
    } else if (isPhoto) {
      apiEndpoint = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
      form.append('photo', buffer, { filename: 'photo.jpg', contentType: mediaType });
      if (message) form.append('caption', message);
    } else {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Unsupported media type' })
      };
    }

    try {
      const fetch = (await import('node-fetch')).default;
      const res = await fetch(apiEndpoint, {
        method: 'POST',
        body: form,
        headers: form.getHeaders(),
      });

      const json = await res.json();
      if (!res.ok || json.ok === false) {
        const errMsg = (json && json.description) ? json.description : `Telegram error ${res.status}`;
        return {
          statusCode: 502,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Telegram send failed', detail: errMsg, raw: json })
        };
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ ok: true, deliveredTo: CHAT_ID, telegram: json })
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Internal error sending to Telegram', detail: String(err) })
      };
    }
  } else if (message) {
    // Send text only
    if (!message) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Missing message field' })
      };
    }

    const MAX_LEN = 4000;
    const finalMessage = message.length > MAX_LEN ? message.slice(0, MAX_LEN) + '…' : message;

    apiEndpoint = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    bodyToSend = {
      chat_id: String(CHAT_ID),
      text: finalMessage,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };

    try {
      const fetch = (await import('node-fetch')).default;
      const res = await fetch(apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyToSend)
      });

      const json = await res.json();
      if (!res.ok || json.ok === false) {
        const errMsg = (json && json.description) ? json.description : `Telegram error ${res.status}`;
        return {
          statusCode: 502,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Telegram send failed', detail: errMsg, raw: json })
        };
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ ok: true, deliveredTo: CHAT_ID, telegram: json })
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Internal error sending to Telegram', detail: String(err) })
      };
    }
  } else {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Must provide either message or media' })
    };
  }
}

// netlify/functions/createTelegramLink.js
// Generates a unique /start token and (optionally) persists a mapping to Firebase RTDB.
// Env vars recommended:
//   FIREBASE_DB_URL  - (optional) Realtime DB root URI, e.g. https://your-db.firebaseio.com
//   BOT_USERNAME     - (optional) Telegram bot username (without @). Defaults to "QueueJoyBot".
//   ALLOWED_ORIGIN   - (optional) value for Access-Control-Allow-Origin (default "*")
// Usage: POST JSON { queueKey, counterId, counterName } -> returns { link, token, expiresAt }

import { nanoid } from 'nanoid';

const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function handler(event) {
  const CORS_HEADERS = {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Only POST allowed' }),
    };
  }

  // parse JSON safely
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (err) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  // sanitize inputs (trim and limit length)
  const sanitize = (v, max = 250) => {
    if (!v && v !== 0) return '';
    const s = String(v).trim();
    return s.length > max ? s.slice(0, max) : s;
  };

  const queueKey = sanitize(body.queueKey || '');
  const counterId = sanitize(body.counterId || '');
  const counterName = sanitize(body.counterName || '');
  const meta = sanitize(body.meta || ''); // optional free-form metadata

  // generate token
  const token = nanoid(12);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + DEFAULT_TOKEN_TTL_MS).toISOString();

  // Build payload to persist (if DB configured)
  const payload = {
    queueKey,
    counterId,
    counterName,
    meta,
    createdAt,
    expiresAt,
    used: false,
    userAgent: (event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || null,
    ip: (
      (event.headers && (event.headers['x-forwarded-for'] || event.headers['X-Forwarded-For'])) ||
      (event.headers && (event.headers['x-nf-client-connection-ip'])) ||
      null
    ),
  };

  const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');

  // determine bot username
  const botEnv = process.env.BOT_USERNAME || process.env.BOT_USER || 'QueueJoyBot';
  const botUsername = String(botEnv).replace(/^@/, '').trim() || 'QueueJoyBot';

  // Build Telegram deep link
  const telegramLink = `https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(token)}`;

  // Try to persist mapping if DB configured
  if (FIREBASE_DB_URL) {
    const path = `${FIREBASE_DB_URL}/telegramTokens/${encodeURIComponent(token)}.json`;
    try {
      const resp = await fetch(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        // non-fatal: log and continue — still return the link so UX isn't blocked
        const bodyText = await resp.text().catch(() => '');
        console.warn('createTelegramLink: firebase write failed', resp.status, bodyText);
      }
    } catch (err) {
      console.warn('createTelegramLink: firebase write exception', String(err));
    }
  } else {
    console.warn('createTelegramLink: FIREBASE_DB_URL not set — token will not be persisted');
  }

  // successful response
  return {
    statusCode: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ok: true,
      link: telegramLink,
      token,
      createdAt,
      expiresAt,
    }),
  };
}

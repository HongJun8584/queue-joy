// netlify/functions/announce.js
// Public-safe announce endpoint.
// Two modes:
// 1. Full mode (Firebase service account available): broadcast to business subscribers.
// 2. Fallback mode (no Firebase): send message to single CHAT_ID (your test chat).
//
// POST JSON:
// { "message": "Hello", "business": "mycafe", "mode": "registered" }
// or simple test:
// { "message": "Hello world" }

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || process.env.STORE_CHAT_ID || '';
const FIREBASE_SVC = process.env.FIREBASE_SERVICE_ACCOUNT || '';
const FIREBASE_DB_URL = process.env.FIREBASE_DATABASE_URL || '';

const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

async function sendTelegram(chatId, text) {
  if (!TELEGRAM_API) throw new Error('BOT_TOKEN not configured.');
  const payload = {
    chat_id: String(chatId),
    text: String(text),
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const j = await res.json().catch(() => ({ ok: false }));
  if (!res.ok || j.ok === false) {
    const desc = (j && j.description) ? j.description : `HTTP ${res.status}`;
    const e = new Error(`Telegram send failed: ${desc}`);
    e.raw = j;
    throw e;
  }
  return j;
}

// optional firebase admin setup
let db = null;
async function initFirebaseIfAvailable() {
  if (!FIREBASE_SVC || !FIREBASE_DB_URL) return null;
  if (db) return db;
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      const svc = typeof FIREBASE_SVC === 'string' ? JSON.parse(FIREBASE_SVC) : FIREBASE_SVC;
      admin.initializeApp({
        credential: admin.credential.cert(svc),
        databaseURL: FIREBASE_DB_URL
      });
    }
    db = admin.database();
    return db;
  } catch (err) {
    console.warn('Firebase init failed:', err.message);
    return null;
  }
}

async function gatherChatIdsFromFirebase(db, slug) {
  const paths = [
    `businesses/${slug}/customers`,
    `businesses/${slug}/telegramSubscribers`,
    `businesses/${slug}/subscribers`,
    `subscribers/${slug}`,
    `businesses/${slug}/customersList`
  ];
  for (const p of paths) {
    const snap = await db.ref(p).once('value');
    if (snap.exists()) {
      const val = snap.val() || {};
      const ids = [];
      for (const k of Object.keys(val)) {
        const v = val[k];
        if (v && typeof v === 'object') {
          if (v.chatId) ids.push(String(v.chatId));
          else if (v.id && /^\d+$/.test(String(v.id))) ids.push(String(v.id));
        } else if (/^\d+$/.test(k)) ids.push(k);
      }
      return [...new Set(ids)].filter(Boolean);
    }
  }
  return [];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST')
      return { statusCode: 405, body: JSON.stringify({ error: 'Only POST allowed' }) };

    const body = JSON.parse(event.body || '{}');
    const message = (body.message || '').trim();
    const slug = (body.business || '').trim();
    const mode = (body.mode || 'registered').trim();

    if (!message) return { statusCode: 400, body: JSON.stringify({ error: 'message required' }) };

    const dbInstance = await initFirebaseIfAvailable();

    // Firebase full mode
    if (dbInstance && slug) {
      const settingsSnap = await dbInstance.ref(`businesses/${slug}/settings`).once('value');
      if (!settingsSnap.exists())
        return { statusCode: 404, body: JSON.stringify({ error: `Business ${slug} not found` }) };

      const settings = settingsSnap.val();

      if (mode === 'channel') {
        const chatId = settings.chatId || settings.channelChatId || settings.chat_id;
        if (!chatId)
          return { statusCode: 400, body: JSON.stringify({ error: 'No chatId for this business' }) };
        await sendTelegram(chatId, message);
        return { statusCode: 200, body: JSON.stringify({ ok: true, mode: 'channel', deliveredTo: chatId }) };
      }

      const chatIds = await gatherChatIdsFromFirebase(dbInstance, slug);
      if (!chatIds.length)
        return { statusCode: 404, body: JSON.stringify({ error: 'No registered customers found' }) };

      const results = { attempted: chatIds.length, sent: 0, errors: [] };
      for (const c of chatIds) {
        try {
          await sendTelegram(c, message);
          results.sent++;
        } catch (err) {
          results.errors.push({ chatId: c, err: err.message });
        }
        await sleep(40);
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true, mode: 'registered', ...results }) };
    }

    // fallback mode
    if (!CHAT_ID)
      return { statusCode: 503, body: JSON.stringify({ error: 'CHAT_ID not configured in environment' }) };

    await sendTelegram(CHAT_ID, message);
    return { statusCode: 200, body: JSON.stringify({ ok: true, mode: 'fallback', deliveredTo: CHAT_ID }) };
  } catch (err) {
    console.error('announce error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};

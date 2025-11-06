// netlify/functions/announce.js
// Fallback-capable announce. Two modes:
// - Full mode (server has FIREBASE_SERVICE_ACCOUNT): find registered customers in Firebase and send to each.
// - Fallback mode (no Firebase): send the message to a single STORE_CHAT_ID env (test mode).
//
// Usage (POST JSON):
// { "business":"mycafe", "message":"Hello customers", "mode":"registered" }
// or for fallback test just send { "message":"test" } and it will post to STORE_CHAT_ID
//
// NOTE: This file is intentionally tolerant so you can test with only TELEGRAM_BOT_TOKEN + STORE_CHAT_ID.

const util = require('util');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const STORE_CHAT_ID = process.env.STORE_CHAT_ID || ''; // fallback chat id for testing
const FIREBASE_SVC = process.env.FIREBASE_SERVICE_ACCOUNT || '';
const FIREBASE_DB_URL = process.env.FIREBASE_DATABASE_URL || '';

const TELEGRAM_API = TELEGRAM_BOT_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}` : null;

async function sendTelegram(chatId, text) {
  if (!TELEGRAM_API) throw new Error('TELEGRAM_BOT_TOKEN not configured.');
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
  const j = await res.json().catch(()=>({ ok:false }));
  if (!res.ok || j.ok === false) {
    const desc = (j && j.description) ? j.description : `HTTP ${res.status}`;
    const e = new Error(`Telegram send failed: ${desc}`);
    e.raw = j;
    throw e;
  }
  return j;
}

// optional firebase admin helper loader
let db = null;
async function initFirebaseIfAvailable() {
  if (!FIREBASE_SVC || !FIREBASE_DB_URL) return null;
  if (db) return db;
  try {
    // lazy-load admin SDK only if we have service account
    const admin = require('firebase-admin');
    if (!admin.apps || !admin.apps.length) {
      const svc = (typeof FIREBASE_SVC === 'string') ? JSON.parse(FIREBASE_SVC) : FIREBASE_SVC;
      admin.initializeApp({
        credential: admin.credential.cert(svc),
        databaseURL: FIREBASE_DB_URL
      });
    }
    db = admin.database();
    return db;
  } catch (err) {
    console.warn('Failed to init firebase admin:', err && err.message);
    return null;
  }
}

async function gatherChatIdsFromFirebase(db, slug) {
  // look for common customer paths; tolerantly return array of chatIds
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
        if (typeof v === 'boolean' && v === true) ids.push(k);
        else if (v && typeof v === 'object') {
          if (v.chatId) ids.push(String(v.chatId));
          else if (v.id && /^\d+$/.test(String(v.id))) ids.push(String(v.id));
          else if (/^\d+$/.test(k)) ids.push(k);
        } else if (/^\d+$/.test(k)) ids.push(k);
      }
      return [...new Set(ids)].filter(Boolean);
    }
  }
  return [];
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

exports.handler = async function(event, context) {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Only POST allowed' }) };
    }

    const body = (() => {
      try { return JSON.parse(event.body || '{}'); } catch(e){ return {}; }
    })();

    const message = (body.message || '').toString().trim();
    const slug = (body.business || '').toString().trim();
    const mode = (body.mode || 'registered').toString();

    if (!message) {
      return { statusCode: 400, body: JSON.stringify({ error: 'message required' }) };
    }

    // If Firebase available and business slug provided -> full mode
    const dbInstance = await initFirebaseIfAvailable();

    if (dbInstance && slug) {
      // full mode: if mode == channel -> read settings.chatId ; else registered -> read customers
      const settingsSnap = await dbInstance.ref(`businesses/${slug}/settings`).once('value');
      if (!settingsSnap.exists()) {
        return { statusCode: 404, body: JSON.stringify({ error: `Business ${slug} not found in Firebase` }) };
      }
      const settings = settingsSnap.val();
      if (mode === 'channel') {
        const chatId = settings.chatId || settings.channelChatId || settings.chat_id;
        if (!chatId) return { statusCode: 400, body: JSON.stringify({ error: 'No chatId configured for this business' }) };
        await sendTelegram(chatId, message);
        return { statusCode: 200, body: JSON.stringify({ ok:true, mode:'channel', deliveredTo: chatId }) };
      }

      // registered
      const chatIds = await gatherChatIdsFromFirebase(dbInstance, slug);
      if (!chatIds || chatIds.length === 0) return { statusCode: 404, body: JSON.stringify({ error: 'No registered customers found' }) };

      const results = { attempted: chatIds.length, sent:0, errors:[] };
      for (const c of chatIds) {
        try {
          await sendTelegram(c, message);
          results.sent++;
        } catch (err) {
          results.errors.push({ chatId: c, err: err.message || String(err) });
        }
        // small delay to be polite to Telegram API
        await sleep(40);
      }
      return { statusCode: 200, body: JSON.stringify(Object.assign({ ok:true, mode:'registered' }, results)) };
    }

    // FALLBACK mode: no firebase available or no slug passed
    // Use STORE_CHAT_ID as single target (must be set in env)
    if (!STORE_CHAT_ID) {
      return { statusCode: 503, body: JSON.stringify({ error: 'No Firebase available and STORE_CHAT_ID not configured in env for fallback testing' }) };
    }

    // send to fallback chat
    await sendTelegram(STORE_CHAT_ID, message);
    return { statusCode: 200, body: JSON.stringify({ ok:true, mode:'fallback', deliveredTo: STORE_CHAT_ID }) };

  } catch (err) {
    console.error('announce handler error', err && err.stack || err);
    return { statusCode: 500, body: JSON.stringify({ error: err && err.message ? err.message : String(err) }) };
  }
};

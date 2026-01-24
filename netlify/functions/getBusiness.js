// netlify/functions/getBusiness.js
// Minimal, robust Netlify function to read a business record from Firebase RTDB.
// Expects environment:
//   FIREBASE_DATABASE_URL
//   FIREBASE_SERVICE_ACCOUNT_BASE64  (preferred) OR FIREBASE_SERVICE_ACCOUNT (raw JSON) OR FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
// Optional:
//   CACHE_TTL (seconds) - default 30

const { ensureFirebase } = require('./utils/firebase-admin');

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};

function jsonResponse(status, body) {
  return { statusCode: status, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function normalizeSlug(raw = '') {
  return (raw || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// strict validation: allow a-z, 0-9 and hyphen, min 1, max 100
function validSlug(s) {
  return typeof s === 'string' && /^[a-z0-9\-]{1,100}$/.test(s);
}

// Simple in-memory cache (works only on warm lambda instances)
const CACHE_TTL = Math.max(0, parseInt(process.env.CACHE_TTL || '30', 10)); // seconds
const cache = new Map(); // key -> { expires: epoch_ms, value }

function getCached(key) {
  if (!CACHE_TTL) return null;
  const ent = cache.get(key);
  if (!ent) return null;
  if (Date.now() > ent.expires) {
    cache.delete(key);
    return null;
  }
  return ent.value;
}

function setCached(key, value) {
  if (!CACHE_TTL) return;
  cache.set(key, { value, expires: Date.now() + CACHE_TTL * 1000 });
}

exports.handler = async function handler(event) {
  // handle CORS preflight fast
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS };

  // Init Firebase (clear errors returned to client help debugging minimal)
  let db;
  try {
    const fb = await ensureFirebase();
    if (!fb || !fb.db) {
      console.error('getBusiness: ensureFirebase returned no db object');
      return jsonResponse(500, { error: 'server_misconfigured', message: 'Firebase initialization failed (no db).' });
    }
    db = fb.db;
  } catch (e) {
    // Log full error server-side; return trimmed message client-side
    console.error('getBusiness: firebase init error:', e && (e.stack || e.message || e));
    return jsonResponse(500, { error: 'server_misconfigured', message: String(e && e.message) });
  }

  // extract slug
  let slug = null;
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    slug = params.slug || params.s || null;
  } else if (event.httpMethod === 'POST') {
    if (event.body && event.body.length > 100_000) {
      return jsonResponse(413, { error: 'payload_too_large', message: 'Request body too large' });
    }
    try {
      const body = event.body ? JSON.parse(event.body) : {};
      slug = body.slug || body.name || null;
    } catch (err) {
      return jsonResponse(400, { error: 'invalid_json', message: 'Request body must be valid JSON' });
    }
  } else {
    return jsonResponse(405, { error: 'method_not_allowed', message: 'Only GET or POST allowed' });
  }

  if (!slug) return jsonResponse(400, { error: 'invalid_slug', message: 'Slug parameter is required' });

  const norm = normalizeSlug(slug);
  if (!validSlug(norm)) {
    return jsonResponse(400, { error: 'invalid_slug', message: 'Slug contains invalid characters or length' });
  }

  // cache key
  const cacheKey = `business:${norm}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return jsonResponse(200, { ok: true, data: cached, cached: true });
  }

  // read from RTDB (support both .once and .get)
  try {
    const ref = db.ref ? db.ref(`businesses/${norm}`) : null;
    let snap;
    if (ref && typeof ref.once === 'function') {
      snap = await ref.once('value');
    } else if (db.ref) {
      // fallback: some versions expose .ref().get()
      snap = await db.ref(`businesses/${norm}`).get();
    } else {
      // last resort: try admin.database().ref
      throw new Error('RTDB API not available on admin.db()');
    }

    const data = snap && (typeof snap.val === 'function' ? snap.val() : snap.exists && snap.exists() ? snap.val() : null);
    if (!data) return jsonResponse(404, { error: 'not_found', slug: norm });

    // store in cache for next calls (warm lambda)
    try { setCached(cacheKey, data); } catch (e) { /* no-op */ }

    return jsonResponse(200, { ok: true, data });
  } catch (e) {
    console.error('getBusiness: db read failed:', e && (e.stack || e.message || e));
    return jsonResponse(500, { error: 'db_error', message: String(e && e.message) });
  }
};

// netlify/functions/getBusiness.js
// GET or POST /.netlify/functions/getBusiness
// Query param: ?slug=the-slug OR POST body { slug }

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: CORS_HEADERS,
    body: JSON.stringify(body)
  };
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

async function locateFirebaseHelper() {
  // Try a few plausible locations in order
  const candidates = [
    './utils/firebase-admin',
    './firebase-admin',
    './_shared/firebase-admin',
    '../functions/utils/firebase-admin' // sometimes relative layout differs
  ];

  let lastErr = null;

  for (const p of candidates) {
    try {
      // require can throw if file missing or has syntax error
      const mod = require(p);
      if (!mod) continue;

      // If module exports an ensureFirebase function, use that
      if (typeof mod.ensureFirebase === 'function') {
        return mod.ensureFirebase;
      }

      // If module exports { admin, db } (already initialized), wrap it
      if (mod.admin && mod.db) {
        return async () => ({ admin: mod.admin, db: mod.db });
      }

      // If module exports admin directly (rare), wrap it
      if (mod.initializeApp || mod.credential) {
        // assume it's firebase-admin package; we can't initialize here without credentials
        // skip — lastErr updated for debugging
        lastErr = new Error(`found firebase-admin package at ${p} but not a helper`);
        continue;
      }

      lastErr = new Error(`module at ${p} did not export ensureFirebase() or {admin,db}`);
    } catch (e) {
      lastErr = e;
      // continue to next candidate
    }
  }

  // Nothing worked
  const e = lastErr || new Error('No firebase helper found');
  throw e;
}

exports.handler = async function handler(event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS };
  }

  // Lazy load firebase helper in try/catch so handler always exports
  let ensureFirebase;
  try {
    ensureFirebase = await locateFirebaseHelper();
    if (typeof ensureFirebase !== 'function') {
      console.error('getBusiness: locateFirebaseHelper did not return a function');
      return jsonResponse(500, { error: 'server_misconfigured', message: 'Firebase helper not available' });
    }
  } catch (e) {
    console.error('getBusiness: firebase helper load failed:', e && (e.stack || e.message || e));
    return jsonResponse(500, { error: 'server_misconfigured', message: 'Failed to load firebase helper' });
  }

  // Init firebase
  let db;
  try {
    const fb = await ensureFirebase();
    if (!fb || !fb.db) {
      console.error('getBusiness: ensureFirebase did not return db');
      return jsonResponse(500, { error: 'server_misconfigured', message: 'Firebase initialization failed' });
    }
    db = fb.db;
  } catch (initErr) {
    console.error('getBusiness: firebase_init error:', initErr && (initErr.stack || initErr.message || initErr));
    return jsonResponse(500, { error: 'firebase_init_failed', message: 'Failed to initialize Firebase' });
  }

  try {
    // Accept GET or POST
    let slug = null;

    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      slug = params.slug || params.s || null;
    } else if (event.httpMethod === 'POST') {
      // guard body size (simple protection)
      if (event.body && event.body.length > 100_000) {
        return jsonResponse(413, { error: 'payload_too_large', message: 'Request body too large' });
      }

      let body;
      try {
        body = event.body ? JSON.parse(event.body) : {};
      } catch (e) {
        return jsonResponse(400, { error: 'invalid_json', message: 'Request body must be valid JSON' });
      }
      slug = body.slug || body.name || null;
    } else {
      return jsonResponse(405, { error: 'method_not_allowed', message: 'Only GET or POST allowed' });
    }

    if (!slug) {
      return jsonResponse(400, { error: 'invalid_slug', message: 'Slug parameter is required' });
    }

    const norm = normalizeSlug(slug);
    if (!norm) {
      return jsonResponse(400, { error: 'invalid_slug', message: 'Slug normalized to empty value' });
    }

    // Read from RTDB
    let snap;
    try {
      const ref = db.ref(`businesses/${norm}`);
      snap = await ref.once('value');
    } catch (dbErr) {
      console.error('getBusiness: db read failed:', dbErr && (dbErr.stack || dbErr.message || dbErr));
      return jsonResponse(500, { error: 'db_error', message: 'Failed to read from database' });
    }

    const data = snap && snap.val ? snap.val() : null;
    if (!data) {
      return jsonResponse(404, { error: 'not_found', slug: norm });
    }

    return jsonResponse(200, { ok: true, data });
  } catch (err) {
    console.error('getBusiness: unhandled error:', err && (err.stack || err.message || err));
    return jsonResponse(500, { error: 'server_error', message: 'Internal server error' });
  }
};

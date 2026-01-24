// netlify/functions/getBusiness.js
// GET or POST /.netlify/functions/getBusiness
// Query param: ?slug=the-slug OR POST body { slug }

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

exports.handler = async function handler(event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS };
  }

  // Initialize Firebase (will throw a clear error if env missing)
  let db;
  try {
    const fb = await ensureFirebase();
    if (!fb || !fb.db) {
      console.error('getBusiness: ensureFirebase did not return db');
      return jsonResponse(500, { error: 'server_misconfigured', message: 'Firebase initialization failed (no db returned)' });
    }
    db = fb.db;
  } catch (e) {
    console.error('getBusiness: firebase init failed:', e && (e.stack || e.message || e));
    // Return error details to help debug (non-sensitive: env missing or parse problems)
    return jsonResponse(500, { error: 'server_misconfigured', message: String(e && e.message) });
  }

  // parse slug
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
    } catch (e) {
      return jsonResponse(400, { error: 'invalid_json', message: 'Request body must be valid JSON' });
    }
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
  try {
    const ref = db.ref(`businesses/${norm}`);
    const snap = await ref.once('value');
    const data = snap && typeof snap.val === 'function' ? snap.val() : null;
    if (!data) {
      return jsonResponse(404, { error: 'not_found', slug: norm });
    }
    return jsonResponse(200, { ok: true, data });
  } catch (e) {
    console.error('getBusiness: db read failed:', e && (e.stack || e.message || e));
    return jsonResponse(500, { error: 'db_error', message: String(e && e.message) });
  }
};

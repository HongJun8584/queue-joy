// netlify/functions/getBusiness.js
// GET or POST /.netlify/functions/getBusiness
// Query param: ?slug=the-slug OR POST body { slug }

const { ensureFirebase } = require('./utils/firebase-admin');

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async function handler(event) {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
      } };
    }

    // init firebase
    let db;
    try {
      const fb = await ensureFirebase();
      db = fb.db;
    } catch (initErr) {
      console.error('getBusiness:init error', initErr && (initErr.stack || initErr.message || initErr));
      return jsonResponse(500, { error: 'firebase_init_failed', message: initErr.message || String(initErr) });
    }

    let slug = null;
    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      slug = params.slug || params.s;
    } else if (event.httpMethod === 'POST') {
      try {
        const body = event.body ? JSON.parse(event.body) : {};
        slug = body.slug || body.name;
      } catch (e) {
        return jsonResponse(400, { error: 'invalid_json', message: 'Request body must be valid JSON' });
      }
    } else {
      return jsonResponse(405, { error: 'method_not_allowed', message: 'Only GET or POST allowed' });
    }

    if (!slug) return jsonResponse(400, { error: 'invalid_slug', message: 'slug parameter required' });

    const norm = (slug || '').toString().trim().toLowerCase();
    const ref = db.ref(`businesses/${norm}`);
    const snap = await ref.once('value');
    const data = snap.val();

    if (!data) return jsonResponse(404, { error: 'not_found', slug: norm });

    return jsonResponse(200, { ok: true, data });
  } catch (err) {
    console.error('getBusiness:unhandled error', err && (err.stack || err.message || err));
    return jsonResponse(500, { error: 'server_error', message: err && err.message ? err.message : String(err) });
  }
};

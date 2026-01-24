// netlify/functions/updateBusiness.cjs
// POST /.netlify/functions/updateBusiness
// Header: x-master-key or Authorization: Bearer <MASTER_API_KEY>
// Body: { slug, updates }

const { ensureFirebase } = require('./utils/firebase-admin');

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization',
      'Access-Control-Allow-Methods': 'POST,OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

function getMasterKeyFromHeaders(headers = {}) {
  const low = {};
  for (const k of Object.keys(headers || {})) low[k.toLowerCase()] = headers[k];
  const master = process.env.MASTER_API_KEY || process.env.MASTER_KEY || '';
  if (!master) throw new Error('MASTER_API_KEY not configured on server.');
  const got = (low['x-master-key'] || low['x-api-key'] || low['authorization'] || '').toString();
  if (!got) return null;
  return got.startsWith('Bearer ') ? got.slice(7) : got;
}

function sanitizeName(n) { return (n || '').toString().trim(); }
function normalizeSlug(raw = '') { return (raw || '').toString().trim().toLowerCase(); }

module.exports.handler = async function handler(event) {
  try {
    // CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization',
        'Access-Control-Allow-Methods': 'POST,OPTIONS'
      } };
    }

    if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'method_not_allowed', message: 'Only POST allowed' });

    // init firebase
    let db;
    try {
      const fb = await ensureFirebase();
      if (!fb || !fb.db) {
        console.error('updateBusiness: ensureFirebase returned no db');
        return jsonResponse(500, { error: 'server_misconfigured', message: 'Firebase initialization failed' });
      }
      db = fb.db;
    } catch (initErr) {
      console.error('updateBusiness:init error', initErr && (initErr.stack || initErr.message || initErr));
      return jsonResponse(500, { error: 'firebase_init_failed', message: String(initErr && initErr.message) });
    }

    // auth
    let token;
    try {
      token = getMasterKeyFromHeaders(event.headers || {});
    } catch (e) {
      console.error('updateBusiness:masterkey config error', e && e.message);
      return jsonResponse(500, { error: 'server_misconfigured', message: 'MASTER_API_KEY not configured on server' });
    }
    const expected = (process.env.MASTER_API_KEY || process.env.MASTER_KEY || '').toString();
    if (!token || token !== expected) {
      return jsonResponse(403, { error: 'unauthorized', message: 'invalid or missing master key' });
    }

    // parse body
    let body = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch (e) {
      return jsonResponse(400, { error: 'invalid_json', message: 'Request body must be valid JSON' });
    }

    const slug = normalizeSlug(body.slug || '');
    const updates = body.updates && typeof body.updates === 'object' ? body.updates : null;
    if (!slug) return jsonResponse(400, { error: 'invalid_slug', message: 'slug is required' });
    if (!updates) return jsonResponse(400, { error: 'invalid_updates', message: 'updates object required' });

    // Prevent modification of immutable fields
    const forbidden = ['slug', 'createdAt', 'createdBy'];
    for (const f of forbidden) {
      if (Object.prototype.hasOwnProperty.call(updates, f)) {
        delete updates[f];
      }
    }

    // Read existing record
    const ref = db.ref(`businesses/${slug}`);
    const snap = await ref.once('value');
    if (!snap.exists()) return jsonResponse(404, { error: 'not_found', slug });

    const old = snap.val();

    // If name changed, update businesses_by_name atomically
    const oldName = (old && old.name) ? sanitizeName(old.name) : '';
    const newName = updates.name ? sanitizeName(updates.name) : '';
    const nameChanged = newName && newName !== oldName;

    // Build multi-path update for atomicity
    const multi = {};
    const updated = Object.assign({}, old, updates, { updatedAt: new Date().toISOString() });
    multi[`/businesses/${slug}`] = updated;

    if (nameChanged) {
      try {
        const oldNameKey = oldName ? encodeURIComponent(oldName.toLowerCase().trim()) : '';
        const newNameKey = encodeURIComponent(newName.toLowerCase().trim());
        multi[`/businesses_by_name/${newNameKey}`] = { slug, updatedAt: new Date().toISOString() };
        if (oldNameKey) multi[`/businesses_by_name/${oldNameKey}`] = null;
      } catch (e) {
        console.warn('updateBusiness: name index update failed to prepare', e && (e.message || e));
      }
    }

    try {
      await db.ref().update(multi);
    } catch (e) {
      console.error('updateBusiness: db update failed', e && (e.stack || e.message || e));
      return jsonResponse(500, { error: 'db_update_failed', message: String(e && e.message) });
    }

    const updatedSnap = await ref.once('value');
    return jsonResponse(200, { ok: true, data: updatedSnap.val() });
  } catch (err) {
    console.error('updateBusiness:unhandled error', err && (err.stack || err.message || err));
    return jsonResponse(500, { error: 'server_error', message: String(err && err.message) });
  }
};

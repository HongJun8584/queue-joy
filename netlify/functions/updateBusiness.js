// netlify/functions/updateBusiness.js
const { db } = require('./utils/firebase-admin');

function getMasterKeyFromHeaders(headers = {}) {
  const low = {};
  for (const k of Object.keys(headers || {})) {
    low[k.toLowerCase()] = headers[k];
  }

  const master = process.env.MASTER_API_KEY || process.env.MASTER_KEY || '';
  if (!master) throw new Error('MASTER_API_KEY not configured on server.');
  const got = low['x-master-key'] || low['x-api-key'] || low['authorization'] || '';
  if (!got) return null;
  return got.startsWith('Bearer ') ? got.slice(7) : got;
}

function normalizeSlug(raw = '') {
  return (raw || '').toString().trim().toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/-+/g,'-').replace(/^-|-$/g,'');
}

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

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization',
        'Access-Control-Allow-Methods': 'POST,OPTIONS'
      } };
    }

    if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Only POST allowed' });

    const token = getMasterKeyFromHeaders(event.headers || {});
    if (!token || token !== (process.env.MASTER_API_KEY || process.env.MASTER_KEY)) {
      return jsonResponse(403, { error: 'Unauthorized' });
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const slug = normalizeSlug(body.slug || '');
    const data = body.data && typeof body.data === 'object' ? body.data : null;

    if (!slug) return jsonResponse(400, { error: 'slug required' });
    if (!data) return jsonResponse(400, { error: 'data object required' });

    const allowed = new Set(['name', 'introText', 'adText', 'adImage', 'logo', 'chatId']);
    const update = {};
    for (const k of Object.keys(data)) {
      if (allowed.has(k)) update[k] = data[k];
    }

    if (Object.keys(update).length === 0) {
      return jsonResponse(400, { error: 'no valid keys to update', allowed: Array.from(allowed) });
    }

    const settingsRef = db.ref(`businesses/${slug}/settings`);

    // ensure business exists before updating
    const snap = await settingsRef.once('value');
    if (!snap.exists()) {
      return jsonResponse(404, { error: 'Business not found' });
    }

    await settingsRef.update(update);

    return jsonResponse(200, { ok: true, slug, updated: update });
  } catch (err) {
    console.error('updateBusiness error', err && (err.stack || err.message || err));
    return jsonResponse(500, { error: err.message || String(err) });
  }
};

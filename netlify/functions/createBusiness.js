// netlify/functions/createBusiness.js
// POST { slug, name?, defaults? }
// Protected: requires x-master-key header (MASTER_API_KEY)
// Creates businesses/<slug> (atomic check + write)

const { db } = require('./utils/firebase-admin');

function getMasterKeyFromHeaders(headers = {}) {
  const master = process.env.MASTER_API_KEY || '';
  if (!master) throw new Error('MASTER_API_KEY not configured on server.');
  const got = headers['x-master-key'] || headers['x-api-key'] || headers['authorization'] || '';
  if (!got) return null;
  return got.startsWith('Bearer ') ? got.slice(7) : got;
}

function normalizeSlug(raw = '') {
  return (raw || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')          // spaces -> dash
    .replace(/[^a-z0-9\-]/g, '-')  // allowed chars
    .replace(/-+/g,'-')            // collapse dashes
    .replace(/^-|-$/g,'');         // trim leading/trailing dash
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
    if (!token || token !== process.env.MASTER_API_KEY) {
      return jsonResponse(403, { error: 'Unauthorized' });
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const slugRaw = (body.slug || '').toString();
    const slug = normalizeSlug(slugRaw);
    if (!slug) return jsonResponse(400, { error: 'slug required' });

    const name = (body.name || slug).toString();
    const defaults = body.defaults && typeof body.defaults === 'object' ? body.defaults : {};
    const createdBy = body.createdBy || 'system';

    const data = {
      createdAt: Date.now(),
      name,
      settings: {
        name,
        introText: defaults.introText || 'Welcome to our store!',
        adText: defaults.adText || '',
        adImage: defaults.adImage || '',
        logo: defaults.logo || '',
        chatId: defaults.chatId || ''
      },
      customers: {},
      meta: {
        createdBy,
        id: slug
      },
      ... (defaults.extra && typeof defaults.extra === 'object' ? defaults.extra : {})
    };

    const ref = db.ref(`businesses/${slug}`);

    // Use transaction to ensure uniqueness (atomic)
    const result = await ref.transaction(current => {
      if (current !== null) {
        // keep current; returning undefined cancels the transaction, but we want to signal that it exists
        return; // abort (no change)
      }
      return data;
    }, undefined, false);

    if (!result.committed) {
      return jsonResponse(409, { error: 'Slug already exists' });
    }

    return jsonResponse(200, { ok: true, slug, data });
  } catch (err) {
    console.error('createBusiness error', err && (err.stack || err.message || err));
    return jsonResponse(500, { error: err.message || String(err) });
  }
};

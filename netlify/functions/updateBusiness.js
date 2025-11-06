// netlify/functions/updateBusiness.js
// POST { slug, data }
// Protected by MASTER_API_KEY in header x-master-key (or authorization Bearer).
// Updates businesses/<slug>/settings/*
// Accepts fields like name, introText, adText, adImage, logo, chatId

const { db } = require('./utils/firebase-admin');

function requireMasterKey(headers) {
  const master = process.env.MASTER_API_KEY || '';
  const got = headers['x-master-key'] || headers['x-api-key'] || headers['authorization'] || '';
  if (!master) throw new Error('MASTER_API_KEY not configured on server.');
  if (!got) return false;
  const token = got.startsWith('Bearer ') ? got.slice(7) : got;
  return token === master;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Only POST allowed' }) };

    if (!requireMasterKey(event.headers)) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const slug = (body.slug || '').trim();
    const data = body.data || null;

    if (!slug) return { statusCode: 400, body: JSON.stringify({ error: 'slug required' }) };
    if (!data || typeof data !== 'object') return { statusCode: 400, body: JSON.stringify({ error: 'data object required' }) };

    // sanitize allowed keys
    const allowed = ['name', 'introText', 'adText', 'adImage', 'logo', 'chatId'];
    const update = {};
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(data, k)) update[k] = data[k];
    }

    if (Object.keys(update).length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'no valid keys to update' }) };
    }

    await db.ref(`businesses/${slug}/settings`).update(update);

    return { statusCode: 200, body: JSON.stringify({ ok: true, updated: update }) };
  } catch (err) {
    console.error('updateBusiness error', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};

// netlify/functions/createBusiness.js
// POST { slug, name?, defaults? }
// Protected: requires x-master-key header (MASTER_API_KEY)
// Creates businesses/<slug>/settings/* with defaults.

const { db } = require('./utils/firebase-admin');
const { v4: uuidv4 } = require('uuid');

function requireMasterKey(headers) {
  const master = process.env.MASTER_API_KEY || '';
  const got = headers['x-master-key'] || headers['x-api-key'] || headers['authorization'] || '';
  if (!master) throw new Error('MASTER_API_KEY not configured on server.');
  if (!got) return false;
  // allow "Bearer <key>"
  const token = got.startsWith('Bearer ') ? got.slice(7) : got;
  return token === master;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Only POST' }) };

    if (!requireMasterKey(event.headers)) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const slugRaw = (body.slug || '').trim().toLowerCase();
    if (!slugRaw) return { statusCode: 400, body: JSON.stringify({ error: 'slug required' }) };

    const slug = slugRaw.replace(/[^a-z0-9\-]/g, '-');

    const ref = db.ref(`businesses/${slug}`);
    const snap = await ref.once('value');
    if (snap.exists()) {
      return { statusCode: 409, body: JSON.stringify({ error: 'Slug already exists' }) };
    }

    const name = body.name || slug;
    const defaults = body.defaults || {};

    const data = Object.assign({
      createdAt: Date.now(),
      name,
      settings: {
        name,
        introText: defaults.introText || 'Welcome to our store!',
        adText: defaults.adText || '',
        adImage: defaults.adImage || '',
        logo: defaults.logo || '',
        chatId: defaults.chatId || '' // optional store chat id
      },
      customers: {}, // blank map for telegram customers
      meta: {
        createdBy: body.createdBy || 'system',
        id: slug
      }
    }, defaults.extra || {});

    await ref.set(data);

    return { statusCode: 200, body: JSON.stringify({ ok: true, slug, data }) };
  } catch (err) {
    console.error('createBusiness error', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};

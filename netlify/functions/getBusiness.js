// netlify/functions/getBusiness.js
// GET ?slug=the-slug
// returns businesses/<slug>/settings/* (or global settings if slug omitted)

const { db } = require('./utils/firebase-admin');

function normalizeSlug(raw = '') {
  return (raw || '').toString().trim().toLowerCase().replace(/[^a-z0-9\-]/g, '-').replace(/-+/g,'-').replace(/^-|-$/g,'');
}

function jsonResponse(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,OPTIONS'
      } };
    }

    if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Only GET allowed' });

    const params = event.queryStringParameters || {};
    const slugRaw = params.slug || '';
    const slug = normalizeSlug(slugRaw);

    if (!slug) {
      // global settings
      const snap = await db.ref('settings').once('value');
      return jsonResponse(200, { ok: true, source: 'global', data: snap.val() || {} });
    }

    const snap = await db.ref(`businesses/${slug}/settings`).once('value');
    if (!snap.exists()) {
      return jsonResponse(404, { error: 'Business not found' });
    }
    const data = snap.val();
    return jsonResponse(200, { ok: true, slug, data });
  } catch (err) {
    console.error('getBusiness error', err && (err.stack || err.message || err));
    return jsonResponse(500, { error: err.message || String(err) });
  }
};

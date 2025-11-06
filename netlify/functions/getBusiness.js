// netlify/functions/getBusiness.js
// GET ?slug=the-slug
// returns businesses/<slug>/settings/* (or global settings/* if slug omitted)

const { db } = require('./utils/firebase-admin');

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const slug = (params.slug || '').trim();
    if (!slug) {
      // return global settings
      const snap = await db.ref('settings').once('value');
      return { statusCode: 200, body: JSON.stringify({ ok: true, source: 'global', data: snap.val() || {} }) };
    }

    const snap = await db.ref(`businesses/${slug}/settings`).once('value');
    if (!snap.exists()) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Business not found' }) };
    }
    const data = snap.val();
    return { statusCode: 200, body: JSON.stringify({ ok: true, slug, data }) };
  } catch (err) {
    console.error('getBusiness error', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};

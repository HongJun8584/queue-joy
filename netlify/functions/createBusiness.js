// netlify/functions/createBusiness.js
// Protected endpoint to provision a tenant in Realtime DB.
// POST { slug, name?, defaults?, createdBy? }
// Requires header: x-master-key: <MASTER_API_KEY>

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
  const got = low['x-master-key'] || low['x-api-key'] || low['authorization'] || '';
  if (!got) return null;
  return got.startsWith('Bearer ') ? got.slice(7) : got;
}

function normalizeSlug(raw = '') {
  return (raw || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')          // spaces -> dash
    .replace(/[^a-z0-9\-]/g, '-')  // allowed chars only
    .replace(/-+/g, '-')           // collapse repeated dashes
    .replace(/^-|-$/g, '');        // trim leading/trailing dash
}

function sanitizeName(n) {
  return (n || '').toString().trim();
}

exports.handler = async function handler(event) {
  try {
    // Respond to preflight quickly
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization',
        'Access-Control-Allow-Methods': 'POST,OPTIONS'
      } };
    }

    // Lazy init Firebase so missing envs produce JSON error instead of crashing function
    let db;
    try {
      const fb = await ensureFirebase();
      db = fb.db;
    } catch (initErr) {
      console.error('createBusiness:init error', initErr && (initErr.stack || initErr.message || initErr));
      return jsonResponse(500, { error: 'firebase_init_failed', message: initErr.message || String(initErr) });
    }

    if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'method_not_allowed', message: 'Only POST allowed' });

    // Auth: master key
    let token;
    try {
      token = getMasterKeyFromHeaders(event.headers || {});
    } catch (e) {
      console.error('createBusiness:masterkey config error', e && e.message);
      return jsonResponse(500, { error: 'server_misconfigured', message: 'MASTER_API_KEY not configured on server' });
    }
    if (!token || token !== (process.env.MASTER_API_KEY || process.env.MASTER_KEY)) {
      return jsonResponse(403, { error: 'unauthorized', message: 'invalid or missing master key' });
    }

    // Parse body defensively
    let body = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch (e) {
      return jsonResponse(400, { error: 'invalid_json', message: 'Request body must be valid JSON' });
    }

    const slug = normalizeSlug(body.slug || '');
    if (!slug) return jsonResponse(400, { error: 'invalid_slug', message: 'slug is required' });

    const name = sanitizeName(body.name || slug);
    if (!name || name.length < 1) return jsonResponse(400, { error: 'invalid_name', message: 'name is required' });

    const defaults = body.defaults && typeof body.defaults === 'object' ? body.defaults : {};
    const createdBy = body.createdBy || 'admin';

    // Build tenant object
    const nowIso = new Date().toISOString();
    const tenant = {
      slug,
      name,
      createdBy,
      createdAt: nowIso,
      status: 'active',
      billing: { provider: (body.billing && body.billing.provider) || 'stripe', createdAt: nowIso },
      settings: {
        name,
        introText: defaults.introText || '',
        adText: defaults.adText || '',
        adImage: defaults.adImage || '',
        logo: defaults.logo || '',
        chatId: defaults.chatId || '',
        timezone: defaults.timezone || 'Asia/Kuala_Lumpur',
        defaultPrefix: defaults.defaultPrefix || 'COFFEE'
      },
      links: {
        home: `${process.env.SITE_BASE || ''}/${slug}`,
        counter: `${process.env.SITE_BASE || ''}/${slug}/counter.html`,
        admin: `${process.env.SITE_BASE || ''}/${slug}/admin.html`
      },
      counters: { default: { name: 'Counter 1', value: 0, prefix: (defaults.defaultPrefix || 'COFFEE') } }
    };

    const ref = db.ref(`businesses/${slug}`);

    // Atomic creation via transaction to guarantee uniqueness
    const txRes = await ref.transaction(current => {
      if (current !== null) return; // abort if exists
      return tenant;
    }, undefined, false);

    if (!txRes.committed) {
      // Already exists: return existing info (friendly)
      const snap = await ref.once('value');
      const existing = snap.val() || {};
      return jsonResponse(409, { error: 'slug_exists', slug, existing });
    }

    // Best-effort name index (avoid blocking tenant creation if this fails)
    (async () => {
      try {
        const nameKey = encodeURIComponent(name.toLowerCase().trim());
        await db.ref(`/businesses_by_name/${nameKey}`).set({ slug, createdAt: nowIso });
      } catch (e) {
        console.warn('createBusiness: name index set failed', e && (e.message || e));
      }
    })();

    // Success
    return jsonResponse(200, { ok: true, slug, links: tenant.links, data: tenant });
  } catch (err) {
    console.error('createBusiness:unhandled error', err && (err.stack || err.message || err));
    return jsonResponse(500, { error: 'server_error', message: err && err.message ? err.message : String(err) });
  }
};

// netlify/functions/createBusiness.js
// Single-file protected endpoint to create a tenant in Firebase Realtime Database.
// POST { slug, name?, defaults?, createdBy? }
// Header: x-master-key: <MASTER_API_KEY>  OR Authorization: Bearer <MASTER_API_KEY>

const admin = require('firebase-admin');

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

// ---- Firebase init helper (robust for netlify envs) ----
let firebaseInitError = null;
function ensureFirebase() {
  if (firebaseInitError) return Promise.reject(firebaseInitError);
  try {
    if (admin.apps && admin.apps.length) {
      // already initialized
      const db = admin.database();
      return Promise.resolve({ admin, db });
    }

    // Prefer a single JSON env var FIREBASE_SERVICE_ACCOUNT (stringified JSON)
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      } catch (e) {
        // maybe the var contains literal \n in private_key fields — that's fine
        throw new Error('FIREBASE_SERVICE_ACCOUNT is present but not valid JSON.');
      }
    } else if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PROJECT_ID) {
      // Some deployments store private key with escaped newlines
      const pk = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
      serviceAccount = {
        private_key: pk,
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        project_id: process.env.FIREBASE_PROJECT_ID
      };
    } else {
      throw new Error('No Firebase credentials found. Set FIREBASE_SERVICE_ACCOUNT or FIREBASE_PRIVATE_KEY+FIREBASE_CLIENT_EMAIL+FIREBASE_PROJECT_ID env vars.');
    }

    const dbUrl = process.env.FIREBASE_DB_URL || '';
    if (!dbUrl) throw new Error('FIREBASE_DB_URL not configured.');

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: dbUrl
    });

    const db = admin.database();
    return Promise.resolve({ admin, db });
  } catch (e) {
    firebaseInitError = e;
    return Promise.reject(e);
  }
}

// ---- Handler ----
exports.handler = async function handler(event) {
  try {
    // OPTIONS / CORS quick reply
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization',
        'Access-Control-Allow-Methods': 'POST,OPTIONS'
      } };
    }

    // Basic request logging (helps debug in Netlify logs) - no secrets printed
    console.log('createBusiness: incoming', {
      method: event.httpMethod,
      headerKeys: event.headers ? Object.keys(event.headers).map(k => k.toLowerCase()) : []
    });

    if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'method_not_allowed', message: 'Only POST allowed' });

    // init firebase
    let db;
    try {
      const fb = await ensureFirebase();
      db = fb.db;
      console.log('createBusiness: firebase initialized');
    } catch (initErr) {
      console.error('createBusiness:init error', initErr && (initErr.stack || initErr.message || initErr));
      return jsonResponse(500, { error: 'firebase_init_failed', message: initErr.message || String(initErr) });
    }

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

    // Parse body
    let body = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch (e) {
      return jsonResponse(400, { error: 'invalid_json', message: 'Request body must be valid JSON' });
    }

    // slug / name
    let slug = normalizeSlug(body.slug || '');
    if (!slug && body.name) slug = normalizeSlug(body.name);
    if (!slug) return jsonResponse(400, { error: 'invalid_slug', message: 'slug is required' });

    const name = sanitizeName(body.name || slug);
    if (!name || name.length < 1) return jsonResponse(400, { error: 'invalid_name', message: 'name is required' });

    const defaults = body.defaults && typeof body.defaults === 'object' ? body.defaults : {};
    const createdBy = body.createdBy || 'admin';

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

    // Transaction to guarantee uniqueness
    let txRes;
    try {
      txRes = await ref.transaction(current => {
        if (current !== null) return; // abort if exists
        return tenant;
      }, undefined, false);
    } catch (e) {
      console.error('createBusiness:transaction failed', e && (e.stack || e.message || e));
      return jsonResponse(500, { error: 'db_transaction_failed', message: e && e.message ? e.message : String(e) });
    }

    if (!txRes.committed) {
      // Already exists: return existing info
      const snap = await ref.once('value');
      const existing = snap.val() || {};
      return jsonResponse(409, { error: 'slug_exists', slug, existing });
    }

    // Best-effort name index (non-blocking)
    (async () => {
      try {
        const nameKey = encodeURIComponent(name.toLowerCase().trim());
        await db.ref(`/businesses_by_name/${nameKey}`).set({ slug, createdAt: nowIso });
      } catch (e) {
        console.warn('createBusiness: name index set failed', e && (e.message || e));
      }
    })();

    return jsonResponse(200, { ok: true, slug, links: tenant.links, data: tenant });
  } catch (err) {
    console.error('createBusiness:unhandled error', err && (err.stack || err.message || err));
    return jsonResponse(500, { error: 'server_error', message: err && err.message ? err.message : String(err) });
  }
};

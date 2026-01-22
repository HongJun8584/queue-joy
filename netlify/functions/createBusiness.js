// netlify/functions/createBusiness.js
// Protected endpoint to provision a tenant in Realtime DB.
// POST { slug, name?, defaults?, createdBy? }
// Header: x-master-key: <MASTER_API_KEY> OR Authorization: Bearer <MASTER_API_KEY>

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

function safeHeaderKeys(headers = {}) {
  return Object.keys(headers || {}).map(k => k.toLowerCase());
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

/* ---------- Firebase lazy init (robust) ---------- */
let initialized = false;
let initError = null;

function tryParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function parseServiceAccountFromEnv() {
  const candidates = [
    'FIREBASE_SERVICE_ACCOUNT',
    'FIREBASE_SERVICE_ACCOUNT_BASE64',
    'FIREBASE_SA',
    'FIREBASE_SA_BASE64'
  ];

  for (const name of candidates) {
    const raw = process.env[name];
    if (!raw) continue;
    const trimmed = raw.trim();
    if (trimmed[0] === '{') {
      const parsed = tryParseJson(raw);
      if (parsed) return parsed;
    } else {
      try {
        const dec = Buffer.from(raw, 'base64').toString('utf8');
        const parsed = tryParseJson(dec);
        if (parsed) return parsed;
      } catch {}
    }
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    privateKey = privateKey.replace(/\\n/g, '\n');
    return {
      type: 'service_account',
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey
    };
  }

  return null;
}

async function ensureFirebase() {
  if (initialized && admin.apps && admin.apps.length) return { admin, db: admin.database() };
  if (initError) throw initError;

  try {
    const dbUrl =
      process.env.FIREBASE_DATABASE_URL ||
      process.env.FIREBASE_DB_URL ||
      process.env.FIREBASE_RTDB_URL;

    if (!dbUrl) throw new Error('FIREBASE_DB_URL (or FIREBASE_DATABASE_URL / FIREBASE_RTDB_URL) is not set.');

    const serviceAccount = parseServiceAccountFromEnv();
    if (!serviceAccount) throw new Error('Firebase service account not found. Provide FIREBASE_SERVICE_ACCOUNT (JSON) or FIREBASE_SERVICE_ACCOUNT_BASE64 or set FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.');

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: dbUrl
      });
    }

    initialized = true;
    return { admin, db: admin.database() };
  } catch (e) {
    initError = e instanceof Error ? e : new Error(String(e));
    throw initError;
  }
}

/* ---------- Handler ---------- */
exports.handler = async function handler(event) {
  try {
    // Quick preflight
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization',
        'Access-Control-Allow-Methods': 'POST,OPTIONS'
      } };
    }

    console.log('createBusiness: incoming', {
      method: event.httpMethod,
      headerKeys: safeHeaderKeys(event.headers),
      path: event.path || null
    });

    if (event.httpMethod !== 'POST') {
      return jsonResponse(405, { error: 'method_not_allowed', message: 'Only POST allowed' });
    }

    // Init Firebase (lazy)
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

    // Validate slug/name
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

    // Atomic creation via transaction to guarantee uniqueness
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

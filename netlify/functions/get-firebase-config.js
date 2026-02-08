// netlify/functions/get-firebase-config.js
// Node 18+ / Netlify functions (CommonJS export)

const fetch = globalThis.fetch || require('node-fetch');

function jsonResp(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

// Try parse service account from various env names (same helper used in other functions)
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
  // fallback: build from individual envs if present
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY || process.env.FIREBASE_PRIVATE_KEY_BASE64;
  if (projectId && clientEmail && privateKey) {
    try { privateKey = privateKey.replace(/\\n/g, '\n'); } catch (e) {}
    return { type: 'service_account', project_id: projectId, client_email: clientEmail, private_key: privateKey };
  }
  return null;
}

let adminInitialized = false;
let adminInitError = null;
async function ensureFirebaseAdmin() {
  // lazy-init firebase-admin if service account present
  if (adminInitialized) return require('firebase-admin');
  if (adminInitError) throw adminInitError;
  const sa = parseServiceAccountFromEnv();
  const dbUrl = (process.env.FIREBASE_DB_URL || process.env.FIREBASE_DATABASE_URL || '').replace(/\/$/, '');
  if (!sa || !dbUrl) {
    adminInitError = new Error('No service account or FIREBASE_DB_URL configured for admin SDK');
    throw adminInitError;
  }
  try {
    const admin = require('firebase-admin');
    if (!admin.apps || !admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(sa),
        databaseURL: dbUrl
      });
    }
    adminInitialized = true;
    return admin;
  } catch (e) {
    adminInitError = e instanceof Error ? e : new Error(String(e));
    throw adminInitError;
  }
}

function pickClientFirebaseConfig(candidate = {}) {
  // Only keep client-side safe fields; if absent, try envs
  const result = {};
  if (candidate.apiKey) result.apiKey = candidate.apiKey;
  if (candidate.authDomain) result.authDomain = candidate.authDomain;
  if (candidate.databaseURL) result.databaseURL = candidate.databaseURL;
  if (candidate.projectId) result.projectId = candidate.projectId;
  if (candidate.storageBucket) result.storageBucket = candidate.storageBucket;
  if (candidate.messagingSenderId) result.messagingSenderId = candidate.messagingSenderId;
  if (candidate.appId) result.appId = candidate.appId;
  // fallback: if databaseURL missing, use env FIREBASE_DB_URL
  if (!result.databaseURL && process.env.FIREBASE_DB_URL) result.databaseURL = process.env.FIREBASE_DB_URL.replace(/\/$/, '');
  return result;
}

exports.handler = async function handler(event) {
  try {
    if (event.httpMethod === 'OPTIONS') return jsonResp(200, '');
    // accept GET ?slug= or POST { slug: '...' }
    let slug = null;
    if (event.httpMethod === 'GET' || event.httpMethod === 'DELETE') {
      slug = (event.queryStringParameters && event.queryStringParameters.slug) ? String(event.queryStringParameters.slug).trim() : null;
    } else {
      try {
        const body = event.body ? JSON.parse(event.body) : {};
        slug = body && body.slug ? String(body.slug).trim() : slug;
      } catch (e) {
        // ignore parse error
      }
      // also accept query param for POST
      if (!slug && event.queryStringParameters && event.queryStringParameters.slug) slug = String(event.queryStringParameters.slug).trim();
    }
    if (!slug) return jsonResp(400, { ok: false, error: 'missing_slug', message: 'Provide ?slug=your-tenant or { "slug": "..." }' });

    // Normalize slug
    slug = slug.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '').replace(/-+/g, '-');

    // Try reading tenant record from RTDB via admin SDK if possible
    let tenant = null;
    try {
      const admin = await ensureFirebaseAdmin();
      const db = admin.database();
      const snap = await db.ref(`tenants/${slug}`).get();
      if (snap && snap.exists && snap.exists()) {
        tenant = snap.val();
      }
    } catch (e) {
      // admin init failed -> fallback to REST read
      console.warn('admin read failed (falling back to REST):', String(e && e.message ? e.message : e));
    }

    // If tenant still null, try RTDB REST read (requires DB URL in env and public/read allowed or token)
    if (!tenant) {
      const dbUrl = (process.env.FIREBASE_DB_URL || process.env.FIREBASE_DATABASE_URL || '').replace(/\/$/, '');
      if (!dbUrl) {
        // no way to read tenant
        return jsonResp(404, { ok: false, slug, error: 'tenant_not_found', message: 'Tenant not found and FIREBASE_DB_URL not configured' });
      }
      const url = `${dbUrl}/tenants/${encodeURIComponent(slug)}.json`;
      try {
        const r = await fetch(url);
        if (r.ok) {
          tenant = await r.json();
        } else {
          // not found -> null
          tenant = null;
        }
      } catch (err) {
        console.warn('rest read error', String(err && err.message ? err.message : err));
        tenant = null;
      }
    }

    if (!tenant) {
      // If tenant missing, return a helpful error and optionally a demo config pointing at env DB
      const demoClientCfg = pickClientFirebaseConfig({});
      return jsonResp(404, {
        ok: false,
        slug,
        error: 'tenant_not_found',
        message: `Tenant "${slug}" not found in RTDB.`,
        demoClientConfig: demoClientCfg // useful for developer debugging
      });
    }

    // Build client firebase config from tenant entry or fallback to env
    const tenantClientCfg = tenant.firebaseConfig || tenant.firebase || tenant.clientFirebase || {};
    const clientFirebaseConfig = pickClientFirebaseConfig(tenantClientCfg);

    // Prepare return payload but DO NOT include service-account or any secrets
    const response = {
      ok: true,
      slug,
      name: tenant.name || tenant.title || null,
      firebaseConfig: clientFirebaseConfig,
      settings: tenant.settings || tenant.defaults || {},
      links: tenant.links || null,
      meta: tenant.meta || null
    };

    return jsonResp(200, response);

  } catch (err) {
    console.error('get-firebase-config error', err && (err.stack || err.message || String(err)));
    return jsonResp(500, { ok: false, error: 'server_error', message: err && err.message ? err.message : String(err) });
  }
};

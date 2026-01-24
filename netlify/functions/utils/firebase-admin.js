// netlify/functions/utils/firebase-admin.js
// CommonJS helper that reads FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_SERVICE_ACCOUNT
// and initializes firebase-admin + RTDB. Exports ensureFirebase().

const admin = require('firebase-admin');

let initialized = false;
let initError = null;

function tryParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function parseServiceAccountFromEnv() {
  // Prefer the BASE64 env var, fall back to raw JSON env var or components
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT_BASE_64;
  if (b64) {
    try {
      const json = Buffer.from(b64, 'base64').toString('utf8');
      const parsed = tryParseJson(json);
      if (parsed) return parsed;
      throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 decoded but JSON.parse failed');
    } catch (e) {
      throw new Error('Failed to parse FIREBASE_SERVICE_ACCOUNT_BASE64: ' + String(e.message || e));
    }
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    const parsed = tryParseJson(raw);
    if (parsed) return parsed;
    throw new Error('FIREBASE_SERVICE_ACCOUNT set but not valid JSON');
  }

  // Last-resort: individual env pieces
  const projectId = process.env.FIREBASE_PROJECT_ID;
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

  throw new Error('No Firebase service account env found. Set FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_SERVICE_ACCOUNT or FIREBASE_PROJECT_ID+FIREBASE_CLIENT_EMAIL+FIREBASE_PRIVATE_KEY.');
}

function ensureDbUrl() {
  const url = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_RTDB_URL || process.env.FIREBASE_DB_URL;
  if (!url) throw new Error('FIREBASE_DATABASE_URL (or FIREBASE_RTDB_URL / FIREBASE_DB_URL) is not set.');
  return url;
}

async function ensureFirebase() {
  if (initialized && admin.apps && admin.apps.length) {
    return { admin, db: admin.database() };
  }
  if (initError) throw initError;

  try {
    const dbUrl = ensureDbUrl();
    const serviceAccount = parseServiceAccountFromEnv();

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

module.exports = { ensureFirebase };

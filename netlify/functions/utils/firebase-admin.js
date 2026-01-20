// netlify/functions/utils/firebase-admin.js
// Initialize Firebase Admin SDK using service account provided in env.
// Exports: admin, db (Realtime Database root)

const admin = require('firebase-admin');

let initialized = false;

function tryParseJson(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function parseServiceAccountFromEnv() {
  // Try full JSON env vars first (raw or base64)
  const candidates = [
    'FIREBASE_SERVICE_ACCOUNT',
    'FIREBASE_SERVICE_ACCOUNT_BASE64',
    'FIREBASE_SA',
    'FIREBASE_SA_BASE64'
  ];

  for (const name of candidates) {
    const raw = process.env[name];
    if (!raw) continue;
    // if it starts with '{' assume raw JSON
    if (raw.trim()[0] === '{') {
      const parsed = tryParseJson(raw);
      if (parsed) return parsed;
    } else {
      // try base64 decode then parse
      try {
        const dec = Buffer.from(raw, 'base64').toString('utf8');
        const parsed = tryParseJson(dec);
        if (parsed) return parsed;
      } catch (e) {
        // ignore
      }
    }
  }

  // Next: support constructing service account from discrete env vars
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    // Some platforms escape newlines; fix common patterns
    privateKey = privateKey.replace(/\\n/g, '\n');
    return {
      type: 'service_account',
      project_id: projectId,
      private_key: privateKey,
      client_email: clientEmail
    };
  }

  return null;
}

function init() {
  if (initialized) return;
  // Accept several DB env names for backwards compatibility
  const dbUrl = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL;
  if (!dbUrl) {
    throw new Error('FIREBASE_DATABASE_URL (or FIREBASE_DB_URL / FIREBASE_RTDB_URL) env var missing.');
  }

  const serviceAccount = parseServiceAccountFromEnv();
  if (!serviceAccount) {
    throw new Error('Firebase service account not found. Provide FIREBASE_SERVICE_ACCOUNT (JSON) or FIREBASE_SERVICE_ACCOUNT_BASE64 (base64 JSON) or set FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.');
  }

  // initialize
  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: dbUrl
      });
    }
  } catch (err) {
    // wrap to provide clearer hint
    throw new Error('Failed to initialize Firebase Admin SDK: ' + (err && err.message ? err.message : String(err)));
  }

  initialized = true;
}

init();

const db = admin.database();

module.exports = { admin, db };

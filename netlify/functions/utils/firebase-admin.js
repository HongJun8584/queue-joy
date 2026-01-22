// netlify/functions/utils/firebase-admin.js
// Robust lazy initializer for Firebase Admin SDK to use inside Netlify functions.
// Exports: ensureFirebase() -> Promise<{ admin, db }>
//
// Env options (choose one):
// 1) FIREBASE_SERVICE_ACCOUNT = full JSON string of service account
// 2) FIREBASE_SERVICE_ACCOUNT_BASE64 = base64(JSON)
// 3) FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
//    (PRIVATE_KEY may contain "\\n" which will be converted to real newlines)
// Also required: FIREBASE_DB_URL (Realtime DB URL; e.g. https://<proj>-default-rtdb.firebaseio.com)

const admin = require('firebase-admin');

let initialized = false;
let initError = null;

function tryParseJson(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
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
    // Raw JSON
    if (trimmed[0] === '{') {
      const parsed = tryParseJson(raw);
      if (parsed) return parsed;
      // Fallthrough if parse failed
    } else {
      // Try base64 decode then parse
      try {
        const dec = Buffer.from(raw, 'base64').toString('utf8');
        const parsed = tryParseJson(dec);
        if (parsed) return parsed;
      } catch (e) {
        // ignore and continue
      }
    }
  }

  // Fallback: discrete env vars (project + client_email + private_key)
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    // Replace escaped newlines with real newlines if necessary
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

/**
 * ensureFirebase - lazy initializes firebase-admin and returns { admin, db }
 * Throws helpful Error when misconfigured.
 */
async function ensureFirebase() {
  if (initialized && admin.apps && admin.apps.length) {
    return { admin, db: admin.database() };
  }
  if (initError) {
    // previous attempt failed — return same error for consistency
    throw initError;
  }

  try {
    const dbUrl =
      process.env.FIREBASE_DATABASE_URL ||
      process.env.FIREBASE_DB_URL ||
      process.env.FIREBASE_RTDB_URL;

    if (!dbUrl) {
      throw new Error('FIREBASE_DB_URL (or FIREBASE_DATABASE_URL / FIREBASE_RTDB_URL) is not set.');
    }

    const serviceAccount = parseServiceAccountFromEnv();
    if (!serviceAccount) {
      throw new Error(
        'Firebase service account not found. Provide FIREBASE_SERVICE_ACCOUNT (JSON) or FIREBASE_SERVICE_ACCOUNT_BASE64 (base64 JSON) OR set FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.'
      );
    }

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: dbUrl
      });
    }

    initialized = true;
    return { admin, db: admin.database() };
  } catch (e) {
    // cache the error so subsequent cold starts behave consistently
    initError = e instanceof Error ? e : new Error(String(e));
    throw initError;
  }
}

module.exports = { ensureFirebase };

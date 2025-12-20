// netlify/functions/utils/firebase-admin.js
// Initialize Firebase Admin SDK using a service account provided in env.
// Exports: db (Realtime Database root)

const admin = require('firebase-admin');

let initialized = false;

function parseServiceAccount() {
  // Accept either FIREBASE_SERVICE_ACCOUNT (raw JSON string) or
  // FIREBASE_SERVICE_ACCOUNT_BASE64 (base64-encoded JSON).
  let svcRaw = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!svcRaw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT (or FIREBASE_SERVICE_ACCOUNT_BASE64) env var missing.');
  }

  // If it looks base64-y (no "{" at start), try to decode it.
  try {
    if (typeof svcRaw === 'string' && svcRaw.trim().length > 0 && svcRaw.trim()[0] !== '{') {
      // assume base64
      svcRaw = Buffer.from(svcRaw, 'base64').toString('utf8');
    }
    return typeof svcRaw === 'string' ? JSON.parse(svcRaw) : svcRaw;
  } catch (err) {
    throw new Error('Failed parsing FIREBASE_SERVICE_ACCOUNT: ' + (err.message || String(err)));
  }
}

function init() {
  if (initialized) return;
  const dbUrl = process.env.FIREBASE_DATABASE_URL;
  if (!dbUrl) {
    throw new Error('FIREBASE_DATABASE_URL env var missing.');
  }

  const serviceAccount = parseServiceAccount();

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: dbUrl
  });

  initialized = true;
}

init();

const db = admin.database();

module.exports = { admin, db };

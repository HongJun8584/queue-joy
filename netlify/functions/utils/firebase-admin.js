// netlify/functions/utils/firebase-admin.js
// Initialize Firebase Admin SDK using a service account provided in env.
// Exports: db (Realtime Database root)

const admin = require('firebase-admin');

let initialized = false;

function init() {
  if (initialized) return;
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
  const dbUrl = process.env.FIREBASE_DATABASE_URL;
  if (!svc) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT env var missing (service account JSON string).');
  }
  const serviceAccount = typeof svc === 'string' ? JSON.parse(svc) : svc;
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: dbUrl
  });
  initialized = true;
}

init();

const db = admin.database();

module.exports = { admin, db };

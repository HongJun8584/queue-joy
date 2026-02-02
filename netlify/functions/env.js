// netlify/functions/env.js
exports.handler = async function handler() {
  const TENANT = process.env.TENANT_ID || ''; // Netlify site env set by createNetlifySite
  const FIREBASE_PATH = process.env.FIREBASE_PATH || (TENANT ? `tenants/${TENANT}` : '');
  const SITE_BASE = (process.env.SITE_BASE || '').replace(/\/$/, '');

  // Optionally include FIREBASE_CONFIG if you injected it as stringified JSON
  const FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || '';

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-store, max-age=0",
      "Access-Control-Allow-Origin": "*"
    },
    body: `
      window.__ENV__ = {
        TENANT_ID: ${JSON.stringify(TENANT)},
        FIREBASE_PATH: ${JSON.stringify(FIREBASE_PATH)},
        SITE_BASE: ${JSON.stringify(SITE_BASE)},
        FIREBASE_CONFIG: ${JSON.stringify(FIREBASE_CONFIG)}
      };
    `
  };
};

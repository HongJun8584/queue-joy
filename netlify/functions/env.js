// netlify/functions/env.js
// Returns JS that sets window.__ENV for tenant sites.
// Must return valid JS (not HTML). Content-Type = application/javascript

exports.handler = async function handler() {
  // Read Netlify site envs (these are set in Site settings -> Environment)
  const TENANT = process.env.TENANT_ID || '';
  const FIREBASE_PATH = process.env.FIREBASE_PATH || (TENANT ? `tenants/${TENANT}` : '');
  const SITE_BASE = (process.env.SITE_BASE || '').replace(/\/$/, '');
  const FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || ''; // optional stringified JSON

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "no-store, max-age=0",
      "Access-Control-Allow-Origin": "*"
    },
    body: `
      // runtime env injected by Netlify function
      window.__ENV__ = {
        TENANT_ID: ${JSON.stringify(TENANT)},
        FIREBASE_PATH: ${JSON.stringify(FIREBASE_PATH)},
        SITE_BASE: ${JSON.stringify(SITE_BASE)},
        FIREBASE_CONFIG: ${JSON.stringify(FIREBASE_CONFIG)}
      };
    `
  };
};

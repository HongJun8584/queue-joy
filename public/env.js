// public/env.js
// Lightweight runtime env for QueueJoy template.
// Place in the repo as a default/demo env.
// Your provisioning script or Netlify function can overwrite this file or provide /.netlify/functions/env.js
(function () {
  // helpers
  function isPlaceholder(v) {
    return typeof v === 'string' && v.indexOf('%%') !== -1;
  }
  function safeJSONParse(s) {
    try { return JSON.parse(s); } catch { return null; }
  }
  // Query overrides (for quick preview): ?tenant=demo-cafe or ?demo=true
  var qp = (function () { try { return new URL(location).searchParams; } catch { return new URLSearchParams(); } })();
  var qTenant = qp.get('tenant') || qp.get('slug') || null;
  var demoForced = qp.get('demo') === 'true' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  // Build-time placeholders -- your provisioning should replace these strings.
  // Example: replace %%TENANT_ID%% -> demo-cafe, %%FIREBASE_PATH%% -> tenants/demo-cafe
  var PLACEHOLDER_TENANT = '%%TENANT_ID%%';
  var PLACEHOLDER_FIREBASE_PATH = '%%FIREBASE_PATH%%';
  var PLACEHOLDER_SITE_BASE = '%%SITE_BASE%%';
  var PLACEHOLDER_FIREBASE_CONFIG = '%%FIREBASE_CONFIG%%'; // optional: should be stringified JSON

  // Decide final values: placeholders are ignored unless replaced by provisioning.
  var tenantId = null;
  var firebasePath = null;
  var siteBase = null;
  var firebaseConfigObj = null;

  if (!isPlaceholder(PLACEHOLDER_TENANT) && PLACEHOLDER_TENANT) tenantId = String(PLACEHOLDER_TENANT).trim();
  if (!isPlaceholder(PLACEHOLDER_FIREBASE_PATH) && PLACEHOLDER_FIREBASE_PATH) firebasePath = String(PLACEHOLDER_FIREBASE_PATH).trim();
  if (!isPlaceholder(PLACEHOLDER_SITE_BASE) && PLACEHOLDER_SITE_BASE) siteBase = String(PLACEHOLDER_SITE_BASE).trim();
  if (!isPlaceholder(PLACEHOLDER_FIREBASE_CONFIG) && PLACEHOLDER_FIREBASE_CONFIG) {
    firebaseConfigObj = safeJSONParse(PLACEHOLDER_FIREBASE_CONFIG) || null;
  }

  // Allow query param override (quick dev/demo)
  if (qTenant) tenantId = tenantId || String(qTenant).trim();
  if (qp.get('firebasePath')) firebasePath = firebasePath || String(qp.get('firebasePath')).trim();

  // Demo fallback
  if (!tenantId && demoForced) tenantId = 'demo';
  if (!firebasePath && tenantId) firebasePath = 'tenants/' + tenantId;
  if (!siteBase) siteBase = location.origin;

  // Demo firebase config (safe public demo). Replace with your project's client config for production.
  var demoFirebaseConfig = {
    apiKey: "AIzaSyDiRGvkQbnLlpnJT3fEEQrY1A3nwLVIFY0",
    authDomain: "queue-joy-aa21b.firebaseapp.com",
    databaseURL: "https://queue-joy-aa21b-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "queue-joy-aa21b",
    storageBucket: "queue-joy-aa21b.appspot.com",
    messagingSenderId: "950240394209",
    appId: "1:950240394209:web:78d4f2471d2d89ac91f0a0"
  };

  // Finalize firebase config (priority: injected object > placeholder-parsed > demo)
  if (!firebaseConfigObj) {
    // if PLACEHOLDER_FIREBASE_CONFIG contained JSON string (and was replaced at build), parse it:
    if (!isPlaceholder(PLACEHOLDER_FIREBASE_CONFIG) && typeof PLACEHOLDER_FIREBASE_CONFIG === 'string' && PLACEHOLDER_FIREBASE_CONFIG.trim()) {
      firebaseConfigObj = safeJSONParse(PLACEHOLDER_FIREBASE_CONFIG) || null;
    }
  }
  if (!firebaseConfigObj && demoForced) firebaseConfigObj = demoFirebaseConfig;

  // Compose env
  var env = {
    TENANT_ID: tenantId || '',
    FIREBASE_PATH: firebasePath || '',
    SITE_BASE: siteBase || '',
    // FIREBASE_CONFIG: either an object (preferred) or a JSON-string (older code expects string)
    FIREBASE_CONFIG: firebaseConfigObj ? firebaseConfigObj : '',
    // Meta so code can detect that this is a local/demo fallback
    _IS_TEMPLATE_FALLBACK: !!(demoForced && (!tenantId || tenantId === 'demo'))
  };

  // Do not overwrite if some server-side env injector already set window.__ENV__ (serverless function can override)
  if (typeof window !== 'undefined') {
    if (!window.__ENV__ || typeof window.__ENV__ !== 'object' || window.__ENV__._FROM_SERVER !== true) {
      // Merge cautiously: server-side env takes precedence, but here we only set defaults when missing
      window.__ENV__ = Object.assign({}, env, window.__ENV__ || {});
    }
  }
})();

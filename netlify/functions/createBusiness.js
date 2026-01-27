// netlify/functions/createBusiness.js
// POST { slug?, name?, templatePath? (optional), defaults? / settings?, counters? }
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

/* ---------- Firebase lazy init ---------- */
let initialized = false;
let initError = null;

async function ensureFirebase() {
  if (initialized && admin.apps && admin.apps.length) return { admin, db: admin.database() };
  if (initError) throw initError;

  try {
    const dbUrl =
      process.env.FIREBASE_DATABASE_URL ||
      process.env.FIREBASE_DB_URL ||
      process.env.FIREBASE_RTDB_URL;

    if (!dbUrl) throw new Error('FIREBASE_DB_URL is not set.');

    const serviceAccount = parseServiceAccountFromEnv();
    if (!serviceAccount) throw new Error('Firebase service account not found.');

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

function normalizeSlug(raw = '') {
  return (raw || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function sanitizeName(n) {
  return (n || '').toString().trim();
}

async function fetchTemplateNodes(db, templatePath, copyPaths = []) {
  const out = {};
  for (const p of copyPaths) {
    const snap = await db.ref(`${templatePath}/${p}`).once('value');
    out[p] = snap.exists() ? snap.val() : null;
  }
  return out;
}

function ensureCounterShape(counterObj, defaultPrefix) {
  // Normalize counters object entries so they have active/lastIssued/nowServing/prefix/name
  const out = {};
  for (const k of Object.keys(counterObj || {})) {
    const c = counterObj[k] || {};
    out[k] = {
      name: c.name || c.title || 'Counter 1',
      prefix: (c.prefix || c.p || defaultPrefix || 'Q').toString(),
      active: (typeof c.active === 'boolean') ? c.active : true,
      lastIssued: typeof c.lastIssued === 'number' ? c.lastIssued : (typeof c.value === 'number' ? c.value : 0),
      nowServing: typeof c.nowServing === 'number' ? c.nowServing : 0
    };
  }
  return out;
}

/* ---------- Handler ---------- */
exports.handler = async function handler(event) {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization',
        'Access-Control-Allow-Methods': 'POST,OPTIONS'
      } };
    }

    if (event.httpMethod !== 'POST') {
      return jsonResponse(405, { error: 'method_not_allowed', message: 'Only POST allowed' });
    }

    // init firebase
    let db;
    try {
      const fb = await ensureFirebase();
      db = fb.db;
    } catch (initErr) {
      console.error('init failed', initErr && (initErr.stack || initErr.message || initErr));
      return jsonResponse(500, { error: 'firebase_init_failed', message: initErr.message || String(initErr) });
    }

    // auth
    const lowHeaders = {};
    for (const k of Object.keys(event.headers || {})) lowHeaders[k.toLowerCase()] = event.headers[k];
    const master = process.env.MASTER_API_KEY || process.env.MASTER_KEY || '';
    if (!master) {
      console.error('MASTER key missing server-side');
      return jsonResponse(500, { error: 'server_misconfigured', message: 'MASTER_API_KEY not configured on server' });
    }

    let got = (lowHeaders['x-master-key'] || lowHeaders['x-api-key'] || lowHeaders['authorization'] || '').toString();
    if (!got) return jsonResponse(403, { error: 'unauthorized', message: 'missing master key' });
    if (got.startsWith('Bearer ')) got = got.slice(7);
    if (got !== master) return jsonResponse(403, { error: 'unauthorized', message: 'invalid master key' });

    // parse body
    let body = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch (e) {
      return jsonResponse(400, { error: 'invalid_json', message: 'Request body must be valid JSON' });
    }

    // slug & name
    let slug = normalizeSlug(body.slug || '');
    if (!slug && body.name) slug = normalizeSlug(body.name);
    if (!slug) return jsonResponse(400, { error: 'invalid_slug', message: 'slug is required' });

    const name = sanitizeName(body.name || slug);
    if (!name) return jsonResponse(400, { error: 'invalid_name', message: 'name is required' });

    const createdBy = body.createdBy || 'admin';
    const nowIso = new Date().toISOString();

    // accept settings from body.settings or body.defaults (backwards compat)
    let providedSettings = {};
    if (body.settings && typeof body.settings === 'object') providedSettings = body.settings;
    else if (body.defaults && typeof body.defaults === 'object') {
      // body.defaults may be either a settings object or contain .settings
      providedSettings = body.defaults.settings && typeof body.defaults.settings === 'object'
        ? body.defaults.settings
        : body.defaults;
    }

    const providedCounters = (body.counters && typeof body.counters === 'object') ? body.counters : (providedSettings.counters && typeof providedSettings.counters === 'object' ? providedSettings.counters : null);

    // minimal business object (keeps old shape but with extended settings)
    const defaultPrefix = (providedSettings.defaultPrefix || providedSettings.prefix || 'Q').toString();
    const siteBase = (process.env.SITE_BASE || '').replace(/\/$/, '');

    const tenantMinimal = {
      slug,
      name,
      createdBy,
      createdAt: nowIso,
      status: 'active',
      billing: { provider: (body.billing && body.billing.provider) || 'stripe', createdAt: nowIso },
      // sensible default settings (include the keys your SPA expects)
      settings: Object.assign({
        name,
        mainTitle: providedSettings.mainTitle || providedSettings.title || '',
        smallTextOnTop: providedSettings.smallTextOnTop || providedSettings.smallTop || '',
        introText: providedSettings.introText || providedSettings.welcomeMessage || '',
        titleinmiddle: providedSettings.titleinmiddle || providedSettings.titleInMiddle || '',
        ctaText: providedSettings.ctaText || providedSettings.cta || 'Get your queue number',
        adText: providedSettings.adText || '',
        adImage: providedSettings.adImage || '',
        adLink: providedSettings.adLink || '',
        logo: providedSettings.logo || '',
        logoUrl: providedSettings.logoUrl || providedSettings.logo || '',
        chatId: providedSettings.chatId || '',
        timezone: providedSettings.timezone || 'Asia/Kuala_Lumpur',
        defaultPrefix: defaultPrefix,
        hashtags: providedSettings.hashtags || providedSettings.tags || ''
      }, providedSettings || {}),
      links: {
        home: `${siteBase}/${slug}`,
        counter: `${siteBase}/${slug}/counter.html`,
        admin: `${siteBase}/${slug}/admin.html`
      },
      // initial counters (if provided) else single sane default
      counters: providedCounters ? ensureCounterShape(providedCounters, defaultPrefix) : {
        default: { name: 'Counter 1', prefix: defaultPrefix, active: true, lastIssued: 0, nowServing: 0 }
      }
    };

    const businessRef = db.ref(`businesses/${slug}`);

    // ensure uniqueness (atomic)
    let txRes;
    try {
      txRes = await businessRef.transaction(current => {
        if (current !== null) return; // abort if exists
        return tenantMinimal;
      }, undefined, false);
    } catch (e) {
      console.error('transaction failed', e && (e.stack || e.message || e));
      return jsonResponse(500, { error: 'db_transaction_failed', message: e && e.message ? e.message : String(e) });
    }

    if (!txRes.committed) {
      const snap = await businessRef.once('value');
      const existing = snap.val() || {};
      return jsonResponse(409, { error: 'slug_exists', slug, existing });
    }

    // fetch template nodes (if any)
    const templatePath = body.templatePath || 'templates/default';
    const copyNodes = [
      'settings',
      'links',
      'counters',
      'queue',
      'queueSubscriptions',
      'subscribers',
      'analytics',
      'announcement',
      'system',
      'telegramPending',
      'telegramTokens',
      'adPanel'
    ];

    let templateValues = {};
    try {
      templateValues = await fetchTemplateNodes(db, templatePath, copyNodes);
    } catch (e) {
      console.warn('failed to read template nodes', e && e.message);
    }

    // build tenant namespace with merging rules:
    // prefer template values as base, but let tenantMinimal (which includes providedSettings) override template
    const tenantPath = `tenants/${slug}`;
    const tenantScoped = {};

    tenantScoped.settings = Object.assign(
      {},
      templateValues.settings || {},
      tenantMinimal.settings // tenantMinimal.settings already contains providedSettings merged above
    );

    tenantScoped.links = Object.assign({}, templateValues.links || {}, tenantMinimal.links);

    // counters: allow provided counters to override template; tenantMinimal.counters already holds providedDefaults
    tenantScoped.counters = Object.keys(templateValues.counters || {}).length
      ? Object.assign({}, templateValues.counters, tenantMinimal.counters)
      : tenantMinimal.counters;

    // normalize counters shape
    tenantScoped.counters = ensureCounterShape(tenantScoped.counters, tenantScoped.settings.defaultPrefix || defaultPrefix);

    tenantScoped.queue = templateValues.queue || {};
    tenantScoped.queueSubscriptions = templateValues.queueSubscriptions || {};
    tenantScoped.subscribers = templateValues.subscribers || {};
    tenantScoped.analytics = templateValues.analytics || { events: {} };
    tenantScoped.announcement = templateValues.announcement || { message: '', active: false };
    tenantScoped.system = templateValues.system || { lastAssignedCounterIndex: 0, lastQueueNumber: 0 };
    tenantScoped.telegramPending = templateValues.telegramPending || {};
    tenantScoped.telegramTokens = templateValues.telegramTokens || {};
    tenantScoped.adPanel = templateValues.adPanel || {};
    tenantScoped.slug = slug;
    tenantScoped.name = name;
    tenantScoped.createdAt = nowIso;
    tenantScoped.createdBy = createdBy;
    tenantScoped.status = 'active';

    // multipath update: write tenant namespace and index entry
    const updates = {};
    updates[tenantPath] = tenantScoped;
    const nameKey = encodeURIComponent(name.toLowerCase().trim());
    updates[`businesses_by_name/${nameKey}`] = { slug, createdAt: nowIso };

    try {
      await db.ref().update(updates);
    } catch (e) {
      console.error('post-create update failed', e && (e.stack || e.message || e));
      // rollback businesses/<slug> created earlier
      try { await businessRef.remove(); } catch (remErr) { console.error('rollback failed', remErr && remErr.message); }
      return jsonResponse(500, { error: 'post_create_failed', message: 'Failed to write tenant namespace' });
    }

    const summary = {
      ok: true,
      slug,
      tenantPath,
      links: tenantScoped.links,
      createdAt: nowIso,
      copied: copyNodes.reduce((acc, k) => { acc[k] = !!templateValues[k]; return acc; }, {}),
      settings: tenantScoped.settings,
      counters: tenantScoped.counters
    };

    return jsonResponse(200, summary);

  } catch (err) {
    console.error('unhandled error', err && (err.stack || err.message || err));
    return jsonResponse(500, { error: 'server_error', message: err && err.message ? err.message : String(err) });
  }
};

// netlify/functions/createBusiness.js
// POST { slug?, name?, templatePath? (optional), defaults? / settings?, counters? }
// Header: x-master-key: <MASTER_API_KEY> OR Authorization: Bearer <MASTER_API_KEY>

// IMPORTANT: ensure Node runtime supports global fetch (Node 18+). Netlify functions on modern runtimes expose fetch.

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

/* ---------- Helper: GitHub copy (template -> slug folder) ---------- */
/*
  This routine uses GitHub Contents API:
  - Reads files under TEMPLATE_PATH_IN_REPO (recursively)
  - Creates the same files under TARGET_BASE_PATH (i.e. "<slug>/...") by PUTting /repos/:owner/:repo/contents/:path
  Requirements:
    - GITHUB_TOKEN with repo:contents write access (repo scope)
    - GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH (branch to commit to)
    - TEMPLATE_PATH_IN_REPO (e.g. "template")
    - TARGET_BASE_PATH optional (defaults to slug)
  NOTE: This implementation is intentionally simple and creates/overwrites individual files.
  For large template trees or high-frequency creates, consider using a CI workflow or Netlify deploy API instead.
*/

async function githubApiFetch(path, method = 'GET', body = null, token) {
  const url = `https://api.github.com${path}`;
  const opts = { method, headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'queuejoy-createbusiness' } };
  if (token) opts.headers['Authorization'] = `token ${token}`;
  if (body) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { text }; }
  return { ok: res.ok, status: res.status, body: json };
}

// recursively list files in repo path -> returns array of { path, type, sha, content(base64) if file }
async function listRepoFilesRecursive(owner, repo, path, branch, token) {
  const out = [];

  async function walk(p) {
    const apiPath = `/repos/${owner}/${repo}/contents/${encodeURIComponent(p)}?ref=${encodeURIComponent(branch)}`;
    const r = await githubApiFetch(apiPath, 'GET', null, token);
    if (!r.ok) {
      // If path missing, just return empty
      return;
    }
    const items = r.body;
    if (!Array.isArray(items)) {
      // it's a file
      if (items && items.type === 'file') {
        out.push({ path: items.path, sha: items.sha, content: items.content, encoding: items.encoding || null });
      }
      return;
    }
    for (const it of items) {
      if (it.type === 'file') {
        out.push({ path: it.path, sha: it.sha, size: it.size });
      } else if (it.type === 'dir') {
        await walk(it.path);
      } else {
        // ignore submodules etc
      }
    }
  }

  await walk(path);
  // fetch content for each file (we need base64 content for PUT)
  for (const f of out) {
    const r = await githubApiFetch(`/repos/${owner}/${repo}/contents/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(branch)}`, 'GET', null, token);
    if (r.ok && r.body && r.body.content) {
      f.content = r.body.content; // base64
      f.encoding = r.body.encoding;
    } else {
      f.content = null;
      f.encoding = null;
    }
  }
  return out;
}

async function deployTenantToRepo(slug, options = {}) {
  const {
    GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH = 'main',
    TEMPLATE_PATH_IN_REPO = 'template', TARGET_BASE_PATH = slug, COMMITTER = null
  } = options;

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    throw new Error('Missing GitHub deployment env (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO)');
  }

  // Step 1: list template files recursively
  const templatePath = TEMPLATE_PATH_IN_REPO.replace(/^\/+|\/+$/g, '') || 'template';
  const files = await listRepoFilesRecursive(GITHUB_OWNER, GITHUB_REPO, templatePath, GITHUB_BRANCH, GITHUB_TOKEN);
  if (!files || files.length === 0) {
    throw new Error(`Template path "${templatePath}" is empty or not found in repo`);
  }

  // Step 2: create/overwrite files under TARGET_BASE_PATH/<relative>
  // For each file path: source: templatePath/some/path -> targetPath: TARGET_BASE_PATH/some/path
  const created = [];
  for (const f of files) {
    // compute relative path
    if (!f.path || !f.content) continue;
    let rel = f.path.replace(new RegExp(`^${templatePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`), '');
    if (rel.startsWith('/')) rel = rel.slice(1);
    const targetPath = `${TARGET_BASE_PATH}/${rel}`;

    // Prepare payload for PUT /repos/:owner/:repo/contents/:path
    const message = `Create tenant ${slug} - add ${targetPath}`;
    const payload = {
      message,
      content: f.content.replace(/\n/g,''), // keep base64; github accepts base64 content
      branch: GITHUB_BRANCH
    };
    if (COMMITTER && COMMITTER.name && COMMITTER.email) payload.committer = { name: COMMITTER.name, email: COMMITTER.email };

    // PUT to create file (if exists, GitHub requires sha to update; we try create first and fall back to update)
    const apiPathCreate = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(targetPath)}`;
    let r = await githubApiFetch(apiPathCreate, 'PUT', payload, GITHUB_TOKEN);

    if (!r.ok && (r.status === 422 || (r.body && r.body.message && /exists/i.test(r.body.message)))) {
      // file exists: need to GET current sha and re-PUT with sha
      const getRes = await githubApiFetch(`${apiPathCreate}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, 'GET', null, GITHUB_TOKEN);
      if (getRes.ok && getRes.body && getRes.body.sha) {
        payload.sha = getRes.body.sha;
        r = await githubApiFetch(apiPathCreate, 'PUT', payload, GITHUB_TOKEN);
      }
    }

    if (!r.ok) {
      // log and continue (we don't abort whole deploy for one file)
      created.push({ path: targetPath, ok: false, status: r.status, body: r.body });
    } else {
      created.push({ path: targetPath, ok: true, url: r.body && r.body.content && r.body.content.html_url ? r.body.content.html_url : null });
    }
  }

  return created;
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
      counters: providedCounters ? ensureCounterShape(providedCounters, defaultPrefix) : {
        default: { name: 'Counter 1', prefix: defaultPrefix, active: true, lastIssued: 0, nowServing: 0 }
      }
    };

    const businessRef = db.ref(`businesses/${slug}`);

    // ensure uniqueness (atomic)
    let txRes;
    try {
      txRes = await businessRef.transaction(current => {
        if (current !== null) return;
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

    // fetch template nodes (if any) and build tenantScoped as before
    const templatePath = body.templatePath || 'templates/default';
    const copyNodes = [
      'settings','links','counters','queue','queueSubscriptions','subscribers','analytics','announcement','system','telegramPending','telegramTokens','adPanel'
    ];
    let templateValues = {};
    try {
      templateValues = await fetchTemplateNodes(db, templatePath, copyNodes);
    } catch (e) {
      console.warn('failed to read template nodes', e && e.message);
    }

    const tenantPath = `tenants/${slug}`;
    const tenantScoped = {};

    tenantScoped.settings = Object.assign({}, templateValues.settings || {}, tenantMinimal.settings);
    tenantScoped.links = Object.assign({}, templateValues.links || {}, tenantMinimal.links);
    tenantScoped.counters = Object.keys(templateValues.counters || {}).length
      ? Object.assign({}, templateValues.counters, tenantMinimal.counters)
      : tenantMinimal.counters;
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
      try { await businessRef.remove(); } catch (remErr) { console.error('rollback failed', remErr && remErr.message); }
      return jsonResponse(500, { error: 'post_create_failed', message: 'Failed to write tenant namespace' });
    }

    // ------------------ Optional: create tenant folder in GitHub repo (Netlify will serve it) ------------------
    // Enable by setting ENABLE_REPO_DEPLOY=true and providing GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO env vars.
    const repoDeployEnabled = String(process.env.ENABLE_REPO_DEPLOY || 'false').toLowerCase() === 'true';
    let repoResult = null;

    if (repoDeployEnabled) {
      try {
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
        const GITHUB_OWNER = process.env.GITHUB_OWNER;
        const GITHUB_REPO = process.env.GITHUB_REPO;
        const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
        const TEMPLATE_PATH_IN_REPO = (process.env.TEMPLATE_PATH_IN_REPO || 'template').replace(/^\/+|\/+$/g, '');
        const TARGET_BASE_PATH = slug; // create files at <slug>/...
        const COMMITTER = (process.env.GITHUB_COMMITTERNAME && process.env.GITHUB_COMMITTEREMAIL) ? { name: process.env.GITHUB_COMMITTERNAME, email: process.env.GITHUB_COMMITTEREMAIL } : null;

        repoResult = await deployTenantToRepo(slug, {
          GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, TEMPLATE_PATH_IN_REPO, TARGET_BASE_PATH, COMMITTER
        });
      } catch (e) {
        // Do NOT roll back Firebase on deploy failure — you still created tenant data.
        console.error('repo deploy failed', e && (e.stack || e.message || e));
        repoResult = { error: true, message: e && e.message ? e.message : String(e) };
      }
    }

    const summary = {
      ok: true,
      slug,
      tenantPath,
      links: tenantScoped.links,
      createdAt: nowIso,
      copied: copyNodes.reduce((acc, k) => { acc[k] = !!templateValues[k]; return acc; }, {}),
      settings: tenantScoped.settings,
      counters: tenantScoped.counters,
      repoDeploy: repoResult
    };

    return jsonResponse(200, summary);

  } catch (err) {
    console.error('unhandled error', err && (err.stack || err.message || err));
    return jsonResponse(500, { error: 'server_error', message: err && err.message ? err.message : String(err) });
  }
};

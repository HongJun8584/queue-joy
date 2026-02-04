// tenant-template/functions/createNetlifySite.js
// Node 18+ runtime (global fetch available)

function tryParseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
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

exports.handler = async function handler(event) {
  try {
    // CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      return jsonResp(204, '');
    }
    if (event.httpMethod !== 'POST') {
      return jsonResp(405, { error: 'method_not_allowed', message: 'Only POST allowed' });
    }

    // normalize headers lowercase
    const headers = {};
    for (const k of Object.keys(event.headers || {})) headers[k.toLowerCase()] = event.headers[k];

    // master key auth
    const MASTER = process.env.MASTER_API_KEY || process.env.MASTER_KEY;
    if (!MASTER) return jsonResp(500, { error: 'server_misconfigured', message: 'MASTER_API_KEY missing on function' });

    let got = (headers['x-master-key'] || headers['authorization'] || '').toString();
    if (!got) return jsonResp(403, { error: 'unauthorized', message: 'missing master key' });
    if (got.startsWith('Bearer ')) got = got.slice(7);
    if (got !== MASTER) return jsonResp(403, { error: 'unauthorized', message: 'invalid master key' });

    // parse JSON body
    let body = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch (e) { return jsonResp(400, { error: 'invalid_json', message: 'Request body must be JSON' }); }

    // tenant slug required
    const slugRaw = body.slug || body.tenantId || body.name || '';
    const slug = normalizeSlug(slugRaw);
    if (!slug) return jsonResp(400, { error: 'invalid_request', message: 'slug (tenant id) required' });

    // repo info: prefer body, fallback to env
    const repoOwner = body.repoOwner || process.env.GITHUB_OWNER;
    const repoName = body.repoName || process.env.GITHUB_REPO;
    const branch = body.branch || process.env.GITHUB_BRANCH || 'main';
    if (!repoOwner || !repoName) {
      return jsonResp(400, { error: 'missing_repo_info', message: 'GITHUB_OWNER and GITHUB_REPO must be set in env or passed in body' });
    }

    // Netlify token required
    const NETLIFY_TOKEN = process.env.NETLIFY_AUTH_TOKEN || body.netlifyToken;
    if (!NETLIFY_TOKEN) return jsonResp(500, { error: 'server_misconfigured', message: 'NETLIFY_AUTH_TOKEN missing on server or body.netlifyToken not provided' });

    // Build environment for the new site (merge defaults with body.env)
    const defaultEnv = {
      TENANT_ID: slug,
      FIREBASE_PATH: `tenants/${slug}`,
      SITE_BASE: (process.env.SITE_BASE || '').replace(/\/$/, '') || ''
    };

    // Allow passing firebase config object or string in body.firebaseConfig
    if (body.firebaseConfig) {
      defaultEnv.FIREBASE_CONFIG = typeof body.firebaseConfig === 'string' ? body.firebaseConfig : JSON.stringify(body.firebaseConfig);
    } else if (process.env.FIREBASE_CONFIG) {
      defaultEnv.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG;
    } else if (process.env.FIREBASE_DATABASE_URL) {
      // lightweight fallback to .env DB url (not full config)
      defaultEnv.FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL;
    }

    // Merge any additional env from body.env (body.env overrides defaults)
    const customEnv = (body.env && typeof body.env === 'object') ? body.env : {};
    const buildEnv = Object.assign({}, defaultEnv, customEnv);

    // Site naming
    const siteName = body.siteName || `${slug}-${Math.random().toString(36).slice(2,8)}`; // unique-ish

    // Construct Netlify create payload
    const payload = {
      name: siteName,
      repo: {
        provider: 'github',
        owner: repoOwner,
        repo: repoName,
        branch
      },
      build_settings: {
        env: buildEnv
      }
    };

    // Create site via Netlify API
    const netlifyRes = await fetch('https://api.netlify.com/api/v1/sites', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NETLIFY_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const text = await netlifyRes.text();
    let netlifyBody = tryParseJson(text) || { raw: text };

    if (!netlifyRes.ok) {
      console.error('[createNetlifySite] netlify create failed', netlifyRes.status, netlifyBody);
      return jsonResp(502, { error: 'netlify_create_failed', status: netlifyRes.status, body: netlifyBody });
    }

    // success response
    const result = {
      ok: true,
      site: {
        id: netlifyBody.id || null,
        name: netlifyBody.name || siteName,
        url: netlifyBody.ssl_url || netlifyBody.url || null,
        admin_url: netlifyBody.admin_url || `https://app.netlify.com/sites/${netlifyBody.name || siteName}`
      },
      tenant: { slug },
      build_env: buildEnv,
      raw: netlifyBody
    };

    return jsonResp(200, result);
  } catch (err) {
    console.error('[createNetlifySite] unhandled error', err && (err.stack || err.message || String(err)));
    return jsonResp(500, { error: 'server_error', message: err && err.message ? err.message : String(err) });
  }

  // helper for consistent JSON + CORS responses
  function jsonResp(status, body) {
    return {
      statusCode: status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,x-master-key,authorization',
        'Access-Control-Allow-Methods': 'POST,OPTIONS'
      },
      body: typeof body === 'string' ? JSON.stringify({ message: body }) : JSON.stringify(body)
    };
  }
};

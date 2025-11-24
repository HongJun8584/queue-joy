// netlify/functions/notifyCounter.js
// Notifier: polite notifications for (a) the called number (served) and (b) the number immediately before it (next).
// Envs:
//  - BOT_TOKEN (required)
//  - PROMO_URL (optional) - defaults to https://helloqueuejoy.netlify.app
//  - REDIS_URL (optional)
//  - FIREBASE_DB_URL (optional)
//
// POST JSON body example:
// {
//   "calledFull": "VANILLA002",
//   "counterName": "COUNTER ICE CREAM VANILLA",
//   "recipients": [
//     { "chatId": "123456", "theirNumber": "VANILLA002", "ticketId": "t-abc", "createdAt": "2025-11-19T14:00:00Z" }
//   ]
// }

const fs = require('fs');
const TMP_STORE = '/tmp/queuejoy_store.json';

const BOT_TOKEN = process.env.BOT_TOKEN || null;
const PROMO_URL = (process.env.PROMO_URL && String(process.env.PROMO_URL).trim()) || 'https://helloqueuejoy.netlify.app/?utm_source=telegram&utm_campaign=notifyCounter&utm_medium=telegram';
const REDIS_URL = process.env.REDIS_URL || null;
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || null;

let RedisClient = null;
let useRedis = false;
if (REDIS_URL) {
  try {
    const IORedis = require('ioredis');
    RedisClient = new IORedis(REDIS_URL);
    useRedis = true;
  } catch (e) {
    console.warn('ioredis failed — falling back to /tmp storage.', e.message);
    useRedis = false;
    RedisClient = null;
  }
}

// ---------------- Persistence helpers ----------------
async function loadStore() {
  if (useRedis) return null;
  try {
    if (fs.existsSync(TMP_STORE)) {
      const raw = fs.readFileSync(TMP_STORE, 'utf8');
      return JSON.parse(raw || '{"tickets":{},"stats":{}}');
    }
  } catch (e) { console.warn('loadStore error', e.message); }
  return { tickets: {}, stats: {} };
}
async function saveStore(obj) {
  if (useRedis) return;
  try {
    fs.writeFileSync(TMP_STORE, JSON.stringify(obj), 'utf8');
  } catch (e) { console.warn('saveStore error', e.message); }
}
async function redisGet(key) { if (!RedisClient) return null; const v = await RedisClient.get(key); return v ? JSON.parse(v) : null; }
async function redisSet(key, val) { if (!RedisClient) return; await RedisClient.set(key, JSON.stringify(val)); }
async function redisDel(key) { if (!RedisClient) return; await RedisClient.del(key); }

// ---------------- Utilities ----------------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

function nowIso() { return new Date().toISOString(); }

function seriesOf(numberStr) {
  if (!numberStr) return '';
  const m = String(numberStr).match(/^([A-Za-z\-_.]+)[0-9]*$/);
  if (m) return m[1].toUpperCase();
  const parts = String(numberStr).split(/(\d+)/).filter(Boolean);
  return (parts[0] || '').toUpperCase();
}

function parseTicket(full) {
  if (!full) return null;
  const m = String(full).match(/^(.+?)(\d+)$/);
  if (!m) return null;
  const prefix = m[1];
  const numStr = m[2];
  const num = parseInt(numStr, 10);
  if (isNaN(num)) return null;
  return { prefix, numStr, num, pad: numStr.length };
}
function previousTicket(full) {
  const p = parseTicket(full);
  if (!p) return null;
  const prev = p.num - 1;
  if (prev < 0) return null;
  const prevStr = String(prev).padStart(p.pad, '0');
  return `${p.prefix}${prevStr}`;
}
function ticketKeyFor({ ticketId, chatId, theirNumber }) {
  if (ticketId) return String(ticketId);
  return `${String(chatId)}|${String(theirNumber)}`;
}
function formatDurationMs(ms) {
  if (ms == null || isNaN(ms)) return '-';
  ms = Math.max(0, Math.round(ms));
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const remS = s % 60;
  return `${m}m ${remS}s`;
}
function normalizeNumber(s) {
  if (!s && s !== 0) return '';
  return String(s).trim().replace(/\s+/g, '').toLowerCase();
}

const fetchFn = globalThis.fetch || (typeof require === 'function' ? require('node-fetch') : null);
if (!fetchFn) throw new Error('fetch is required in runtime');

// ---------------- Telegram send ----------------
async function tgSendMessage(chatId, text, inlineKeyboard = null) {
  if (!BOT_TOKEN) return { ok: false, error: 'Missing BOT_TOKEN env' };
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: String(chatId),
    text: String(text),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (inlineKeyboard) body.reply_markup = { inline_keyboard: inlineKeyboard };

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const txt = await res.text().catch(()=>null);
    let json = null;
    try { json = txt ? JSON.parse(txt) : null; } catch(e){}
    return { ok: res.ok, status: res.status, bodyText: txt, bodyJson: json };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
async function sendWithRetry(chatId, text, inlineKeyboard = null) {
  const maxRetries = 2;
  let attempt = 0;
  let lastErr = null;
  while (attempt <= maxRetries) {
    try {
      return await tgSendMessage(chatId, text, inlineKeyboard);
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e);
      if (/blocked|user is deactivated|chat not found|not_found|have no rights/i.test(msg)) { throw e; }
      await new Promise(r => setTimeout(r, 150 + attempt * 200));
      attempt++;
    }
  }
  throw lastErr || new Error('Unknown send error');
}

// ---------------- Firebase cleaning ----------------
async function firebaseFetchQueueAll(firebaseUrl) {
  try {
    const url = `${firebaseUrl.replace(/\/$/,'')}/queue.json`;
    const res = await fetchFn(url);
    if (!res.ok) return null;
    const json = await res.json();
    return json;
  } catch (e) { return null; }
}
async function firebaseDeletePath(firebaseUrl, path) {
  try {
    const cleanBase = firebaseUrl.replace(/\/$/,'');
    const url = `${cleanBase}/${path}.json`;
    const res = await fetchFn(url, { method: 'DELETE' });
    return res.ok;
  } catch (e) { return false; }
}
async function firebaseCleanMatching(firebaseUrl, calledFull, ticketId = null) {
  if (!firebaseUrl) return { ok: false, reason: 'no firebase url' };
  const deleted = [];
  const errors = [];
  try {
    if (ticketId) {
      const qPathById = `queue/${encodeURIComponent(ticketId)}`;
      const ok = await firebaseDeletePath(firebaseUrl, qPathById);
      if (ok) deleted.push(qPathById);
    }
    const all = await firebaseFetchQueueAll(firebaseUrl);
    if (!all || typeof all !== 'object') {
      return { ok: true, deleted, errors, note: 'No queue entries found or public DB blocked' };
    }
    const lowCalled = String(calledFull).toLowerCase();
    for (const [key, obj] of Object.entries(all)) {
      if (!obj || typeof obj !== 'object') continue;
      const fields = ['theirNumber','number','fullNumber','ticketNumber','code','id'];
      let match = false;
      for (const f of fields) {
        if (f in obj && obj[f] && String(obj[f]).toLowerCase() === lowCalled) { match = true; break; }
      }
      if (!match && ticketId) {
        if (obj.ticketId && String(obj.ticketId) === String(ticketId)) match = true;
        if (String(key) === String(ticketId)) match = true;
      }
      if (match) {
        const path = `queue/${encodeURIComponent(key)}`;
        const ok = await firebaseDeletePath(firebaseUrl, path);
        if (ok) deleted.push(path);
        else errors.push({ path, reason: 'delete-failed' });
      }
    }
    return { ok: true, deleted, errors };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// ---------------- Main handler ----------------
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Only POST allowed' }) };

  if (!BOT_TOKEN) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing BOT_TOKEN env' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const calledFullRaw = String(payload.calledFull || '').trim();
  const calledFullNorm = normalizeNumber(calledFullRaw);
  const counterNameRaw = payload.counterName ? String(payload.counterName).trim() : '';
  const counterNameDisplay = counterNameRaw || '';
  const rawRecipients = Array.isArray(payload.recipients) ? payload.recipients : [];
  const cleanFirebase = !!payload.cleanFirebase;

  if (!calledFullRaw) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'calledFull is required' }) };
  }

  const calledSeries = seriesOf(calledFullRaw);
  const prevFullRaw = previousTicket(calledFullRaw);
  const prevFullNorm = prevFullRaw ? normalizeNumber(prevFullRaw) : null;

  // load ephemeral store if Redis not used
  let store = null;
  if (!useRedis) store = await loadStore();

  // Build recipients keyed by unique ticketKey to avoid dropping tickets for same chatId
  const recipientsByTicketKey = new Map();
  for (const r of rawRecipients) {
    const chatId = r?.chatId || r?.chat_id || r?.id;
    if (!chatId) continue;
    const theirNumberRaw = (r?.theirNumber || r?.number || r?.recipientFull || r?.fullNumber || '').toString().trim();
    if (!theirNumberRaw) continue;
    const theirSeries = seriesOf(theirNumberRaw);
    if (!theirSeries) continue;
    // only same series
    if (theirSeries !== calledSeries) continue;
    const key = ticketKeyFor({ ticketId: r?.ticketId || r?.ticket || null, chatId, theirNumber: theirNumberRaw });
    if (!recipientsByTicketKey.has(key)) {
      recipientsByTicketKey.set(key, {
        chatId: String(chatId),
        theirNumberRaw,
        theirNumberNorm: normalizeNumber(theirNumberRaw),
        ticketId: r?.ticketId || r?.ticket || null,
        createdAt: r?.createdAt || null
      });
    }
  }

  if (!recipientsByTicketKey.size) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, calledFull: calledFullRaw, prevFull: prevFullRaw, sent: 0, message: 'No recipients matched series or no recipients provided' }) };
  }

  const results = [];
  // Inline keyboard always promotes (every message)
  const inlineKeyboardPromo = [[{ text: '👉 Explore QueueJoy', url: PROMO_URL }]];

  // Process recipients
  for (const [ticketKey, item] of recipientsByTicketKey.entries()) {
    const theirNumberRaw = item.theirNumberRaw;
    const theirNumberNorm = item.theirNumberNorm;
    const chatId = item.chatId;
    const ticketId = item.ticketId || null;

    // Load ticket record if present
    let ticket = null;
    if (useRedis) {
      ticket = await redisGet(`ticket:${ticketKey}`);
    } else {
      ticket = (store.tickets && store.tickets[ticketKey]) ? store.tickets[ticketKey] : null;
    }

    if (!ticket) {
      ticket = {
        ticketKey,
        ticketId: ticketId || null,
        chatId,
        theirNumber: theirNumberRaw,
        series: seriesOf(theirNumberRaw) || calledSeries,
        createdAt: item.createdAt || nowIso(),
        notifiedAt: null,
        calledAt: null,
        servedAt: null,
      };
    }

    // Determine action
    let action = null;
    if (theirNumberNorm === calledFullNorm) action = 'served';
    else if (prevFullNorm && theirNumberNorm === prevFullNorm) action = 'next';
    else {
      results.push({ chatId, theirNumber: theirNumberRaw, skipped: true });
      continue;
    }

    // Build message (BOLD number and counter and IMPORTANT)
    let messageText = '';
    if (action === 'served') {
      ticket.calledAt = nowIso();
      ticket.servedAt = nowIso();
      messageText = `🎯 <b>IMPORTANT:</b>\n\nYour number <b>${theirNumberRaw}</b> has been <b>CALLED</b>. Please proceed to <b>${counterNameDisplay || 'the counter'}</b> now. Thank you.`;
      // Promo is included every time (per request)
      messageText += `\n\n<b>Curious how this works?</b> Tap 👉 "Explore QueueJoy" below to see tools your shop can use to keep customers happy.`;
    } else { // next
      ticket.notifiedAt = nowIso();
      messageText = `⏳ <b>IMPORTANT:</b>\n\nYour number <b>${theirNumberRaw}</b> — you are <b>NEXT</b>. Please be ready for <b>${counterNameDisplay || 'the counter'}</b>. Thank you.`;
      // Promo also included for "next"
      messageText += `\n\n<b>Curious how this works?</b> Tap 👉 "Explore QueueJoy" below to see tools your shop can use to keep customers happy.`;
    }

    // Always include promo keyboard
    const inlineKeyboard = inlineKeyboardPromo;

    // Attempt send with retries
    let sendRes;
    try {
      sendRes = await sendWithRetry(chatId, messageText, inlineKeyboard);
    } catch (err) {
      sendRes = { ok: false, error: String(err) };
    }

    // Persist/cleanup & stats for served
    let statUpdate = null;
    let firebaseCleanResult = null;

    if (action === 'served') {
      try {
        const createdMs = new Date(ticket.createdAt).getTime();
        const servedMs = new Date(ticket.servedAt).getTime();
        const serviceMs = Math.max(0, servedMs - (isNaN(createdMs) ? servedMs : createdMs));
        const statKey = `stats:${ticket.series}`;

        if (useRedis) {
          let stats = await redisGet(statKey) || { totalServed: 0, totalServiceMs: 0, lastServedAt: null };
          stats.totalServed = (stats.totalServed || 0) + 1;
          stats.totalServiceMs = (stats.totalServiceMs || 0) + serviceMs;
          stats.lastServedAt = ticket.servedAt;
          await redisSet(statKey, stats);
          await redisDel(`ticket:${ticketKey}`);
          statUpdate = stats;
        } else {
          store.tickets = store.tickets || {};
          store.stats = store.stats || {};
          let stats = store.stats[ticket.series] || { totalServed: 0, totalServiceMs: 0, lastServedAt: null };
          stats.totalServed = (stats.totalServed || 0) + 1;
          stats.totalServiceMs = (stats.totalServiceMs || 0) + serviceMs;
          stats.lastServedAt = ticket.servedAt;
          store.stats[ticket.series] = stats;
          delete store.tickets[ticketKey];
          await saveStore(store);
          statUpdate = stats;
        }
      } catch (e) { console.warn('stat update error', e && e.message ? e.message : e); }

      if (FIREBASE_DB_URL) {
        try { firebaseCleanResult = await firebaseCleanMatching(FIREBASE_DB_URL, theirNumberRaw, ticket.ticketId || null); } catch (e) { firebaseCleanResult = { ok: false, error: String(e) }; }
      }
    } else { // next => persist
      try {
        if (useRedis) await redisSet(`ticket:${ticketKey}`, ticket);
        else {
          store.tickets = store.tickets || {};
          store.tickets[ticketKey] = ticket;
          await saveStore(store);
        }
      } catch (e) { console.warn('persist next ticket error', e && e.message ? e.message : e); }
    }

    results.push({
      chatId,
      theirNumber: theirNumberRaw,
      ticketKey,
      ticketId: ticket.ticketId || null,
      action,
      sendRes,
      statUpdate,
      firebaseCleanResult
    });

    await new Promise(r => setTimeout(r, 90));
  }

  // Build stats snapshot
  let statsSnapshot = null;
  if (useRedis) {
    try {
      const s = await redisGet(`stats:${calledSeries}`);
      if (s) statsSnapshot = { series: calledSeries, totalServed: s.totalServed || 0, avgServiceMs: s.totalServed ? Math.round((s.totalServiceMs || 0) / s.totalServed) : null, avgFormatted: s.totalServed ? formatDurationMs(Math.round((s.totalServiceMs || 0) / s.totalServed)) : '-', lastServedAt: s.lastServedAt || null };
    } catch (e) {}
  } else {
    statsSnapshot = store.stats && store.stats[calledSeries] ? { series: calledSeries, totalServed: store.stats[calledSeries].totalServed || 0, avgServiceMs: store.stats[calledSeries].totalServed ? Math.round(store.stats[calledSeries].totalServiceMs / store.stats[calledSeries].totalServed) : null, avgFormatted: store.stats[calledSeries].totalServed ? formatDurationMs(Math.round(store.stats[calledSeries].totalServiceMs / store.stats[calledSeries].totalServed)) : '-', lastServedAt: store.stats[calledSeries] ? store.stats[calledSeries].lastServedAt : null } : { series: calledSeries, totalServed: 0, avgServiceMs: null, avgFormatted: '-', lastServedAt: null };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      calledFull: calledFullRaw,
      prevFull: prevFullRaw || null,
      counterName: counterNameDisplay,
      sent: results.filter(r => !r.skipped).length,
      results,
      statsSnapshot,
      persistence: useRedis ? 'redis' : 'ephemeral-file',
      firebaseConfigured: !!FIREBASE_DB_URL
    })
  };
};

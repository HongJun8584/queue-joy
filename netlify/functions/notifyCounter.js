// netlify/functions/notifyCounter.js
// Notifier: polite notifications for (a) the called number (served) and (b) the number immediately before it (next).
// Envs:
//  - BOT_TOKEN (required)
//  - REDIS_URL (optional)
//  - FIREBASE_DB_URL (optional) - e.g. https://your-app-default-rtdb.region.firebasedatabase.app
//
// POST JSON body:
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
    console.warn('ioredis not available/failed — falling back to ephemeral /tmp storage.', e.message);
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

async function redisGet(key) {
  if (!RedisClient) return null;
  const v = await RedisClient.get(key);
  return v ? JSON.parse(v) : null;
}
async function redisSet(key, val) {
  if (!RedisClient) return;
  await RedisClient.set(key, JSON.stringify(val));
}
async function redisDel(key) {
  if (!RedisClient) return;
  await RedisClient.del(key);
}

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
      if (/blocked|user is deactivated|chat not found|not_found|have no rights/i.test(msg)) {
        throw e;
      }
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
    return json; // object keyed by queue id
  } catch (e) {
    return null;
  }
}
async function firebaseDeletePath(firebaseUrl, path) {
  try {
    const cleanBase = firebaseUrl.replace(/\/$/,'');
    const url = `${cleanBase}/${path}.json`;
    const res = await fetchFn(url, { method: 'DELETE' });
    return res.ok;
  } catch (e) {
    return false;
  }
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
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---------------- reminder (exact, used for prevFull) ----------------
// Named exactly `reminder`. Sends friendly bolded heads-up for the previous/next ticket.
// Example:
// 🔔 Heads-up!
// Number <b>VANILLA002</b> was called. Your number is <b>VANILLA001</b>. We'll notify you again when it's your turn.
async function reminder(chatId, theirNumber, calledFull, inlineKeyboard = null) {
  if (!chatId) return { ok: false, error: 'no chatId' };
  const text = `🔔 Heads-up!\nNumber <b>${String(calledFull)}</b> was called. Your number is <b>${String(theirNumber)}</b>. We'll notify you again when it's your turn.`;
  try {
    const res = await sendWithRetry(chatId, text, inlineKeyboard);
    return { ok: !!res && res.ok, sendRes: res };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ---------------- Main handler ----------------
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Only POST allowed' }) };

  if (!BOT_TOKEN) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing BOT_TOKEN env' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const calledFull = String(payload.calledFull || '').trim();
  const counterName = payload.counterName ? String(payload.counterName).trim() : '';
  const rawRecipients = Array.isArray(payload.recipients) ? payload.recipients : [];
  const cleanFirebase = !!payload.cleanFirebase; // optional override from client

  if (!calledFull) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'calledFull is required' }) };
  }

  const calledSeries = seriesOf(calledFull);
  const prevFull = previousTicket(calledFull); // may be null

  // load ephemeral store if Redis not used
  let store = null;
  if (!useRedis) store = await loadStore();

  // normalize recipients and dedupe by chatId
  const dedupe = new Map();
  for (const r of rawRecipients) {
    const chatId = r?.chatId || r?.chat_id || r?.id;
    if (!chatId) continue;
    const theirNumber = (r?.theirNumber || r?.number || r?.recipientFull || r?.fullNumber || '').toString().trim();
    if (!theirNumber) continue;
    const recipientSeries = seriesOf(theirNumber);
    if (!recipientSeries) continue;
    // only same series to avoid cross-series notifications
    if (recipientSeries !== calledSeries) continue;
    const key = String(chatId);
    const existing = dedupe.get(key);
    if (!existing) dedupe.set(key, { chatId: key, theirNumber, ticketId: r?.ticketId || r?.ticket || null, createdAt: r?.createdAt || null });
    else {
      // prefer entries whose number exactly matches calledFull or prevFull
      const existingPriority = (existing.theirNumber.toLowerCase() === calledFull.toLowerCase() || existing.theirNumber.toLowerCase() === (prevFull || '').toLowerCase()) ? 1 : 0;
      const thisPriority = (theirNumber.toLowerCase() === calledFull.toLowerCase() || theirNumber.toLowerCase() === (prevFull || '').toLowerCase()) ? 1 : 0;
      if (thisPriority > existingPriority) dedupe.set(key, { chatId: key, theirNumber, ticketId: r?.ticketId || r?.ticket || null, createdAt: r?.createdAt || null });
    }
  }

  if (!dedupe.size) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, calledFull, prevFull, sent: 0, message: 'No recipients matched series or no recipients provided' }) };
  }

  const results = [];
  // IMPORTANT: keep Explore QueueJoy button (user insisted)
  const inlineKeyboard = [[{ text: 'Explore QueueJoy', url: 'https://helloqueuejoy.netlify.app' }]];

  // "Curious" CTA appended only once for served message (no duplicates)
  const curiousText = '\n\nCurious how this works? Tap 👉 "Explore QueueJoy" below to see tools your shop can use to keep customers happy.';

  // Process recipients (only those matching calledFull or prevFull)
  for (const [chatId, item] of dedupe.entries()) {
    const theirNumber = item.theirNumber || '';
    const ticketId = item.ticketId || null;
    const key = ticketKeyFor({ ticketId, chatId, theirNumber });

    // Load ticket record if present
    let ticket = null;
    if (useRedis) {
      ticket = await redisGet(`ticket:${key}`);
    } else {
      ticket = (store.tickets && store.tickets[key]) ? store.tickets[key] : null;
    }

    if (!ticket) {
      ticket = {
        ticketKey: key,
        ticketId: ticketId || null,
        chatId,
        theirNumber,
        series: seriesOf(theirNumber) || calledSeries,
        createdAt: item.createdAt || nowIso(),
        notifiedAt: null,
        calledAt: null,
        servedAt: null,
      };
    }

    let action = null;
    let messageText = null;

    // Polite messaging
    if (theirNumber.toLowerCase() === calledFull.toLowerCase()) {
      action = 'served';
      ticket.calledAt = nowIso();
      ticket.servedAt = nowIso();
      // served message + curious CTA once
      messageText = `🎯 Dear customer,\n\nYour number <b>${calledFull}</b> has been called. Please proceed to${counterName ? ' ' + counterName : ' the counter'} at your convenience. Thank you.` + curiousText;
    } else if (prevFull && theirNumber.toLowerCase() === prevFull.toLowerCase()) {
      action = 'next';
      ticket.notifiedAt = nowIso();
      // we'll call reminder() below explicitly
    } else {
      results.push({ chatId, theirNumber, skipped: true });
      continue;
    }

    // Persist & stats update
    let statUpdate = null;
    if (action === 'served') {
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
        // remove active ticket from Redis (clean)
        await redisDel(`ticket:${key}`);
        statUpdate = stats;
      } else {
        store.tickets = store.tickets || {};
        store.stats = store.stats || {};
        let stats = store.stats[ticket.series] || { totalServed: 0, totalServiceMs: 0, lastServedAt: null };
        stats.totalServed = (stats.totalServed || 0) + 1;
        stats.totalServiceMs = (stats.totalServiceMs || 0) + serviceMs;
        stats.lastServedAt = ticket.servedAt;
        store.stats[ticket.series] = stats;
        // delete active ticket
        delete store.tickets[key];
        await saveStore(store);
        statUpdate = stats;
      }
    } else { // next: persist ticket as notified
      if (useRedis) {
        await redisSet(`ticket:${key}`, ticket);
      } else {
        store.tickets = store.tickets || {};
        store.tickets[key] = ticket;
        await saveStore(store);
      }
    }

    // Send the message
    let sendRes;
    if (action === 'next') {
      // Use reminder helper so the message exactly matches the requested friendly format
      try {
        // reminder returns { ok, sendRes } — keep that shape in results
        sendRes = await reminder(chatId, theirNumber, calledFull, inlineKeyboard);
      } catch (err) {
        sendRes = { ok: false, error: String(err) };
      }
    } else {
      try {
        sendRes = await sendWithRetry(chatId, messageText, inlineKeyboard);
      } catch (err) {
        sendRes = { ok: false, error: String(err) };
      }
    }

    // After successful served message, attempt firebase cleaning if requested or FIREBASE_DB_URL present
    let firebaseCleanResult = null;
    if (action === 'served' && FIREBASE_DB_URL) {
      try {
        firebaseCleanResult = await firebaseCleanMatching(FIREBASE_DB_URL, calledFull, ticket.ticketId || null);
      } catch (e) {
        firebaseCleanResult = { ok: false, error: String(e) };
      }
    }

    results.push({
      chatId,
      theirNumber,
      ticketKey: key,
      ticketId: ticket.ticketId || null,
      action,
      sendRes,
      statUpdate,
      firebaseCleanResult
    });

    // gentle pause
    await new Promise(r => setTimeout(r, 90));
  }

  // Build stats snapshot for response (calledSeries)
  let statsSnapshot = null;
  if (useRedis) {
    try {
      const s = await redisGet(`stats:${calledSeries}`);
      if (s) statsSnapshot = {
        series: calledSeries,
        totalServed: s.totalServed || 0,
        avgServiceMs: s.totalServed ? Math.round((s.totalServiceMs || 0) / s.totalServed) : null,
        avgFormatted: s.totalServed ? formatDurationMs(Math.round((s.totalServiceMs || 0) / s.totalServed)) : '-',
        lastServedAt: s.lastServedAt || null
      };
    } catch (e) {}
  } else {
    statsSnapshot = store.stats && store.stats[calledSeries] ? {
      series: calledSeries,
      totalServed: store.stats[calledSeries].totalServed || 0,
      avgServiceMs: store.stats[calledSeries].totalServed ? Math.round(store.stats[calledSeries].totalServiceMs / store.stats[calledSeries].totalServed) : null,
      avgFormatted: store.stats[calledSeries].totalServed ? formatDurationMs(Math.round(store.stats[calledSeries].totalServiceMs / store.stats[calledSeries].totalServed)) : '-',
      lastServedAt: store.stats[calledSeries] ? store.stats[calledSeries].lastServedAt : null
    } : { series: calledSeries, totalServed: 0, avgServiceMs: null, avgFormatted: '-', lastServedAt: null };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      calledFull,
      prevFull: prevFull || null,
      counterName,
      sent: results.filter(r => !r.skipped).length,
      results,
      statsSnapshot,
      persistence: useRedis ? 'redis' : 'ephemeral-file',
      firebaseConfigured: !!FIREBASE_DB_URL
    })
  };
};

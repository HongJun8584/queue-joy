// netlify/functions/notifyCounter.js
// Notifier: notifies (a) the called number (served) and (b) the number immediately before (next).
// Envs:
//  - BOT_TOKEN (required)
//  - REDIS_URL (optional, recommended for persistence)
// POST JSON body:
// {
//   "calledFull": "VANILLA002",
//   "counterName": "COUNTER ICE CREAM VANILLA",
//   "recipients": [
//     { "chatId": "123456", "theirNumber": "VANILLA002", "ticketId": "t-abc", "createdAt": "2025-11-19T14:00:00Z" }
//   ]
// }
// Behavior:
//  - Only sends to recipients whose `theirNumber` equals calledFull (served) OR equals previous number (next).
//  - Marks served tickets as served (persisted) and deletes active ticket entry.
//  - Updates series stats (totalServed, totalServiceMs, lastServedAt).
//  - Minimal inline keyboard: [Status] [Help]

const fs = require('fs');
const path = require('path');
const TMP_STORE = '/tmp/queuejoy_store.json';

const BOT_TOKEN = process.env.BOT_TOKEN || null;
const REDIS_URL = process.env.REDIS_URL || null;

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

// ---------- Helpers: persistence ----------
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

// ---------- Utility ----------
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

// ---------- Telegram send ----------
const fetchFn = globalThis.fetch || (typeof require === 'function' ? require('node-fetch') : null);
if (!fetchFn) throw new Error('fetch is required in runtime');

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
      // permanent failures: blocked / chat not found — stop retrying
      if (/blocked|user is deactivated|chat not found|not_found|have no rights/i.test(msg)) {
        throw e;
      }
      // backoff
      await new Promise(r => setTimeout(r, 150 + attempt * 200));
      attempt++;
    }
  }
  throw lastErr || new Error('Unknown send error');
}

// ---------- Main handler ----------
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

  const calledFull = String(payload.calledFull || '').trim();
  const counterName = payload.counterName ? String(payload.counterName).trim() : '';
  const rawRecipients = Array.isArray(payload.recipients) ? payload.recipients : [];

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
    // Optional: only same series (safer). If theirNumber has no series, we skip.
    const recipientSeries = seriesOf(theirNumber);
    if (!recipientSeries) continue;
    // allow only same series: this prevents cross-series notifications
    if (recipientSeries !== calledSeries) continue;
    const key = String(chatId);
    // prefer an entry where theirNumber exactly equals prevFull or calledFull (if multiple per chat)
    const existing = dedupe.get(key);
    if (!existing) dedupe.set(key, { chatId: key, theirNumber, ticketId: r?.ticketId || r?.ticket || null, createdAt: r?.createdAt || null });
    else {
      const existingPriority = (existing.theirNumber.toLowerCase() === calledFull.toLowerCase() || existing.theirNumber.toLowerCase() === (prevFull || '').toLowerCase()) ? 1 : 0;
      const thisPriority = (theirNumber.toLowerCase() === calledFull.toLowerCase() || theirNumber.toLowerCase() === (prevFull || '').toLowerCase()) ? 1 : 0;
      if (thisPriority > existingPriority) dedupe.set(key, { chatId: key, theirNumber, ticketId: r?.ticketId || r?.ticket || null, createdAt: r?.createdAt || null });
    }
  }

  if (!dedupe.size) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, calledFull, prevFull, sent: 0, message: 'No recipients matched series or no recipients provided' }) };
  }

  const results = [];

  // Inline keyboard (minimal) — two buttons: Status and Help (callback_data)
  const inlineKeyboard = [
    [{ text: 'ℹ️ Status', callback_data: '/status' }, { text: '❓ Help', callback_data: '/help' }]
  ];

  for (const [chatId, item] of dedupe.entries()) {
    const theirNumber = item.theirNumber || '';
    const ticketId = item.ticketId || null;
    const key = ticketKeyFor({ ticketId, chatId, theirNumber });

    // Load ticket if exists
    let ticket = null;
    if (useRedis) {
      ticket = await redisGet(`ticket:${key}`);
    } else {
      ticket = (store.tickets && store.tickets[key]) ? store.tickets[key] : null;
    }

    // If no ticket record, create baseline
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

    if (theirNumber.toLowerCase() === calledFull.toLowerCase()) {
      // It's your turn
      action = 'served';
      ticket.calledAt = nowIso();
      ticket.servedAt = nowIso();

      // concise message
      messageText = `🎯 <b>${calledFull}</b> — it’s your turn.\nPlease go to${counterName ? ' ' + counterName : ' the counter'} now.`;
    } else if (prevFull && theirNumber.toLowerCase() === prevFull.toLowerCase()) {
      // You're next
      action = 'next';
      ticket.notifiedAt = nowIso();
      messageText = `⏳ <b>${theirNumber}</b> — you're next. Please be ready to approach the counter soon.`;
    } else {
      // not relevant to this run: skip
      results.push({ chatId, theirNumber, skipped: true });
      continue;
    }

    // Persist ticket update: mark served or update notified time
    if (action === 'served') {
      // update stats and remove active ticket
      // compute serviceMs
      const createdMs = new Date(ticket.createdAt).getTime();
      const servedMs = new Date(ticket.servedAt).getTime();
      const serviceMs = Math.max(0, servedMs - (isNaN(createdMs) ? servedMs : createdMs));

      // update stats key
      const statKey = `stats:${ticket.series}`;
      let stats = null;
      if (useRedis) {
        stats = await redisGet(statKey) || { totalServed: 0, totalServiceMs: 0, lastServedAt: null };
        stats.totalServed = (stats.totalServed || 0) + 1;
        stats.totalServiceMs = (stats.totalServiceMs || 0) + serviceMs;
        stats.lastServedAt = ticket.servedAt;
        await redisSet(statKey, stats);
        // clean active ticket entry
        await redisDel(`ticket:${key}`);
      } else {
        store.tickets = store.tickets || {};
        store.stats = store.stats || {};
        stats = store.stats[ticket.series] || { totalServed: 0, totalServiceMs: 0, lastServedAt: null };
        stats.totalServed = (stats.totalServed || 0) + 1;
        stats.totalServiceMs = (stats.totalServiceMs || 0) + serviceMs;
        stats.lastServedAt = ticket.servedAt;
        store.stats[ticket.series] = stats;
        // remove ticket from active tickets
        delete store.tickets[key];
        await saveStore(store);
      }
    } else {
      // action === 'next' -> persist ticket notifiedAt
      if (useRedis) {
        await redisSet(`ticket:${key}`, ticket);
      } else {
        store.tickets = store.tickets || {};
        store.tickets[key] = ticket;
        await saveStore(store);
      }
    }

    // Send message with inline keyboard
    let sendRes;
    try {
      sendRes = await sendWithRetry(chatId, messageText, inlineKeyboard);
    } catch (err) {
      sendRes = { ok: false, error: String(err) };
    }

    // Attach stat snapshot if served
    let statUpdate = null;
    if (action === 'served') {
      if (useRedis) {
        const s = await redisGet(`stats:${ticket.series}`);
        statUpdate = s ? {
          series: ticket.series,
          totalServed: s.totalServed || 0,
          totalServiceMs: s.totalServiceMs || 0,
          avgServiceMs: s.totalServed ? Math.round((s.totalServiceMs || 0) / s.totalServed) : null,
          avgFormatted: s.totalServed ? formatDurationMs(Math.round((s.totalServiceMs || 0) / s.totalServed)) : '-',
          lastServedAt: s.lastServedAt || null
        } : null;
      } else {
        const sObj = store.stats && store.stats[ticket.series] ? store.stats[ticket.series] : null;
        if (sObj) {
          statUpdate = {
            series: ticket.series,
            totalServed: sObj.totalServed || 0,
            totalServiceMs: sObj.totalServiceMs || 0,
            avgServiceMs: sObj.totalServed ? Math.round((sObj.totalServiceMs || 0) / sObj.totalServed) : null,
            avgFormatted: sObj.totalServed ? formatDurationMs(Math.round((sObj.totalServiceMs || 0) / sObj.totalServed)) : '-',
            lastServedAt: sObj.lastServedAt || null
          };
        }
      }
    }

    results.push({
      chatId,
      theirNumber,
      ticketKey: key,
      action,
      sendRes,
      statUpdate
    });

    // gentle pause to reduce rate limit impact
    await new Promise(r => setTimeout(r, 90));
  } // end for

  // prepare stats snapshot for calledSeries
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
    } catch (e) { /* ignore */ }
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
      persistence: useRedis ? 'redis' : 'ephemeral-file'
    })
  };
};

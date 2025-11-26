// netlify/functions/notifyCounter.js
// Enhanced/robust Netlify function to notify customers (Telegram).
// - POST JSON body:
//   {
//     "calledFull": "VANILLA002",
//     "counterName": "COUNTER ICE CREAM VANILLA",
//     "recipients": [
//       { "chatId": "123456", "theirNumber": "VANILLA002", "ticketId": "t-abc", "createdAt": "2025-11-19T14:00:00Z" }
//     ]
//   }
// - Envs:
//    BOT_TOKEN (required)
//    REDIS_URL (optional)
// Notes:
// - Sends two kinds of Telegram messages:
//   REMINDER (everyone in same series except exact match)
//   IT'S YOUR TURN (exact matched ticket)
// - Only one inline button: "👉 Explore QueueJoy" (no Status / Unsubscribe).
// - If REDIS_URL provided, uses ioredis. Otherwise ephemeral file at /tmp (not durable).

const fetch = globalThis.fetch || require('node-fetch');
const fs = require('fs');
const { URL } = require('url');

const REDIS_URL = process.env.REDIS_URL || null;
let useRedis = false;
let RedisClient = null;
if (REDIS_URL) {
  try {
    const IORedis = require('ioredis');
    RedisClient = new IORedis(REDIS_URL);
    useRedis = true;
  } catch (e) {
    console.warn('ioredis not available or failed to connect, falling back to ephemeral store:', e.message);
    useRedis = false;
    RedisClient = null;
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN || null;
const TMP_STORE = '/tmp/queuejoy_store.json';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

function nowIso() { return new Date().toISOString(); }

// Normalize numbers for consistent comparisons: strip unwanted chars, uppercase.
function normalizeNumber(n) {
  if (!n && n !== 0) return '';
  return String(n)
    .trim()
    .replace(/\s+/g, '')                // remove spaces
    .replace(/[^A-Za-z0-9\-\_\.]/g, '') // allow letters, digits, -, _, .
    .toUpperCase();
}

// Extract series part (letters / prefix) of a ticket like COFFEE014 -> COFFEE
function seriesOf(numberStr) {
  if (!numberStr) return '';
  const cleaned = normalizeNumber(numberStr);
  const m = String(cleaned).match(/^([A-Za-z\-_.]+)[0-9]*$/);
  if (m) return m[1].toUpperCase();
  const parts = String(cleaned).split(/(\d+)/).filter(Boolean);
  return (parts[0] || '').toUpperCase();
}

function ticketKeyFor({ ticketId, chatId, theirNumber }) {
  if (ticketId) return String(ticketId);
  return `${String(chatId)}|${normalizeNumber(theirNumber)}`;
}

// -------- persistence helpers (Redis or ephemeral) --------
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
  try {
    const v = await RedisClient.get(key);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    console.warn('redisGet error', e.message);
    return null;
  }
}
async function redisSet(key, val) {
  if (!RedisClient) return;
  try {
    await RedisClient.set(key, JSON.stringify(val));
  } catch (e) { console.warn('redisSet error', e.message); }
}
async function redisDel(key) {
  if (!RedisClient) return;
  try {
    await RedisClient.del(key);
  } catch (e) { console.warn('redisDel error', e.message); }
}

// -------- Telegram send helper (only Explore button) --------
async function tgSendMessage(chatId, text, inlineButtons /* optional */) {
  if (!BOT_TOKEN) return { ok: false, error: 'Missing BOT_TOKEN env' };
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: String(chatId),
    text: String(text),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  // Only the Explore button. If caller supplies inlineButtons, merge them as additional rows
  const exploreButtonRow = [{ text: '👉 Explore QueueJoy', url: 'https://helloqueuejoy.netlify.app' }];
  body.reply_markup = { inline_keyboard: [exploreButtonRow] };
  if (Array.isArray(inlineButtons) && inlineButtons.length) {
    // append provided rows after explore button
    body.reply_markup.inline_keyboard = [exploreButtonRow].concat(inlineButtons);
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
    const textResp = await res.text().catch(() => null);
    let json = null;
    try { json = textResp ? JSON.parse(textResp) : null; } catch (e) {}
    return { ok: res.ok, status: res.status, bodyText: textResp, bodyJson: json };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// -------- main handler --------
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
  const calledFull = normalizeNumber(calledFullRaw);
  const counterName = payload.counterName ? String(payload.counterName).trim() : '';
  const rawRecipients = Array.isArray(payload.recipients) ? payload.recipients : [];
  if (!calledFull) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'calledFull is required' }) };
  }

  const calledSeries = seriesOf(calledFull);
  // load ephemeral store if needed
  let store = null;
  if (!useRedis) store = await loadStore();

  // Normalize recipients and dedupe by chatId (one message per chat)
  const dedupe = new Map();
  for (const r of rawRecipients) {
    const chatId = r?.chatId || r?.chat_id || r?.id;
    if (!chatId) continue;
    const theirNumberRaw = (r?.theirNumber || r?.number || r?.recipientFull || r?.fullNumber || '');
    const theirNumber = normalizeNumber(theirNumberRaw);
    if (!theirNumber) continue;
    const recipientSeries = seriesOf(theirNumber);
    if (!recipientSeries) continue;
    if (recipientSeries !== calledSeries) continue; // only notify same series

    const ticketId = r?.ticketId || r?.ticket || null;
    const key = String(chatId);
    const existing = dedupe.get(key);
    if (!existing) {
      dedupe.set(key, { chatId: key, theirNumber, ticketId, createdAt: r?.createdAt || null });
    } else {
      // prefer an exact match to calledFull if multiple entries exist for same chat
      const thisMatches = theirNumber && theirNumber.toLowerCase() === calledFull.toLowerCase();
      const existingMatches = existing.theirNumber && existing.theirNumber.toLowerCase() === calledFull.toLowerCase();
      if (!existingMatches && thisMatches) dedupe.set(key, { chatId: key, theirNumber, ticketId, createdAt: r?.createdAt || null });
    }
  }

  if (!dedupe.size) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, calledFull, calledSeries, sent: 0, message: 'No recipients in same series' }) };
  }

  const results = [];
  for (const [chatId, item] of dedupe.entries()) {
    const theirNumber = item.theirNumber || '';
    const ticketId = item.ticketId || null;
    const key = ticketKeyFor({ ticketId, chatId, theirNumber });

    // load or create ticket record
    let ticket = null;
    if (useRedis) {
      ticket = await redisGet(`ticket:${key}`);
    } else {
      ticket = (store.tickets && store.tickets[key]) ? store.tickets[key] : null;
    }

    // if ticket exists and already served, skip to avoid duplicate notifications
    if (ticket && ticket.servedAt) {
      results.push({
        chatId,
        theirNumber,
        ticketKey: key,
        action: 'skipped-already-served',
        reason: 'ticket.servedAt present',
      });
      continue;
    }

    if (!ticket) {
      ticket = {
        ticketKey: key,
        ticketId: ticketId || null,
        chatId,
        theirNumber,
        series: seriesOf(theirNumber) || calledSeries,
        createdAt: item.createdAt || nowIso(),
        notifiedStayAt: null,
        calledAt: null,
        servedAt: null,
      };
    }

    const isMatch = theirNumber && theirNumber.toLowerCase() === calledFull.toLowerCase();

    // Compose message body and uniform suffix
    const exploreSuffix = '\n\nCurious how this works? Tap 👉 "Explore QueueJoy" below to see tools your shop can use to keep customers happy.';

    let text;
    if (isMatch) {
      ticket.calledAt = nowIso();
      ticket.servedAt = nowIso(); // mark served immediately
      text = `🎯 Dear customer,\n\nYour number <b>${calledFull}</b> has been called. Please proceed to <b>${counterName || 'the counter'}</b> at your convenience. Thank you.${exploreSuffix}`;
    } else {
      ticket.calledAt = ticket.calledAt || nowIso();
      ticket.notifiedStayAt = nowIso();
      text = `🔔 REMINDER\nNumber <b>${calledFull}</b> was called. Your number is <b>${theirNumber}</b>. We'll notify you again when it's your turn.${exploreSuffix}`;
    }

    // persist/update ticket before sending (so other concurrent calls can see)
    if (useRedis) {
      await redisSet(`ticket:${key}`, ticket);
    } else {
      store.tickets = store.tickets || {};
      store.tickets[key] = ticket;
      await saveStore(store);
    }

    // Send the message via Telegram, catch errors
    let sendRes = null;
    try {
      sendRes = await tgSendMessage(chatId, text);
    } catch (err) {
      sendRes = { ok: false, error: String(err) };
    }

    // If this was the exact match (served), immediately update stats and remove the ticket
    let statUpdate = null;
    if (isMatch && ticket.servedAt) {
      // compute service time
      const createdMs = (new Date(ticket.createdAt)).getTime();
      const servedMs = (new Date(ticket.servedAt)).getTime();
      const serviceMs = Math.max(0, servedMs - (isNaN(createdMs) ? servedMs : createdMs));

      const statKey = `stats:${ticket.series}`;
      let stats = null;
      if (useRedis) {
        stats = await redisGet(statKey) || { totalServed: 0, totalServiceMs: 0, lastServedAt: null };
        stats.totalServed = (stats.totalServed || 0) + 1;
        stats.totalServiceMs = (stats.totalServiceMs || 0) + serviceMs;
        stats.lastServedAt = ticket.servedAt;
        await redisSet(statKey, stats);
        // Remove ticket from Redis active tickets
        await redisDel(`ticket:${key}`);
      } else {
        store.stats = store.stats || {};
        stats = store.stats[ticket.series] || { totalServed: 0, totalServiceMs: 0, lastServedAt: null };
        stats.totalServed = (stats.totalServed || 0) + 1;
        stats.totalServiceMs = (stats.totalServiceMs || 0) + serviceMs;
        stats.lastServedAt = ticket.servedAt;
        store.stats[ticket.series] = stats;

        // Remove ticket from ephemeral active tickets
        if (store.tickets && store.tickets[key]) delete store.tickets[key];
        await saveStore(store);
      }

      statUpdate = {
        series: ticket.series,
        totalServed: stats.totalServed,
        totalServiceMs: stats.totalServiceMs,
        avgServiceMs: Math.round((stats.totalServiceMs || 0) / (stats.totalServed || 1)),
        lastServedAt: stats.lastServedAt,
        lastServiceMs: serviceMs,
      };
    }

    // If not match (reminder), leave ticket active (we updated notifiedStayAt earlier)
    results.push({
      chatId,
      theirNumber,
      ticketKey: key,
      action: isMatch ? 'served' : 'reminder',
      sendRes,
      statUpdate,
    });
  }

  // Prepare stats snapshot for calledSeries (best-effort)
  let statsSnapshot = null;
  if (useRedis) {
    try {
      const s = await redisGet(`stats:${calledSeries}`);
      if (s) statsSnapshot = s;
      else statsSnapshot = { series: calledSeries, totalServed: 0 };
    } catch (e) { statsSnapshot = { series: calledSeries, totalServed: 0 }; }
  } else {
    statsSnapshot = store.stats && store.stats[calledSeries] ? store.stats[calledSeries] : { series: calledSeries, totalServed: 0 };
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      calledFull,
      calledSeries,
      counterName,
      sent: results.length,
      results,
      statsSnapshot,
      persistence: useRedis ? 'redis' : 'ephemeral-file',
    }),
  };
};

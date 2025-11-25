// netlify/functions/notifyCounter.js
// Best-effort, robust Netlify function to notify customers (Telegram).
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
//    REDIS_URL (optional) -> if set, uses ioredis (recommended). Install ioredis in package.json.
// Notes:
// - Sends two kinds of Telegram messages:
//   1) REMINDER (sent to everyone in same series when another number is called).
//      Example (logical): "🔔 REMINDER\nNumber VANILLA001 was called. Your number is VANILLA002. We'll notify you again when it's your turn."
//   2) IT'S YOUR TURN (sent to the exact matched ticket).
//      Example: "🎯 Dear customer, Your number COFFEE016 has been called. Please proceed to COUNTER COFFEE ..."
// - Both messages include an "Explore QueueJoy" inline button linking to https://helloqueuejoy.netlify.app
// - If REDIS_URL is provided, active tickets & stats persist there. Otherwise ephemeral file at /tmp (not durable across cold-starts).

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
function seriesOf(numberStr) {
  if (!numberStr) return '';
  const m = String(numberStr).match(/^([A-Za-z\-_.]+)[0-9]*$/);
  if (m) return m[1].toUpperCase();
  const parts = String(numberStr).split(/(\d+)/).filter(Boolean);
  return (parts[0] || '').toUpperCase();
}
function ticketKeyFor({ ticketId, chatId, theirNumber }) {
  if (ticketId) return String(ticketId);
  return `${String(chatId)}|${String(theirNumber)}`;
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

// -------- Telegram send helper (with Explore button) --------
async function tgSendMessage(chatId, text, inlineButtons) {
  if (!BOT_TOKEN) return { ok: false, error: 'Missing BOT_TOKEN env' };
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: String(chatId),
    text: String(text),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  // default inline buttons: Explore QueueJoy (url) + status/unsubscribe callbacks
  const exploreButton = [{ text: '👉 Explore QueueJoy', url: 'https://helloqueuejoy.netlify.app' }];
  const controlRow = [
    { text: 'ℹ️ Status', callback_data: '/status' },
    { text: '✖️ Unsubscribe', callback_data: '/unsubscribe' },
  ];
  body.reply_markup = { inline_keyboard: [exploreButton, controlRow] };
  if (Array.isArray(inlineButtons) && inlineButtons.length) {
    // if caller provided custom inline buttons, replace first row (useful for A/B tests)
    body.reply_markup.inline_keyboard = inlineButtons.concat([controlRow]);
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

  const calledFull = String(payload.calledFull || '').trim();
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
    const theirNumber = (r?.theirNumber || r?.number || r?.recipientFull || r?.fullNumber || '').toString();
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

    // Compose messages exactly as user requested (logical version):
    // REMINDER for everyone else in same series, always sent.
    // IT'S YOUR TURN for exact match.
    let text;
    if (isMatch) {
      ticket.calledAt = nowIso();
      ticket.servedAt = nowIso(); // we mark served
      text = `🎯 Dear customer,\n\nYour number <b>${calledFull}</b> has been called. Please proceed to <b>${counterName || 'the counter'}</b> at your convenience. Thank you.\n\nCurious how this works? Tap 👉 "Explore QueueJoy" below to see tools your shop can use to keep customers happy.`;
    } else {
      // Reminder message — every time someone in front is called we remind those behind
      ticket.calledAt = ticket.calledAt || nowIso();
      ticket.notifiedStayAt = nowIso();
      text = `🔔 REMINDER\nNumber <b>${calledFull}</b> was called. Your number is <b>${theirNumber}</b>. We'll notify you again when it's your turn.`;
    }

    // persist ticket
    if (useRedis) {
      await redisSet(`ticket:${key}`, ticket);
    } else {
      store.tickets = store.tickets || {};
      store.tickets[key] = ticket;
      await saveStore(store);
    }

    // If served, update stats and remove active ticket
    let statUpdate = null;
    if (ticket.servedAt) {
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
      } else {
        store.stats = store.stats || {};
        stats = store.stats[ticket.series] || { totalServed: 0, totalServiceMs: 0, lastServedAt: null };
        stats.totalServed = (stats.totalServed || 0) + 1;
        stats.totalServiceMs = (stats.totalServiceMs || 0) + serviceMs;
        stats.lastServedAt = ticket.servedAt;
        store.stats[ticket.series] = stats;
        await saveStore(store);
      }

      // remove active ticket (clean up)
      if (useRedis) {
        await redisDel(`ticket:${key}`);
      } else {
        delete store.tickets[key];
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

    // Send the message via Telegram
    const sendRes = await tgSendMessage(chatId, text);
    results.push({
      chatId,
      theirNumber,
      ticketKey: key,
      action: isMatch ? 'served' : 'reminder',
      sendRes,
      statUpdate,
    });
  }

  // Prepare stats snapshot for calledSeries
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

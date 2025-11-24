// netlify/functions/notifyCounter.js
// POST JSON body:
// {
//   "calledFull": "VANILLA002",
//   "counterName": "COUNTER ICE CREAM VANILLA",
//   "recipients": [
//     { "chatId": "123456", "theirNumber": "VANILLA002", "ticketId": "t-abc", "createdAt": "2025-11-19T14:00:00Z" }
//   ]
// }
// Envs:
//  - BOT_TOKEN (required)
//  - REDIS_URL (optional)
// Notes:
//  - If REDIS_URL set -> uses Redis (ioredis). Install ioredis in package.json.
//  - Else -> uses ephemeral JSON file in /tmp (not durable across cold starts).

const fetch = globalThis.fetch || require('node-fetch');
const fs = require('fs');

const REDIS_URL = process.env.REDIS_URL || null;
let RedisClient = null;
let useRedis = false;
if (REDIS_URL) {
  try {
    const IORedis = require('ioredis');
    RedisClient = new IORedis(REDIS_URL);
    useRedis = true;
  } catch (e) {
    console.warn('ioredis not available or failed to connect; falling back to ephemeral store.', e.message);
    useRedis = false;
    RedisClient = null;
  }
}

const TMP_STORE = '/tmp/queuejoy_store.json';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

function nowIso() { return new Date().toISOString(); }
function formatDurationMs(ms) {
  if (ms == null || isNaN(ms)) return '-';
  ms = Math.max(0, Math.round(ms));
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const remS = s % 60;
  return `${m}m ${remS}s`;
}
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

// ephemeral store helpers
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

// redis helpers
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

const BOT_TOKEN = process.env.BOT_TOKEN || null;
const EXPLORE_URL = 'https://helloqueuejoy.netlify.app';

if (!BOT_TOKEN) {
  console.warn('Missing BOT_TOKEN env — this function will return 500 for POST requests until set.');
}

async function tgSendMessage(chatId, text, reply_markup) {
  if (!BOT_TOKEN) {
    return { ok: false, error: 'Missing BOT_TOKEN env' };
  }
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: String(chatId),
    text: String(text),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (reply_markup) body.reply_markup = reply_markup;
  else {
    // Both "status" and "help" buttons now go to the Explore URL per request.
    body.reply_markup = {
      inline_keyboard: [
        [{ text: '🔎 Explore QueueJoy', url: EXPLORE_URL }, { text: 'Open QueueJoy', url: EXPLORE_URL }],
      ],
    };
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

  // normalize recipients and dedupe by chatId (one message per chat)
  const dedupe = new Map();
  for (const r of rawRecipients) {
    const chatId = r?.chatId || r?.chat_id || r?.id;
    if (!chatId) continue;
    const theirNumber = (r?.theirNumber || r?.number || r?.recipientFull || r?.fullNumber || '').toString();
    const ticketId = r?.ticketId || r?.ticket || null;
    const recipientSeries = seriesOf(theirNumber);
    if (!recipientSeries) continue;
    if (recipientSeries !== calledSeries) continue;

    const key = String(chatId);
    const existing = dedupe.get(key);
    if (!existing) dedupe.set(key, { chatId: key, theirNumber, ticketId, createdAt: r?.createdAt || null });
    else {
      // prefer a recipient entry that exactly matches the called number
      const existingMatches = existing.theirNumber && existing.theirNumber.toLowerCase() === calledFull.toLowerCase();
      const thisMatches = theirNumber && theirNumber.toLowerCase() === calledFull.toLowerCase();
      if (!existingMatches && thisMatches) {
        dedupe.set(key, { chatId: key, theirNumber, ticketId, createdAt: r?.createdAt || null });
      }
    }
  }

  if (!dedupe.size) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, calledFull, calledSeries, counterName, sent: 0, message: 'No recipients in same series' }) };
  }

  const results = [];

  for (const [chatId, item] of dedupe.entries()) {
    const theirNumber = item.theirNumber || '';
    const ticketId = item.ticketId || null;
    const key = ticketKeyFor({ ticketId, chatId, theirNumber });

    // load ticket record
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
    let text;

    if (isMatch) {
      ticket.calledAt = nowIso();
      ticket.servedAt = nowIso();
      // match (it's your turn)
      text = `🎯 <b>Number ${calledFull} — it’s your turn!</b>\nPlease go to${counterName ? ' ' + counterName : ' the counter'} now. Open QueueJoy: <a href="${EXPLORE_URL}">${EXPLORE_URL}</a>`;
    } else {
      // stay tuned reminder phrasing requested by you:
      // "Number A001 has called — your number is A004. Stay tuned"
      ticket.calledAt = ticket.calledAt || nowIso();
      ticket.notifiedStayAt = nowIso();
      text = `🔔 <b>Heads-up</b>\nNumber <b>${calledFull}</b> has been called. Your number is <b>${theirNumber}</b>. <i>Stay tuned</i> — we’ll notify you when it’s your turn.\nOpen QueueJoy: <a href="${EXPLORE_URL}">${EXPLORE_URL}</a>`;
    }

    // persist ticket
    if (useRedis) {
      await redisSet(`ticket:${key}`, ticket);
    } else {
      store.tickets = store.tickets || {};
      store.tickets[key] = ticket;
      await saveStore(store);
    }

    // if served, update stats and remove active ticket
    let statUpdate = null;
    if (ticket.servedAt) {
      const createdMs = (new Date(ticket.createdAt)).getTime();
      const servedMs = (new Date(ticket.servedAt)).getTime();
      const serviceMs = Math.max(0, servedMs - (isNaN(createdMs) ? servedMs : createdMs));
      const statKey = `stats:${ticket.series}`;

      let stats = null;
      if (useRedis) {
        stats = (await redisGet(statKey)) || { totalServed: 0, totalServiceMs: 0, lastServedAt: null };
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

      // clean active ticket
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
        avgFormatted: formatDurationMs(Math.round((stats.totalServiceMs || 0) / (stats.totalServed || 1))),
        lastServedAt: stats.lastServedAt,
        lastServiceMs: serviceMs,
        lastServiceFormatted: formatDurationMs(serviceMs),
      };
    }

    // send telegram message
    const sendRes = await tgSendMessage(chatId, text);
    results.push({
      chatId,
      theirNumber,
      ticketKey: key,
      action: isMatch ? 'served' : 'notified',
      sendRes,
      statUpdate,
    });
  }

  // build stats snapshot for admin/debug
  let statsSnapshot = null;
  if (useRedis) {
    try {
      const s = await redisGet(`stats:${calledSeries}`);
      if (s) statsSnapshot = {
        series: calledSeries,
        totalServed: s.totalServed || 0,
        avgServiceMs: s.totalServed ? Math.round((s.totalServiceMs || 0) / s.totalServed) : null,
        avgFormatted: s.totalServed ? formatDurationMs(Math.round((s.totalServiceMs || 0) / s.totalServed)) : '-',
        lastServedAt: s.lastServedAt || null,
      };
    } catch (e) { /* ignore */ }
  } else {
    statsSnapshot = store.stats && store.stats[calledSeries] ? {
      series: calledSeries,
      totalServed: store.stats[calledSeries].totalServed || 0,
      avgServiceMs: (store.stats[calledSeries].totalServed ? Math.round(store.stats[calledSeries].totalServiceMs / store.stats[calledSeries].totalServed) : null),
      avgFormatted: (store.stats[calledSeries].totalServed ? formatDurationMs(Math.round(store.stats[calledSeries].totalServiceMs / store.stats[calledSeries].totalServed)) : '-'),
      lastServedAt: store.stats[calledSeries].lastServedAt || null,
    } : { series: calledSeries, totalServed: 0, avgServiceMs: null, avgFormatted: '-', lastServedAt: null };
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

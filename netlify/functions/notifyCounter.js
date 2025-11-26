// netlify/functions/notifyCounter.js
// Robust, fixed version: cleans numbers, only reminds people behind the called number,
// avoids duplicate reminders for same call, removes ticket when served.
// Envs: BOT_TOKEN (required), REDIS_URL (optional)

const fetch = globalThis.fetch || require('node-fetch');
const fs = require('fs');

const REDIS_URL = process.env.REDIS_URL || null;
let useRedis = false;
let RedisClient = null;
if (REDIS_URL) {
  try {
    const IORedis = require('ioredis');
    RedisClient = new IORedis(REDIS_URL);
    useRedis = true;
  } catch (e) {
    console.warn('ioredis unavailable, falling back to ephemeral store:', e.message);
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

// Strong normalization: remove spaces, remove non allowed chars, uppercase
function normalizeNumber(n) {
  if (n === undefined || n === null) return '';
  return String(n)
    .trim()
    .replace(/\s+/g, '')                // remove spaces
    .replace(/[^A-Za-z0-9\-\_\.]/g, '') // keep letters, digits, -, _, .
    .toUpperCase();
}

// Parse normalized number into prefix + numeric suffix (if any)
// e.g. COFFEE014 -> { prefix: 'COFFEE', num: 14, raw: 'COFFEE014' }
// returns num = null when there's no trailing digits
function parseNumber(raw) {
  const s = normalizeNumber(raw);
  const m = s.match(/^([A-Z\-\_\.]+)?0*([0-9]+)$/i); // prefix optional, numeric suffix with leading zeros trimmed
  if (m) {
    const prefix = (m[1] || '').toUpperCase() || '';
    const num = parseInt(m[2], 10);
    return { prefix, num, raw: s };
  }
  // fallback: maybe letters-only or mixed; try to split letters then digits
  const parts = s.split(/(\d+)/).filter(Boolean);
  if (parts.length >= 2) {
    const prefix = (parts[0] || '').toUpperCase();
    const digits = parts[1].replace(/^0+/, '') || '0';
    const num = parseInt(digits, 10);
    return { prefix, num, raw: s };
  }
  // no numeric suffix
  return { prefix: s.toUpperCase(), num: null, raw: s };
}

function seriesOf(numberStr) {
  if (!numberStr) return '';
  const p = parseNumber(numberStr);
  return (p.prefix || '').toUpperCase();
}

function ticketKeyFor({ ticketId, chatId, theirNumber }) {
  if (ticketId) return String(ticketId);
  return `${String(chatId)}|${normalizeNumber(theirNumber)}`;
}

// Redis helpers
async function redisGet(key) {
  if (!RedisClient) return null;
  try {
    const v = await RedisClient.get(key);
    return v ? JSON.parse(v) : null;
  } catch (e) { console.warn('redisGet error', e.message); return null; }
}
async function redisSet(key, val) {
  if (!RedisClient) return;
  try { await RedisClient.set(key, JSON.stringify(val)); } catch (e) { console.warn('redisSet error', e.message); }
}
async function redisDel(key) {
  if (!RedisClient) return;
  try { await RedisClient.del(key); } catch (e) { console.warn('redisDel error', e.message); }
}

// Ephemeral file store helpers
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
  try { fs.writeFileSync(TMP_STORE, JSON.stringify(obj), 'utf8'); } catch (e) { console.warn('saveStore error', e.message); }
}

// Telegram helper: ONLY Explore QueueJoy button
async function tgSendMessage(chatId, text, extraRows = []) {
  if (!BOT_TOKEN) return { ok: false, error: 'Missing BOT_TOKEN env' };
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: String(chatId),
    text: String(text),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  const exploreRow = [{ text: '👉 Explore QueueJoy', url: 'https://helloqueuejoy.netlify.app' }];
  body.reply_markup = { inline_keyboard: [exploreRow] };
  if (Array.isArray(extraRows) && extraRows.length) {
    body.reply_markup.inline_keyboard = [exploreRow].concat(extraRows);
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
  } catch (err) { return { ok: false, error: String(err) }; }
}

// Main handler
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Only POST allowed' }) };
  if (!BOT_TOKEN) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing BOT_TOKEN env' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const calledFullRaw = String(payload.calledFull || '').trim();
  const calledFull = normalizeNumber(calledFullRaw);
  const calledParsed = parseNumber(calledFull);
  const counterName = payload.counterName ? String(payload.counterName).trim() : '';
  const rawRecipients = Array.isArray(payload.recipients) ? payload.recipients : [];

  if (!calledFull) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'calledFull is required' }) };
  }

  const calledSeries = seriesOf(calledFull);
  // load ephemeral store if needed
  let store = null;
  if (!useRedis) store = await loadStore();

  // Normalize recipients and dedupe by chatId
  const dedupe = new Map();
  for (const r of rawRecipients) {
    const chatId = r?.chatId || r?.chat_id || r?.id;
    if (!chatId) continue;
    const theirNumberRaw = (r?.theirNumber || r?.number || r?.recipientFull || r?.fullNumber || '');
    const theirNumber = normalizeNumber(theirNumberRaw);
    if (!theirNumber) continue;
    const recipientSeries = seriesOf(theirNumber);
    if (!recipientSeries) continue;
    if (recipientSeries !== calledSeries) continue; // only same series

    const ticketId = r?.ticketId || r?.ticket || null;
    const key = String(chatId);
    const existing = dedupe.get(key);
    if (!existing) {
      dedupe.set(key, { chatId: key, theirNumber, ticketId, createdAt: r?.createdAt || null });
    } else {
      // prefer exact match if multiple for same chat
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

    // load ticket
    let ticket = null;
    if (useRedis) {
      ticket = await redisGet(`ticket:${key}`);
    } else {
      ticket = (store.tickets && store.tickets[key]) ? store.tickets[key] : null;
    }

    // if ticket already served, skip
    if (ticket && ticket.servedAt) {
      results.push({ chatId, theirNumber, ticketKey: key, action: 'skipped-already-served' });
      continue;
    }

    // create if missing
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
        lastNotifiedForCalled: null, // avoid re-sending for same calledFull
      };
    }

    const isMatch = theirNumber && theirNumber.toLowerCase() === calledFull.toLowerCase();

    // If we've already notified this ticket for this exact calledFull, skip (prevents duplicate notifications)
    if (!isMatch && ticket.lastNotifiedForCalled && ticket.lastNotifiedForCalled === calledFull) {
      results.push({ chatId, theirNumber, ticketKey: key, action: 'skipped-duplicate-for-same-call', calledFull });
      continue;
    }

    // Reminder send rule:
    // - If exact match -> send "It's your turn" (serve & remove)
    // - Else if both called and their numbers have numeric suffixes -> send reminder ONLY if theirNum > calledNum (they are behind)
    // - Else (no numeric info) -> send reminder (legacy fallback)
    const theirParsed = parseNumber(theirNumber);
    let shouldSendReminder = false;
    if (isMatch) {
      shouldSendReminder = true;
    } else {
      if (calledParsed.num !== null && theirParsed.num !== null) {
        // numeric compare
        shouldSendReminder = theirParsed.num > calledParsed.num;
      } else {
        // fallback when numeric parts not available: send reminder (old behavior)
        shouldSendReminder = true;
      }
    }

    if (!shouldSendReminder) {
      // do not send; persist ticket (no change) and continue
      // but update ticket in store to be safe (no side-effects)
      if (useRedis) await redisSet(`ticket:${key}`, ticket);
      else { store.tickets = store.tickets || {}; store.tickets[key] = ticket; await saveStore(store); }
      results.push({ chatId, theirNumber, ticketKey: key, action: 'skipped-not-behind', reason: 'their number is not behind the called number' });
      continue;
    }

    // Compose message with uniform suffix
    const exploreSuffix = '\n\nCurious how this works? Tap 👉 "Explore QueueJoy" below to see tools your shop can use to keep customers happy.';
    let text;
    if (isMatch) {
      ticket.calledAt = nowIso();
      ticket.servedAt = nowIso();
      text = `🎯 Dear customer,\n\nYour number <b>${calledFull}</b> has been called. Please proceed to <b>${counterName || 'the counter'}</b> at your convenience. Thank you.${exploreSuffix}`;
    } else {
      ticket.calledAt = ticket.calledAt || nowIso();
      ticket.notifiedStayAt = nowIso();
      ticket.lastNotifiedForCalled = calledFull; // mark so we don't re-notify for same call
      text = `🔔 REMINDER\nNumber <b>${calledFull}</b> was called. Your number is <b>${theirNumber}</b>. We'll notify you again when it's your turn.${exploreSuffix}`;
    }

    // persist ticket pre-send
    if (useRedis) await redisSet(`ticket:${key}`, ticket);
    else { store.tickets = store.tickets || {}; store.tickets[key] = ticket; await saveStore(store); }

    // send
    let sendRes;
    try { sendRes = await tgSendMessage(chatId, text); } catch (e) { sendRes = { ok: false, error: String(e) }; }

    // If exact match -> update stats and remove active ticket
    let statUpdate = null;
    if (isMatch && ticket.servedAt) {
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
        await redisDel(`ticket:${key}`);
      } else {
        store.stats = store.stats || {};
        stats = store.stats[ticket.series] || { totalServed: 0, totalServiceMs: 0, lastServedAt: null };
        stats.totalServed = (stats.totalServed || 0) + 1;
        stats.totalServiceMs = (stats.totalServiceMs || 0) + serviceMs;
        stats.lastServedAt = ticket.servedAt;
        store.stats[ticket.series] = stats;
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

    results.push({ chatId, theirNumber, ticketKey: key, action: isMatch ? 'served' : 'reminder', sendRes, statUpdate });
  }

  // stats snapshot
  let statsSnapshot = null;
  if (useRedis) {
    try {
      const s = await redisGet(`stats:${calledSeries}`);
      statsSnapshot = s || { series: calledSeries, totalServed: 0 };
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

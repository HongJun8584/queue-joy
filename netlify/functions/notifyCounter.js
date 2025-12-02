// netlify/functions/notifyCounter.js
'use strict';

// NOTE: this function expects these env vars:
// BOT_TOKEN, DATABASE_URL, REDIS_URL (optional)
// Example DATABASE_URL: https://...firebaseio.com (no trailing slash)

const fetch = globalThis.fetch || require('node-fetch');
const fs = require('fs');
const path = require('path');

const REDIS_URL = process.env.REDIS_URL || null;
let useRedis = false;
let RedisClient = null;
if (REDIS_URL) {
  try {
    const IORedis = require('ioredis');
    RedisClient = new IORedis(REDIS_URL);
    useRedis = true;
  } catch (e) {
    console.warn('ioredis not available, falling back to ephemeral store:', e.message);
    useRedis = false;
    RedisClient = null;
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN || null;
const DATABASE_URL = (process.env.DATABASE_URL || '').replace(/\/$/, '');
const TMP_STORE = '/tmp/queuejoy_store.json';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const MOVING_AVG_COUNT = 10;
const CONCURRENCY = Number(process.env.NOTIFY_CONCURRENCY || 12); // parallel Telegram sends

// ---------- utilities ----------
const nowMs = () => Date.now();
const nowIso = () => new Date().toISOString();

function safeJsonParse(s, fallback = null) {
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

function normalizeNumber(n) {
  if (n === undefined || n === null) return '';
  let s = String(n).trim();
  s = s.replace(/[\s\/\\]+/g, '-');
  s = s.replace(/[^A-Za-z0-9\-_.]/g, '');
  s = s.replace(/[-_.]{2,}/g, (m) => m[0]);
  return s.toUpperCase();
}
function seriesOf(n) {
  const cleaned = normalizeNumber(n);
  if (!cleaned) return '';
  const m = cleaned.match(/^([A-Z\-_.]+)(\d.*)?$/i);
  if (m) return (m[1] || '').toUpperCase();
  const parts = cleaned.split(/(\d+)/).filter(Boolean);
  return (parts[0] || '').toUpperCase();
}
function numericSuffix(s) {
  if (!s) return NaN;
  const m = String(s).match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : NaN;
}
function isBehindCalled(theirNumber, calledNumber) {
  const t = normalizeNumber(theirNumber);
  const c = normalizeNumber(calledNumber);
  if (!t || !c) return false;
  const seriesT = seriesOf(t);
  const seriesC = seriesOf(c);
  if (seriesT !== seriesC) return false;
  const tn = numericSuffix(t);
  const cn = numericSuffix(c);
  if (!isNaN(tn) && !isNaN(cn)) return tn > cn;
  // fallback lexicographic tail compare
  const tailT = t.slice(seriesT.length) || t;
  const tailC = c.slice(seriesC.length) || c;
  return tailT > tailC;
}
function ticketKeyFor({ ticketId, chatId, theirNumber }) {
  if (ticketId) return String(ticketId);
  return `${String(chatId || 'null')}|${normalizeNumber(theirNumber)}`;
}

// ---------- store helpers ----------
async function loadStore() {
  if (useRedis) return null;
  try {
    if (fs.existsSync(TMP_STORE)) {
      const raw = fs.readFileSync(TMP_STORE, 'utf8') || '{}';
      return safeJsonParse(raw, { tickets: {}, stats: {} });
    }
  } catch (e) { console.warn('loadStore', e.message); }
  return { tickets: {}, stats: {} };
}
async function saveStore(obj) {
  if (useRedis) return;
  try {
    fs.writeFileSync(TMP_STORE, JSON.stringify(obj));
  } catch (e) { console.warn('saveStore', e.message); }
}
async function redisGet(key) {
  if (!RedisClient) return null;
  try {
    const v = await RedisClient.get(key);
    return v ? JSON.parse(v) : null;
  } catch (e) { console.warn('redisGet', e.message); return null; }
}
async function redisSet(key, val) {
  if (!RedisClient) return;
  try { await RedisClient.set(key, JSON.stringify(val)); } catch (e) { console.warn('redisSet', e.message); }
}

// ---------- Firebase query helpers ----------
async function fetchQueueForSeries(series) {
  if (!DATABASE_URL) return {};
  try {
    // orderBy param must be quoted for RTDB REST
    const url = `${DATABASE_URL}/queue.json?orderBy=${encodeURIComponent('"series"')}&equalTo=${encodeURIComponent('"' + series + '"')}`;
    const res = await fetch(url);
    if (!res.ok) { console.warn('fetchQueueForSeries failed', res.status); return {}; }
    const j = await res.json().catch(()=>null);
    return j || {};
  } catch (e) {
    console.warn('fetchQueueForSeries', e.message);
    return {};
  }
}
async function fetchQueueAll() {
  if (!DATABASE_URL) return {};
  try {
    const res = await fetch(`${DATABASE_URL}/queue.json`);
    if (!res.ok) { console.warn('fetchQueueAll failed', res.status); return {}; }
    const j = await res.json().catch(()=>null);
    return j || {};
  } catch (e) {
    console.warn('fetchQueueAll', e.message);
    return {};
  }
}

// ---------- Telegram ----------
function tgPrepareMessage(chatId, text, inlineButtons = []) {
  const inline = (Array.isArray(inlineButtons) && inlineButtons.length) ? inlineButtons : [];
  // default 'Explore QueueJoy' CTA
  const kb = [[{ text: '👉 Explore QueueJoy', url: 'https://helloqueuejoy.netlify.app' }]];
  if (inline.length) kb.push(...inline);
  return {
    url: `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: String(chatId),
        text: String(text),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: kb }
      })
    }
  };
}
async function tgSend(pref) {
  try {
    const res = await fetch(pref.url, pref.options);
    const bodyText = await res.text().catch(()=>null);
    let bodyJson = null;
    try { bodyJson = bodyText ? JSON.parse(bodyText) : null; } catch (e) {}
    return { ok: res.ok, status: res.status, bodyText, bodyJson };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ---------- concurrency runner ----------
async function runWithConcurrency(tasks, concurrency = 8) {
  const results = new Array(tasks.length);
  let i = 0;
  const workers = new Array(Math.min(concurrency, tasks.length)).fill(null).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= tasks.length) break;
      try {
        results[idx] = await tasks[idx]();
      } catch (e) {
        results[idx] = { ok: false, error: String(e) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- analytics push ----------
async function pushServiceEvent(evt) {
  if (!DATABASE_URL) return;
  try {
    await fetch(`${DATABASE_URL}/analytics/serviceEvents.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(evt)
    });
  } catch (e) { console.warn('pushServiceEvent', e.message); }
}

// ---------- Main handler ----------
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Only POST' }) };
  if (!BOT_TOKEN) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing BOT_TOKEN' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const calledFullRaw = String(payload.calledFull || '').trim();
  const calledFull = normalizeNumber(calledFullRaw);
  const counterName = payload.counterName ? String(payload.counterName).trim() : '';
  const inlineButtons = Array.isArray(payload.inlineButtons) ? payload.inlineButtons : [];

  if (!calledFull) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'calledFull required' }) };

  const calledSeries = seriesOf(calledFull);

  // load ephemeral store
  let store = null;
  let storeDirty = false;
  if (!useRedis) store = await loadStore();

  // recipients (prefer payload.recipients)
  let rawRecipients = Array.isArray(payload.recipients) ? payload.recipients.slice() : [];

  // if no recipients provided, preload queue
  let preloadQueue = {};
  if (!rawRecipients.length) {
    if (calledSeries) {
      preloadQueue = await fetchQueueForSeries(calledSeries);
    }
    if (!preloadQueue || Object.keys(preloadQueue).length === 0) {
      preloadQueue = await fetchQueueAll();
    }

    for (const [key, q] of Object.entries(preloadQueue || {})) {
      if (!q) continue;
      // normalize status check
      const st = String(q.status || '').toLowerCase();
      if (st && st !== 'waiting') continue;
      const theirNumber = q.queueId || q.ticket || q.ticketId || q.number || q.queueId;
      if (!theirNumber) continue;
      if (calledSeries && seriesOf(theirNumber) !== calledSeries) continue;
      rawRecipients.push({
        chatId: q.chatId || q.chat_id || null,
        theirNumber,
        ticketId: key,
        createdAt: q.timestamp || q.connectedAt || q.createdAt || null,
        telegramConnected: q.telegramConnected || q.telegram_connected || false,
        queueEntry: q
      });
    }
  }

  // dedupe + normalize recipients
  const dedupe = new Map();
  for (const r of rawRecipients) {
    const chatId = r?.chatId || r?.chat_id || r?.id || null;
    const theirNumberRaw = r?.theirNumber || r?.number || r?.recipientFull || r?.fullNumber || r?.ticketNumber || '';
    const theirNumber = normalizeNumber(theirNumberRaw);
    if (!theirNumber) continue;
    const ticketIdKey = r?.ticketId || r?.queueKey || null;
    const key = ticketKeyFor({ ticketId: ticketIdKey, chatId, theirNumber });
    if (!dedupe.has(key)) {
      dedupe.set(key, {
        chatId: chatId ? String(chatId) : null,
        theirNumber,
        ticketId: ticketIdKey,
        createdAt: r?.createdAt || nowIso(),
        telegramConnected: r?.telegramConnected || false,
        queueEntry: r?.queueEntry || null
      });
    }
  }

  if (!dedupe.size) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, calledFull, calledSeries, sent: 0, message: 'No recipients' }) };
  }

  const now = nowMs();
  const nowISO = nowIso();
  const firebaseUpdates = {};
  const results = [];
  const telegramPrepared = [];
  const telegramResultIndex = [];
  let servedCountInc = 0;
  const redisPromises = [];

  // process recipients (no external fetches inside loop)
  for (const [k, item] of dedupe.entries()) {
    const { theirNumber, ticketId, chatId, queueEntry } = item;
    const ticketKey = ticketId ? String(ticketId) : ticketKeyFor({ ticketId: null, chatId, theirNumber });

    // load persisted ticket (redis or store)
    let ticket = null;
    if (useRedis) {
      try { ticket = await redisGet(`ticket:${ticketKey}`); } catch (e) { ticket = null; }
    } else {
      ticket = (store.tickets && store.tickets[ticketKey]) || null;
    }

    // fallback: build ticket from queueEntry
    if (!ticket) {
      const createdAtRaw = (queueEntry && (queueEntry.connectedAt || queueEntry.createdAt || queueEntry.timestamp)) || item.createdAt || nowISO;
      let createdAtMs = NaN;
      // try numeric timestamp first
      const cand = queueEntry?.timestamp || null;
      if (cand && !isNaN(Number(cand))) {
        createdAtMs = Number(cand) < 1e12 ? Number(cand) * 1000 : Number(cand);
      } else {
        const d = new Date(createdAtRaw);
        createdAtMs = isNaN(d.getTime()) ? Date.now() : d.getTime();
      }

      ticket = {
        ticketKey,
        ticketId: ticketId || null,
        chatId: chatId || null,
        theirNumber,
        series: seriesOf(theirNumber) || calledSeries,
        createdAt: createdAtRaw,
        createdAtMs,
        expiresAt: new Date(now + MAX_AGE_MS).toISOString(),
        notifiedStayAt: null,
        calledAt: null,
        servedAt: null
      };
    } else {
      // ensure createdAtMs normalized
      if (!ticket.createdAtMs) {
        let cand = ticket.createdAt;
        let createdMs = NaN;
        if (typeof cand === 'number') createdMs = cand;
        else if (typeof cand === 'string') {
          const n = Number(cand);
          if (!isNaN(n)) createdMs = n;
          else {
            const d = new Date(cand);
            createdMs = isNaN(d.getTime()) ? NaN : d.getTime();
          }
        }
        if (!isNaN(createdMs) && createdMs < 1e12) createdMs = createdMs * 1000;
        ticket.createdAtMs = !isNaN(createdMs) ? createdMs : Date.now();
      }
    }

    // skip already served
    if (ticket && ticket.servedAt) {
      results.push({ chatId, theirNumber, ticketKey, action: 'skipped-already-served' });
      continue;
    }

    const isMatch = theirNumber === calledFull;
    const behind = !isMatch && isBehindCalled(theirNumber, calledFull);

    if (!isMatch && !behind) {
      results.push({ chatId, theirNumber, ticketKey, action: 'skipped-ahead' });
      continue;
    }

    // stale cancellation for old tickets (only when behind and beyond MAX_AGE_MS)
    const createdMs = ticket.createdAtMs || Date.now();
    const ageMs = now - createdMs;
    if (ageMs > MAX_AGE_MS && !isMatch && ticket.ticketId) {
      firebaseUpdates[`/queue/${ticket.ticketId}/status`] = 'cancelled';
      ticket.expiresAt = new Date(now).toISOString();
      if (useRedis) {
        redisPromises.push(redisSet(`ticket:${ticketKey}`, ticket));
      } else {
        store.tickets = store.tickets || {};
        store.tickets[ticketKey] = ticket;
        storeDirty = true;
      }
      results.push({ chatId, theirNumber, ticketKey, action: 'cancelled-stale' });
      continue;
    }

    // build messages and mark served/reminder
    const exploreSuffix = '\n\nCurious how this works? Tap 👉 "Explore QueueJoy" below to see tools your shop can use to keep customers happy.';
    let text;
    const serviceMs = Math.max(0, now - (ticket.createdAtMs || createdMs || now));
    if (isMatch) {
      // mark served
      ticket.calledAt = nowISO;
      ticket.servedAt = nowISO;
      ticket.servedAtMs = now;
      text = `🎯 Dear customer,\n\nYour number <b>${calledFull}</b> has been called. Please proceed to <b>${counterName || 'the counter'}</b>. Thank you.${exploreSuffix}`;
      if (ticket.ticketId) {
        firebaseUpdates[`/queue/${ticket.ticketId}/status`] = 'served';
        firebaseUpdates[`/queue/${ticket.ticketId}/servedAt`] = now;
        firebaseUpdates[`/queue/${ticket.ticketId}/serviceMs`] = serviceMs;
      }
      // push analytics event (fire-and-forget)
      pushServiceEvent({ ticketId: ticket.ticketId || null, requestedAt: ticket.createdAtMs || createdMs, servedAt: now, serviceMs, counter: counterName || null, series: ticket.series || calledSeries });

      // update series stats in-memory (persisted later)
      const series = ticket.series || calledSeries;
      let sstats = null;
      if (useRedis) {
        sstats = await redisGet(`stats:${series}`) || { totalServed: 0, totalServiceMs: 0, minServiceMs: null, maxServiceMs: null, movingAvgServiceMsLast10: [] };
      } else {
        store.stats = store.stats || {};
        sstats = store.stats[series] || { totalServed: 0, totalServiceMs: 0, minServiceMs: null, maxServiceMs: null, movingAvgServiceMsLast10: [] };
      }
      sstats.totalServed = (sstats.totalServed || 0) + 1;
      sstats.totalServiceMs = (sstats.totalServiceMs || 0) + serviceMs;
      sstats.minServiceMs = (sstats.minServiceMs === null) ? serviceMs : Math.min(sstats.minServiceMs, serviceMs);
      sstats.maxServiceMs = (sstats.maxServiceMs === null) ? serviceMs : Math.max(sstats.maxServiceMs, serviceMs);
      sstats.movingAvgServiceMsLast10 = sstats.movingAvgServiceMsLast10 || [];
      sstats.movingAvgServiceMsLast10.push(serviceMs);
      if (sstats.movingAvgServiceMsLast10.length > MOVING_AVG_COUNT) sstats.movingAvgServiceMsLast10.shift();
      if (useRedis) {
        redisPromises.push(redisSet(`stats:${series}`, sstats));
      } else {
        store.stats = store.stats || {};
        store.stats[series] = sstats;
        storeDirty = true;
      }

      servedCountInc += 1;
    } else {
      // reminder for those behind
      ticket.calledAt = ticket.calledAt || nowISO;
      ticket.notifiedStayAt = nowISO;
      ticket.lastReminderMs = now;
      text = `🔔 REMINDER\nNumber <b>${calledFull}</b> was called. Your number is <b>${theirNumber}</b>. We'll notify you again when it's your turn.${exploreSuffix}`;
      if (ticket.ticketId) {
        firebaseUpdates[`/queue/${ticket.ticketId}/lastReminderAt`] = now;
      }
    }

    // persist ticket entry
    if (useRedis) {
      redisPromises.push(redisSet(`ticket:${ticketKey}`, ticket));
    } else {
      store.tickets = store.tickets || {};
      store.tickets[ticketKey] = ticket;
      storeDirty = true;
    }

    const entryIdx = results.length;
    results.push({ chatId, theirNumber, ticketKey, action: isMatch ? 'served' : 'reminder' });

    if (chatId) {
      const pref = tgPrepareMessage(chatId, text, inlineButtons);
      telegramPrepared.push(pref);
      telegramResultIndex.push(entryIdx);
    } else {
      results[entryIdx].sendRes = { ok: false, reason: 'no-chatId' };
    }
  } // end recipients loop

  // ---------- Send Telegram messages (concurrency-limited) ----------
  if (telegramPrepared.length) {
    const tasks = telegramPrepared.map((pref) => async () => await tgSend(pref));
    const sendResults = await runWithConcurrency(tasks, CONCURRENCY); // returns array aligned to tasks
    for (let i = 0; i < sendResults.length; i++) {
      const resIdx = telegramResultIndex[i];
      results[resIdx].sendRes = sendResults[i];
    }
  }

  // ---------- run redis sets in parallel ----------
  if (redisPromises.length) {
    try {
      await Promise.allSettled(redisPromises);
    } catch (e) { console.warn('redis batch failed', e.message); }
  }

  // ---------- batch Firebase updates ----------
  if (Object.keys(firebaseUpdates).length > 0 && DATABASE_URL) {
    try {
      // get current servedCount to increment reliably
      let currentServed = 0;
      if (servedCountInc > 0) {
        try {
          const r = await fetch(`${DATABASE_URL}/analytics/servedCount.json`);
          if (r.ok) currentServed = await r.json() || 0;
        } catch (e) { console.warn('servedCount read failed', e.message); }
        firebaseUpdates['/analytics/servedCount'] = currentServed + servedCountInc;
      }
      // PATCH root with multiple updates
      await fetch(`${DATABASE_URL}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(firebaseUpdates)
      });
    } catch (e) {
      console.warn('Firebase batch update failed', e.message);
    }
  }

  // ---------- final ephemeral store write ----------
  if (!useRedis && storeDirty) {
    try { await saveStore(store); } catch (e) { console.warn('final saveStore failed', e.message); }
  }

  // ---------- build stats snapshot ----------
  const statsSnapshot = { series: calledSeries, totalServed: 0, totalServiceMs: 0, minServiceMs: null, maxServiceMs: null, movingAvgServiceMsLast10: 0 };
  try {
    if (useRedis) {
      const s = await redisGet(`stats:${calledSeries}`);
      if (s) {
        statsSnapshot.totalServed = s.totalServed || 0;
        statsSnapshot.totalServiceMs = s.totalServiceMs || 0;
        statsSnapshot.minServiceMs = s.minServiceMs || null;
        statsSnapshot.maxServiceMs = s.maxServiceMs || null;
        statsSnapshot.movingAvgServiceMsLast10 = (s.movingAvgServiceMsLast10 && s.movingAvgServiceMsLast10.length)
          ? Math.round(s.movingAvgServiceMsLast10.reduce((a,b)=>a+b,0) / s.movingAvgServiceMsLast10.length)
          : 0;
      } else {
        const r = await fetch(`${DATABASE_URL}/analytics/servedCount.json`);
        statsSnapshot.totalServed = (r.ok ? await r.json() : 0) || 0;
      }
    } else {
      store.stats = store.stats || {};
      const s = store.stats[calledSeries];
      if (s) {
        statsSnapshot.totalServed = s.totalServed || 0;
        statsSnapshot.totalServiceMs = s.totalServiceMs || 0;
        statsSnapshot.minServiceMs = s.minServiceMs || null;
        statsSnapshot.maxServiceMs = s.maxServiceMs || null;
        statsSnapshot.movingAvgServiceMsLast10 = (s.movingAvgServiceMsLast10 && s.movingAvgServiceMsLast10.length)
          ? Math.round(s.movingAvgServiceMsLast10.reduce((a,b)=>a+b,0) / s.movingAvgServiceMsLast10.length)
          : 0;
      } else {
        const r = await fetch(`${DATABASE_URL}/analytics/servedCount.json`);
        statsSnapshot.totalServed = (r.ok ? await r.json() : 0) || 0;
      }
    }
  } catch (e) { console.warn('statsSnapshot', e.message); }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      ok: true,
      calledFull,
      calledSeries,
      counterName,
      sent: results.filter(r => r && r.sendRes).length,
      results,
      statsSnapshot,
      persistence: useRedis ? 'redis' : 'ephemeral-file'
    })
  };
};

// netlify/functions/notifyCounter.js
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
    console.warn('ioredis not available, falling back to ephemeral store:', e.message);
    useRedis = false;
    RedisClient = null;
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN || null;
const DATABASE_URL = (process.env.DATABASE_URL || "https://queue-joy-aa21b-default-rtdb.asia-southeast1.firebasedatabase.app").replace(/\/$/,'');
const TMP_STORE = '/tmp/queuejoy_store.json';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

const MAX_AGE_MS = 24*60*60*1000; // 24h
const MOVING_AVG_COUNT = 10; // for last N tickets

// ---------- Helpers ----------
const nowIso = () => new Date().toISOString();
const nowMs = () => Date.now();

// stronger normalize: remove extra whitespace, unify separators, uppercase.
const normalizeNumber = n => {
  if (n === undefined || n === null) return '';
  let s = String(n);
  s = s.trim();
  s = s.replace(/[\s\/\\]+/g,'-');
  s = s.replace(/[^A-Za-z0-9\-_.]/g,'');
  s = s.replace(/[-_.]{2,}/g, m => m[0]);
  return s.toUpperCase();
};
const seriesOf = n => {
  const cleaned = normalizeNumber(n);
  if(!cleaned) return '';
  const m = cleaned.match(/^([A-Z\-_.]+)(\d.*)?$/i);
  if (m) return (m[1]||'').toUpperCase();
  const parts = cleaned.split(/(\d+)/).filter(Boolean);
  return (parts[0]||'').toUpperCase();
};
const numericSuffix = s => {
  if (!s) return NaN;
  const m = String(s).match(/(\d+)$/);
  return m ? parseInt(m[1],10) : NaN;
};
const isBehindCalled = (theirNumber, calledNumber) => {
  const t = normalizeNumber(theirNumber);
  const c = normalizeNumber(calledNumber);
  if(!t || !c) return false;
  const seriesT = seriesOf(t);
  const seriesC = seriesOf(c);
  if (seriesT !== seriesC) return false;
  const tn = numericSuffix(t);
  const cn = numericSuffix(c);
  if (!isNaN(tn) && !isNaN(cn)) return tn > cn;
  const tailT = t.slice(seriesT.length) || t;
  const tailC = c.slice(seriesC.length) || c;
  return tailT > tailC;
};
const ticketKeyFor = ({ticketId, chatId, theirNumber}) => ticketId ? String(ticketId) : `${String(chatId)}|${normalizeNumber(theirNumber)}`;

// ---------- Store Helpers ----------
async function loadStore() {
  if (useRedis) return null;
  try {
    if (fs.existsSync(TMP_STORE)) return JSON.parse(fs.readFileSync(TMP_STORE,'utf8')||'{"tickets":{},"stats":{}}');
  } catch(e){console.warn('loadStore',e.message);}
  return {tickets:{}, stats:{}}; 
}
async function saveStore(obj){
  if(useRedis) return;
  try{ fs.writeFileSync(TMP_STORE, JSON.stringify(obj), 'utf8'); } catch(e){ console.warn('saveStore',e.message);} 
}
async function redisGet(key){ if(!RedisClient) return null; try { const v = await RedisClient.get(key); return v?JSON.parse(v):null;} catch(e){console.warn('redisGet',e.message); return null;} }
async function redisSet(key,val){ if(!RedisClient) return; try{ await RedisClient.set(key,JSON.stringify(val)); } catch(e){console.warn('redisSet',e.message);} }
async function redisDel(key){ if(!RedisClient) return; try{ await RedisClient.del(key);} catch(e){console.warn('redisDel',e.message);} }

// ---------- Telegram ----------
async function tgSendMessage(chatId,text,inlineButtons=[]){
  if(!BOT_TOKEN) return {ok:false,error:'Missing BOT_TOKEN'};
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const exploreBtn = [{text:'👉 Explore QueueJoy',url:'https://helloqueuejoy.netlify.app'}];
  const body = {
    chat_id: String(chatId),
    text: String(text),
    parse_mode:'HTML',
    disable_web_page_preview:true,
    reply_markup:{inline_keyboard:[exploreBtn].concat(inlineButtons)}
  };
  try {
    const res = await fetch(url,{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'}});
    const textResp = await res.text().catch(()=>null);
    let json = null; try{ json = textResp?JSON.parse(textResp):null;}catch(e){}
    return {ok:res.ok,status:res.status,bodyText:textResp,bodyJson:json};
  } catch(err){ return {ok:false,error:String(err)}; }
}

// ---------- Stats helpers ----------
async function loadSeriesStats(series, store){
  if(useRedis){
    const s = await redisGet(`stats:${series}`);
    if(s) return s;
    return { totalServed:0, totalServiceMs:0, minServiceMs:null, maxServiceMs:null, movingAvgServiceMsLast10:[] };
  } else {
    store.stats = store.stats || {};
    return store.stats[series] || { totalServed:0, totalServiceMs:0, minServiceMs:null, maxServiceMs:null, movingAvgServiceMsLast10:[] };
  }
}
async function saveSeriesStats(series, stats, store){
  if(useRedis){
    await redisSet(`stats:${series}`, stats);
  } else {
    store.stats = store.stats || {};
    store.stats[series] = stats;
    await saveStore(store);
  }
}

// ---------- Helper to fetch /queue from Firebase ----------
async function fetchQueue() {
  try {
    const res = await fetch(`${DATABASE_URL}/queue.json`);
    if(!res.ok) {
      console.warn('fetchQueue failed', res.status);
      return {};
    }
    const data = await res.json() || {};
    return data;
  } catch(e) {
    console.warn('fetchQueue error', e.message);
    return {};
  }
}

// ---------- Helper: push service event to analytics/serviceEvents ----------
async function pushServiceEvent(evt) {
  try {
    await fetch(`${DATABASE_URL}/analytics/serviceEvents.json`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(evt)
    });
  } catch(e) { console.warn('pushServiceEvent', e.message); }
}

// ---------- Main ----------
exports.handler = async function(event){
  if(event.httpMethod==='OPTIONS') return {statusCode:204,headers:CORS,body:''};
  if(event.httpMethod!=='POST') return {statusCode:405,headers:CORS,body:JSON.stringify({error:'Only POST'})};
  if(!BOT_TOKEN) return {statusCode:500,headers:CORS,body:JSON.stringify({error:'Missing BOT_TOKEN'})};

  let payload;
  try { payload = JSON.parse(event.body||'{}'); } catch(e){ return {statusCode:400,headers:CORS,body:JSON.stringify({error:'Invalid JSON'})}; }

  const calledFullRaw = String(payload.calledFull||'').trim();
  const calledFull = normalizeNumber(calledFullRaw);
  const counterName = payload.counterName?String(payload.counterName).trim():'';
  const inlineButtons = Array.isArray(payload.inlineButtons)?payload.inlineButtons:[];

  if(!calledFull) return {statusCode:400,headers:CORS,body:JSON.stringify({error:'calledFull required'})};

  const calledSeries = seriesOf(calledFull);

  // load ephemeral store if needed
  let store = null;
  if(!useRedis) store = await loadStore();

  // Build recipients list:
  // Priority: payload.recipients (if provided and non-empty) else fetch /queue and build recipients from waiting items in same series
  let rawRecipients = Array.isArray(payload.recipients) ? payload.recipients.slice() : [];

  if(!rawRecipients.length){
    const queue = await fetchQueue(); // object keyed by firebase queue key
    for(const [key, q] of Object.entries(queue || {})){
      if(!q) continue;
      if (q.status !== 'waiting') continue;
      // determine the number / queue id field - commonly "queueId" or "ticket" or "number"
      const theirNumber = q.queueId || q.ticketId || q.number || q.queueId;
      if(!theirNumber) continue;
      // only include same series
      if (seriesOf(theirNumber) !== calledSeries) continue;
      rawRecipients.push({
        chatId: q.chatId || q.chat_id || null,
        theirNumber: theirNumber,
        ticketId: key,
        createdAt: q.timestamp || q.connectedAt || q.createdAt || null,
        telegramConnected: q.telegramConnected || q.telegram_connected || false
      });
    }
  }

  // dedupe normalized recipients (same logic as before)
  const dedupe = new Map();
  for(const r of rawRecipients){
    const chatId = r?.chatId||r?.chat_id||r?.id||null;
    const theirNumber = normalizeNumber(r?.theirNumber||r?.number||r?.recipientFull||r?.fullNumber||r?.ticketNumber||'');
    if(!theirNumber) continue;
    const ticketIdKey = r?.ticketId || r?.queueKey || null; // firebase key
    // we will include recipients even if chatId missing (so analytics still update) - but skip telegram send if no chatId
    const key = ticketKeyFor({ticketId: ticketIdKey, chatId, theirNumber});
    if(!dedupe.has(key)) {
      dedupe.set(key, { chatId: chatId ? String(chatId) : null, theirNumber, ticketId: ticketIdKey, createdAt: r?.createdAt || nowIso(), telegramConnected: r?.telegramConnected || false });
    }
  }

  if(!dedupe.size) return {statusCode:200,headers:CORS,body:JSON.stringify({ok:true,calledFull,calledSeries,sent:0,message:'No recipients in same series'})};

  const results=[];
  const telegramPromises=[];
  const telegramToResultIndex=[];
  const now = nowMs();
  const nowISO = new Date(now).toISOString();
  const firebaseUpdates={}; // batch patch body
  let servedCountIncrement = 0;

  // iterate recipients
  for(const [key,item] of dedupe.entries()){
    const {theirNumber,ticketId,chatId} = item;
    const ticketKey = ticketId ? String(ticketId) : ticketKeyFor({ticketId:null, chatId, theirNumber});
    // load persisted ticket if present
    let ticket = useRedis? await redisGet(`ticket:${ticketKey}`) : (store.tickets&&store.tickets[ticketKey])||null;

    // if missing, try to build initial ticket from queue (best-effort)
    if(!ticket){
      // attempt to fetch queue entry for this ticketKey from Firebase
      let qEntry = null;
      if (ticketId) {
        try {
          const r = await fetch(`${DATABASE_URL}/queue/${encodeURIComponent(ticketId)}.json`);
          if (r.ok) qEntry = await r.json();
        } catch(e){ /* ignore */ }
      }
      const createdAtISO = qEntry?.connectedAt || item.createdAt || nowISO;
      let createdAtMs = qEntry?.timestamp || NaN;
      if (!createdAtMs) {
        // parse createdAtISO if available
        if (createdAtISO) {
          const n = Number(createdAtISO);
          if (!isNaN(n)) createdAtMs = n < 1e12 ? n * 1000 : n;
          else {
            const d = new Date(createdAtISO);
            if (!isNaN(d.getTime())) createdAtMs = d.getTime();
          }
        }
      }
      if(!createdAtMs || isNaN(createdAtMs)) createdAtMs = Date.now();

      ticket = {
        ticketKey,
        ticketId: ticketId||null,
        chatId: chatId||null,
        theirNumber,
        series: seriesOf(theirNumber)||calledSeries,
        createdAt: createdAtISO,
        createdAtMs,
        expiresAt: new Date(now+MAX_AGE_MS).toISOString(),
        notifiedStayAt:null,
        calledAt:null,
        servedAt:null,
      };
    } else {
      if(!ticket.createdAtMs){
        // attempt to normalize existing createdAt
        let cand = ticket.createdAt;
        let createdMs = NaN;
        if (typeof cand === 'number') createdMs = cand;
        else if (typeof cand === 'string'){
          const n = Number(cand);
          if(!isNaN(n)) createdMs = n;
          else {
            const d = new Date(cand);
            createdMs = isNaN(d.getTime())?NaN:d.getTime();
          }
        }
        if (!isNaN(createdMs) && createdMs < 1e12) createdMs = createdMs*1000;
        ticket.createdAtMs = !isNaN(createdMs) ? createdMs : Date.now();
      }
    }

    // If ticket already served, skip
    if(ticket && ticket.servedAt){
      results.push({chatId,theirNumber,ticketKey,action:'skipped-already-served',reason:'ticket.servedAt present'});
      continue;
    }

    const isMatch = normalizeNumber(theirNumber) === normalizeNumber(calledFull);
    const behind = !isMatch && isBehindCalled(theirNumber, calledFull);

    if(!isMatch && !behind){
      results.push({chatId,theirNumber,ticketKey,action:'skipped-ahead'});
      continue;
    }

    // stale cancellation logic (if too old and not match)
    const createdMs = ticket.createdAtMs || Date.now();
    const ageMs = now - createdMs;
    if(ageMs > MAX_AGE_MS && !isMatch && ticket.ticketId){
      firebaseUpdates[`/queue/${ticket.ticketId}/status`] = 'cancelled';
      results.push({chatId,theirNumber,ticketKey,action:'cancelled-stale'});
      ticket.expiresAt = new Date(now).toISOString();
      if(useRedis) await redisSet(`ticket:${ticketKey}`, ticket);
      else { store.tickets = store.tickets||{}; store.tickets[ticketKey] = ticket; await saveStore(store); }
      continue;
    }

    // Build message and update state
    const exploreSuffix = '\n\nCurious how this works? Tap 👉 "Explore QueueJoy" below to see tools your shop can use to keep customers happy.';
    let text;
    if(isMatch){
      // mark served
      ticket.calledAt = nowISO;
      ticket.servedAt = nowISO;
      ticket.servedAtMs = now;
      text = `🎯 Dear customer,\n\nYour number <b>${calledFull}</b> has been called. Please proceed to <b>${counterName||'the counter'}</b>. Thank you.${exploreSuffix}`;
      if(ticket.ticketId){
        firebaseUpdates[`/queue/${ticket.ticketId}/status`] = 'served';
        firebaseUpdates[`/queue/${ticket.ticketId}/servedAt`] = now;
        // compute serviceMs from createdAtMs
        const serviceMs = Math.max(0, now - (ticket.createdAtMs || createdMs || now));
        firebaseUpdates[`/queue/${ticket.ticketId}/serviceMs`] = serviceMs;
        // also push service event (so analytics/serviceEvents is populated)
        const evt = {
          ticketId: ticket.ticketId,
          requestedAt: ticket.createdAtMs || createdMs,
          servedAt: now,
          serviceMs,
          counter: counterName || null,
          series: ticket.series || calledSeries
        };
        // push (fire and forget)
        pushServiceEvent(evt);
      } else {
        // If no ticketId (rare when using chat-only), still compute serviceMs and push an anonymous event
        const serviceMs = Math.max(0, now - (ticket.createdAtMs || createdMs || now));
        const evt = {
          ticketId: null,
          requestedAt: ticket.createdAtMs || createdMs,
          servedAt: now,
          serviceMs,
          counter: counterName || null,
          series: ticket.series || calledSeries
        };
        pushServiceEvent(evt);
      }

      // update series stats in store
      const series = ticket.series || calledSeries;
      const sstats = await loadSeriesStats(series, store);
      const serviceMsVal = Math.max(0, now - (ticket.createdAtMs || createdMs || now));
      sstats.totalServed = (sstats.totalServed||0) + 1;
      sstats.totalServiceMs = (sstats.totalServiceMs||0) + serviceMsVal;
      sstats.minServiceMs = (sstats.minServiceMs===null) ? serviceMsVal : Math.min(sstats.minServiceMs, serviceMsVal);
      sstats.maxServiceMs = (sstats.maxServiceMs===null) ? serviceMsVal : Math.max(sstats.maxServiceMs, serviceMsVal);
      sstats.movingAvgServiceMsLast10 = sstats.movingAvgServiceMsLast10 || [];
      sstats.movingAvgServiceMsLast10.push(serviceMsVal);
      if(sstats.movingAvgServiceMsLast10.length > MOVING_AVG_COUNT) sstats.movingAvgServiceMsLast10.shift();
      await saveSeriesStats(series, sstats, store);

      servedCountIncrement += 1;
    } else {
      // Reminder to someone behind the called number
      ticket.calledAt = ticket.calledAt || nowISO;
      ticket.notifiedStayAt = nowISO;
      ticket.lastReminderMs = now;
      text = `🔔 REMINDER\nNumber <b>${calledFull}</b> was called. Your number is <b>${theirNumber}</b>. We'll notify you again when it's your turn.${exploreSuffix}`;
      if(ticket.ticketId){
        firebaseUpdates[`/queue/${ticket.ticketId}/lastReminderAt`] = now;
      }
    }

    // Persist ticket (ephemeral store or redis)
    if(useRedis){
      await redisSet(`ticket:${ticketKey}`, ticket);
    } else {
      store.tickets = store.tickets||{};
      store.tickets[ticketKey] = ticket;
      await saveStore(store);
    }

    // Prepare result entry and Telegram promise mapping
    const resEntry = {chatId,theirNumber,ticketKey,action:isMatch?'served':'reminder'};
    results.push(resEntry);

    if(chatId){
      telegramPromises.push(tgSendMessage(chatId,text,inlineButtons));
      telegramToResultIndex.push(results.length-1);
    } else {
      // placeholder: no chatId -> we won't send telegram
      results[results.length-1].sendRes = {ok:false,reason:'no-chatId'};
    }
  } // end for recipients

  // ---------- Send Telegram messages ----------
  if(telegramPromises.length){
    const telegramResults = await Promise.allSettled(telegramPromises);
    telegramResults.forEach((r,i)=>{
      const resultIndex = telegramToResultIndex[i];
      results[resultIndex].sendRes = r.status==='fulfilled'?r.value:{ok:false,error:r.reason};
    });
  }

  // ---------- Update Firebase servedCount + per-queue updates in batch ----------
  if(Object.keys(firebaseUpdates).length>0){
    try{
      // fetch current servedCount
      const servedRes = await fetch(`${DATABASE_URL}/analytics/servedCount.json`);
      const currentServed = (servedRes.ok ? await servedRes.json() : null) || 0;
      if (servedCountIncrement>0){
        firebaseUpdates['/analytics/servedCount'] = currentServed + servedCountIncrement;
      }
      // send batch PATCH
      await fetch(`${DATABASE_URL}.json`,{
        method:'PATCH',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(firebaseUpdates)
      });
    } catch(e){ console.warn('Firebase batch update failed',e.message); }
  }

  // ---------- Build stats snapshot for response ----------
  const statsSnapshot = { series:calledSeries, totalServed:0, totalServiceMs:0, minServiceMs:null, maxServiceMs:null, movingAvgServiceMsLast10:0 };
  try {
    const s = await (useRedis ? redisGet(`stats:${calledSeries}`) : (store.stats && store.stats[calledSeries]));
    if(s){
      statsSnapshot.totalServed = s.totalServed || 0;
      statsSnapshot.totalServiceMs = s.totalServiceMs || 0;
      statsSnapshot.minServiceMs = s.minServiceMs || null;
      statsSnapshot.maxServiceMs = s.maxServiceMs || null;
      statsSnapshot.movingAvgServiceMsLast10 = (s.movingAvgServiceMsLast10 && s.movingAvgServiceMsLast10.length)
        ? Math.round(s.movingAvgServiceMsLast10.reduce((a,b)=>a+b,0) / s.movingAvgServiceMsLast10.length)
        : 0;
    } else {
      const servedRes = await fetch(`${DATABASE_URL}/analytics/servedCount.json`);
      const currentServed = (servedRes.ok ? await servedRes.json() : null) || 0;
      statsSnapshot.totalServed = currentServed;
    }
  } catch(e){ console.warn('statsSnapshot', e.message); }

  return {
    statusCode:200,
    headers:CORS,
    body:JSON.stringify({
      ok:true,
      calledFull,
      calledSeries,
      counterName,
      sent:results.length,
      results,
      statsSnapshot,
      persistence:useRedis?'redis':'ephemeral-file'
    })
  };
};

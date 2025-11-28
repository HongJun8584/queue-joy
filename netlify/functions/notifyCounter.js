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
const DATABASE_URL = process.env.DATABASE_URL || "https://queue-joy-aa21b-default-rtdb.asia-southeast1.firebasedatabase.app";
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
  // replace common separators with dash to normalize (space, slash, colon)
  s = s.replace(/[\s\/\\]+/g,'-');
  // remove characters except A-Z0-9 and -_.
  s = s.replace(/[^A-Za-z0-9\-_.]/g,'');
  // collapse multiple dashes/dots/underscores
  s = s.replace(/[-_.]{2,}/g, m => m[0]);
  return s.toUpperCase();
};
const seriesOf = n => {
  const cleaned = normalizeNumber(n);
  if(!cleaned) return '';
  // prefer leading letter-group until first digit
  const m = cleaned.match(/^([A-Z\-_.]+)(\d.*)?$/i);
  if (m) return (m[1]||'').toUpperCase();
  // fallback: split before first digit
  const parts = cleaned.split(/(\d+)/).filter(Boolean);
  return (parts[0]||'').toUpperCase();
};
// extract numeric suffix (e.g. COFFEE001 -> 1). returns NaN if none
const numericSuffix = s => {
  if (!s) return NaN;
  const m = String(s).match(/(\d+)$/);
  return m ? parseInt(m[1],10) : NaN;
};
// return whether theirNumber is strictly behind calledNumber in the same series
const isBehindCalled = (theirNumber, calledNumber) => {
  const t = normalizeNumber(theirNumber);
  const c = normalizeNumber(calledNumber);
  if(!t || !c) return false;
  const seriesT = seriesOf(t);
  const seriesC = seriesOf(c);
  if (seriesT !== seriesC) return false; // different series -> don't consider behind
  const tn = numericSuffix(t);
  const cn = numericSuffix(c);
  if (!isNaN(tn) && !isNaN(cn)) return tn > cn;
  // fallback: compare remainder after prefix lexicographically (best effort)
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

// ---------- Main ----------
exports.handler = async function(event){
  if(event.httpMethod==='OPTIONS') return {statusCode:204,headers:CORS,body:''};
  if(event.httpMethod!=='POST') return {statusCode:405,headers:CORS,body:JSON.stringify({error:'Only POST'})};
  if(!BOT_TOKEN) return {statusCode:500,headers:CORS,body:JSON.stringify({error:'Missing BOT_TOKEN'})};

  let payload;
  try { payload = JSON.parse(event.body||'{}'); } catch(e){ return {statusCode:400,headers:CORS,body:JSON.stringify({error:'Invalid JSON'})}; }

  const calledFullRaw = String(payload.calledFull||'').trim();
  const calledFull = normalizeNumber(calledFullRaw);
  const counterName = payload.counterName?String(payload.counterName).trim():''; // friendly label shown to customer
  const rawRecipients = Array.isArray(payload.recipients)?payload.recipients:[]; // list of recipient objects
  const inlineButtons = Array.isArray(payload.inlineButtons)?payload.inlineButtons:[];

  if(!calledFull) return {statusCode:400,headers:CORS,body:JSON.stringify({error:'calledFull required'})};

  const calledSeries = seriesOf(calledFull);
  const calledNumericSuffix = numericSuffix(calledFull);
  let store = null;
  if(!useRedis) store = await loadStore();

  // ---------- Deduplicate & normalize ----------
  const dedupe = new Map();
  for(const r of rawRecipients){
    const chatId = r?.chatId||r?.chat_id||r?.id;
    if(!chatId) continue;
    const theirNumber = normalizeNumber(r?.theirNumber||r?.number||r?.recipientFull||r?.fullNumber||r?.ticketNumber||'');
    if(!theirNumber) continue;
    const recipientSeries = seriesOf(theirNumber);
    if(recipientSeries!==calledSeries) continue; // only same series
    const ticketId = r?.ticketId||r?.ticket||null;
    const key = ticketKeyFor({ticketId, chatId, theirNumber});
    if(!dedupe.has(key)) {
      dedupe.set(key, { chatId: String(chatId), theirNumber, ticketId, createdAt: r?.createdAt||nowIso() });
    }
  }
  if(!dedupe.size) return {statusCode:200,headers:CORS,body:JSON.stringify({ok:true,calledFull,calledSeries,sent:0,message:'No recipients in same series'})};

  const results=[];
  const telegramPromises=[];
  const telegramToResultIndex=[];
  const now = nowMs();
  const nowISO = new Date(now).toISOString();
  const firebaseUpdates={}; // batched PATCH body for firebase .json
  let servedCountIncrement = 0;

  // Ensure analytics/servedCount fetch/update later uses ms; we'll patch servedCount separately
  for(const [key,item] of dedupe.entries()){
    const {theirNumber,ticketId,chatId} = item;
    const ticketKey = ticketKeyFor({ticketId, chatId, theirNumber});
    let ticket = useRedis? await redisGet(`ticket:${ticketKey}`) : (store.tickets&&store.tickets[ticketKey])||null;

    // If ticket already served, skip
    if(ticket && ticket.servedAt){
      results.push({chatId,theirNumber,ticketKey,action:'skipped-already-served',reason:'ticket.servedAt present'});
      continue;
    }

    // Build ticket if missing
    if(!ticket){
      ticket = {
        ticketKey:ticketKey,
        ticketId:ticketId||null,
        chatId: String(chatId),
        theirNumber,
        series: seriesOf(theirNumber)||calledSeries,
        createdAt:item.createdAt||nowISO, // keep ISO for compatibility
        createdAtMs: Date.now(), // ensure we keep ms for analytics
        expiresAt: new Date(now+MAX_AGE_MS).toISOString(),
        notifiedStayAt:null,
        calledAt:null,
        servedAt:null,
      };
    } else {
      // ensure createdAtMs exists (helps analytics if older tickets used ISO or seconds)
      if(!ticket.createdAtMs){
        // try to parse createdAt; if it's numeric and too small treat as seconds and convert
        const cand = ticket.createdAt;
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
        if (!isNaN(createdMs)) {
          // if in seconds (e.g. < 1e12) convert to ms
          if (createdMs < 1000000000000) createdMs = createdMs * 1000;
          ticket.createdAtMs = createdMs;
        } else {
          ticket.createdAtMs = Date.now();
        }
      }
    }

    // Is this the exact match -> YOUR TURN
    const isMatch = theirNumber.toLowerCase() === calledFull.toLowerCase();

    // If not matched, check whether they are behind the called number
    const behind = !isMatch && isBehindCalled(theirNumber, calledFull);

    // If not behind and not match -> they're ahead/irrelevant -> skip (do not remind)
    if(!isMatch && !behind){
      results.push({chatId,theirNumber,ticketKey,action:'skipped-ahead'});
      continue;
    }

    // Avoid sending reminder to someone who already was served/cancelled
    if(ticket.servedAt){
      results.push({chatId,theirNumber,ticketKey,action:'skipped-already-served'});
      continue;
    }

    // Cancel stale non-matching with ticketId (older than MAX_AGE_MS)
    const createdMs = ticket.createdAtMs || (new Date(ticket.createdAt).getTime() || 0);
    const ageMs = isNaN(createdMs)?0:now - createdMs;
    if(ageMs>MAX_AGE_MS && !isMatch && ticket.ticketId){
      firebaseUpdates[`/queue/${ticket.ticketId}/status`] = 'cancelled';
      results.push({chatId,theirNumber,ticketKey,action:'cancelled-stale'});
      // persist local ticket as cancelled
      ticket.expiresAt = new Date(now).toISOString();
      if(useRedis) await redisSet(`ticket:${ticketKey}`, ticket);
      else { store.tickets = store.tickets||{}; store.tickets[ticketKey] = ticket; await saveStore(store); }
      continue;
    }

    const exploreSuffix = '\n\nCurious how this works? Tap 👉 "Explore QueueJoy" below to see tools your shop can use to keep customers happy.';
    let text;
    if(isMatch){
      // YOUR TURN: mark served
      ticket.calledAt = nowISO;
      ticket.servedAt = nowISO;
      ticket.servedAtMs = now;
      text = `🎯 Dear customer,\n\nYour number <b>${calledFull}</b> has been called. Please proceed to <b>${counterName||'the counter'}</b>. Thank you.${exploreSuffix}`;
      if(ticket.ticketId){
        firebaseUpdates[`/queue/${ticket.ticketId}/status`] = 'served';
        firebaseUpdates[`/queue/${ticket.ticketId}/servedAt`] = now;
      }
      servedCountIncrement += 1;

      // compute serviceMs = servedAtMs - createdAtMs
      const createdAtMs = ticket.createdAtMs || (new Date(ticket.createdAt).getTime());
      const serviceMs = (isNaN(createdAtMs) ? 0 : Math.max(0, now - createdAtMs));
      if(ticket.ticketId){
        firebaseUpdates[`/queue/${ticket.ticketId}/serviceMs`] = serviceMs;
      }

      // update series stats
      const series = ticket.series || calledSeries;
      const sstats = await loadSeriesStats(series, store);
      sstats.totalServed = (sstats.totalServed||0) + 1;
      sstats.totalServiceMs = (sstats.totalServiceMs||0) + serviceMs;
      sstats.minServiceMs = (sstats.minServiceMs===null) ? serviceMs : Math.min(sstats.minServiceMs, serviceMs);
      sstats.maxServiceMs = (sstats.maxServiceMs===null) ? serviceMs : Math.max(sstats.maxServiceMs, serviceMs);
      sstats.movingAvgServiceMsLast10 = sstats.movingAvgServiceMsLast10 || [];
      sstats.movingAvgServiceMsLast10.push(serviceMs);
      if(sstats.movingAvgServiceMsLast10.length > MOVING_AVG_COUNT) sstats.movingAvgServiceMsLast10.shift();
      await saveSeriesStats(series, sstats, store);

    } else {
      // REMINDER for people behind the called number
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

    // Prepare result entry and telegram promise mapping (so indexes remain correct)
    const resEntry = {chatId,theirNumber,ticketKey,action:isMatch?'served':'reminder'};
    results.push(resEntry);
    telegramPromises.push(tgSendMessage(chatId,text,inlineButtons));
    telegramToResultIndex.push(results.length-1);
  }

  // ---------- Send Telegram messages ----------
  const telegramResults = await Promise.allSettled(telegramPromises);
  telegramResults.forEach((r,i)=>{
    const resultIndex = telegramToResultIndex[i];
    results[resultIndex].sendRes = r.status==='fulfilled'?r.value:{ok:false,error:r.reason};
  });

  // ---------- Update Firebase servedCount + per-queue updates in batch ----------
  if(Object.keys(firebaseUpdates).length>0){
    try{
      // Fetch current servedCount (ms-safe integer)
      const servedRes = await fetch(`${DATABASE_URL}/analytics/servedCount.json`);
      const currentServed = await servedRes.json() || 0;
      // If we incremented servedCount locally, patch analytics/servedCount
      if (servedCountIncrement>0){
        firebaseUpdates['/analytics/servedCount'] = currentServed + servedCountIncrement;
      }
      // Patch all updates in one call
      await fetch(`${DATABASE_URL}.json`,{
        method:'PATCH',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(firebaseUpdates)
      });
    } catch(e){ console.warn('Firebase batch update failed',e.message); }
  }

  // ---------- Compute Stats Snapshot for returning in response ----------
  const statsSnapshot={series:calledSeries,totalServed:0,totalServiceMs:0,minServiceMs:null,maxServiceMs:null,movingAvgServiceMsLast10:0};
  try{
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
      // if no stats in store, try to read analytics/servedCount for a baseline
      const servedRes = await fetch(`${DATABASE_URL}/analytics/servedCount.json`);
      const currentServed = await servedRes.json() || 0;
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

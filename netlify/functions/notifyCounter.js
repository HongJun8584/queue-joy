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
const DATABASE_URL = "https://queue-joy-aa21b-default-rtdb.asia-southeast1.firebasedatabase.app";
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
  // prefer leading letter-group until first digit (allow - _ . in group)
  const m = cleaned.match(/^([A-Z\-_.]+)[0-9].*$/i);
  if (m) return m[1].toUpperCase();
  // fallback: take prefix before first digit or the whole string
  const parts = cleaned.split(/(\d+)/).filter(Boolean);
  return (parts[0]||'').toUpperCase();
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
  const rawRecipients = Array.isArray(payload.recipients)?payload.recipients:[];
  const inlineButtons = Array.isArray(payload.inlineButtons)?payload.inlineButtons:[];

  if(!calledFull) return {statusCode:400,headers:CORS,body:JSON.stringify({error:'calledFull required'})};

  const calledSeries = seriesOf(calledFull);
  let store = null;
  if(!useRedis) store = await loadStore();

  // ---------- Deduplicate & normalize ----------
  // Use ticketKey (ticketId or chatId+theirNumber) so we keep all recipients (including multiple per chatId)
  const dedupe = new Map();
  for(const r of rawRecipients){
    const chatId = r?.chatId||r?.chat_id||r?.id;
    if(!chatId) continue;
    const theirNumber = normalizeNumber(r?.theirNumber||r?.number||r?.recipientFull||r?.fullNumber||r?.ticketNumber||'');
    if(!theirNumber) continue;
    const recipientSeries = seriesOf(theirNumber);
    if(recipientSeries!==calledSeries) continue;
    const ticketId = r?.ticketId||r?.ticket||null;
    const key = ticketKeyFor({ticketId, chatId, theirNumber});
    // store every unique ticketKey (no overwriting other recipients in the same chat)
    if(!dedupe.has(key)) {
      dedupe.set(key, { chatId: String(chatId), theirNumber, ticketId, createdAt: r?.createdAt||nowIso() });
    }
  }
  if(!dedupe.size) return {statusCode:200,headers:CORS,body:JSON.stringify({ok:true,calledFull,calledSeries,sent:0,message:'No recipients in same series'})};

  const results=[];
  const telegramPromises=[]; // array of Promise objects
  const telegramToResultIndex = []; // parallel map: telegramPromises[i] -> results[telegramToResultIndex[i]]

  const now = Date.now();
  const nowISO = new Date(now).toISOString();
  const firebaseUpdates={};
  let servedCountIncrement = 0; // number of ticketIds we marked served in this run

  for(const [key,item] of dedupe.entries()){
    const {theirNumber,ticketId,chatId} = item;
    const ticketKey = ticketKeyFor({ticketId, chatId, theirNumber});
    let ticket = useRedis? await redisGet(`ticket:${ticketKey}`) : (store.tickets&&store.tickets[ticketKey])||null;

    if(ticket && ticket.servedAt){
      results.push({chatId,theirNumber,ticketKey,action:'skipped-already-served',reason:'ticket.servedAt present'});
      continue;
    }

    if(!ticket){
      ticket = {
        ticketKey:ticketKey,
        ticketId:ticketId||null,
        chatId: String(chatId),
        theirNumber,
        series: seriesOf(theirNumber)||calledSeries,
        createdAt:item.createdAt||nowISO,
        expiresAt: new Date(now+MAX_AGE_MS).toISOString(),
        notifiedStayAt:null,
        calledAt:null,
        servedAt:null,
      };
    }

    const isMatch = theirNumber.toLowerCase()===calledFull.toLowerCase();
    const createdMs = new Date(ticket.createdAt).getTime();
    const ageMs = isNaN(createdMs)?0:now - createdMs;

    // Cancel stale non-matching
    if(ageMs>MAX_AGE_MS && !isMatch && ticketId){
      firebaseUpdates[`/queue/${ticketId}/status`] = 'cancelled';
      results.push({chatId,theirNumber,ticketKey,action:'cancelled-stale'});
      continue;
    }

    const exploreSuffix = '\n\nCurious how this works? Tap 👉 "Explore QueueJoy" below to see tools your shop can use to keep customers happy.';
    let text;
    if(isMatch){
      ticket.calledAt = nowISO;
      ticket.servedAt = nowISO;
      text = `🎯 Dear customer,\n\nYour number <b>${calledFull}</b> has been called. Please proceed to <b>${counterName||'the counter'}</b>. Thank you.${exploreSuffix}`;
      if(ticketId){
        firebaseUpdates[`/queue/${ticketId}/status`] = 'served';
        servedCountIncrement += 1;
      }
    } else {
      ticket.calledAt = ticket.calledAt||nowISO;
      ticket.notifiedStayAt = nowISO;
      text = `🔔 REMINDER\nNumber <b>${calledFull}</b> was called. Your number is <b>${theirNumber}</b>. We'll notify you again when it's your turn.${exploreSuffix}`;
    }

    // Persist ticket
    if(useRedis){
      await redisSet(`ticket:${ticketKey}`,ticket);
    } else {
      store.tickets = store.tickets||{};
      store.tickets[ticketKey] = ticket;
      await saveStore(store);
    }

    // Prepare result entry and telegram promise mapping (so indexes remain correct)
    const resEntry = {chatId,theirNumber,ticketKey,action:isMatch?'served':'reminder'};
    results.push(resEntry);
    // push promise and remember which result index it corresponds to
    telegramPromises.push(tgSendMessage(chatId,text,inlineButtons));
    telegramToResultIndex.push(results.length-1);
  }

  // ---------- Send Telegram messages ----------
  const telegramResults = await Promise.allSettled(telegramPromises);
  telegramResults.forEach((r,i)=>{
    const resultIndex = telegramToResultIndex[i];
    results[resultIndex].sendRes = r.status==='fulfilled'?r.value:{ok:false,error:r.reason};
  });

  // ---------- Update Firebase servedCount in batch ----------
  if(Object.keys(firebaseUpdates).length>0){
    try{
      // Fetch current servedCount
      const servedRes = await fetch(`${DATABASE_URL}/analytics/servedCount.json`);
      const currentServed = await servedRes.json() || 0;
      firebaseUpdates['/analytics/servedCount'] = currentServed + servedCountIncrement;

      await fetch(`${DATABASE_URL}.json`,{
        method:'PATCH',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(firebaseUpdates)
      });
    } catch(e){ console.warn('Firebase batch update failed',e.message); }
  }

  // ---------- Compute Stats ----------
  const statsSnapshot={series:calledSeries,totalServed:0,totalServiceMs:0,minServiceMs:null,maxServiceMs:null,movingAvgServiceMsLast10:0};
  if(useRedis){
    const s = await redisGet(`stats:${calledSeries}`) || {totalServed:0,totalServiceMs:0,minServiceMs:null,maxServiceMs:null,movingAvgServiceMsLast10:[]};
    statsSnapshot.totalServed = s.totalServed;
    statsSnapshot.totalServiceMs = s.totalServiceMs;
    statsSnapshot.minServiceMs = s.minServiceMs;
    statsSnapshot.maxServiceMs = s.maxServiceMs;
    statsSnapshot.movingAvgServiceMsLast10 = s.movingAvgServiceMsLast10?.length?s.movingAvgServiceMsLast10.reduce((a,b)=>a+b,0)/s.movingAvgServiceMsLast10.length:0;
  } else {
    const seriesStats = store.stats && store.stats[calledSeries];
    if(seriesStats) Object.assign(statsSnapshot,seriesStats);
  }

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

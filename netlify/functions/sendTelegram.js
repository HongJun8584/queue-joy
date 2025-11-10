// /netlify/functions/sendTelegram.js
// Node 18+ (Netlify). Robust, user-friendly sendTelegram function.
// Retries transient errors, resolves @username, forces notification (disable_notification:false),
// and returns clear JSON diagnostics so you know why a send failed.

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ ok:false, error: 'Method Not Allowed. Use POST.' }) };
    }

    const BOT_TOKEN = process.env.BOT_TOKEN;
    if (!BOT_TOKEN) {
      console.error('Missing BOT_TOKEN env var');
      return { statusCode: 500, body: JSON.stringify({ ok:false, error: 'Server misconfigured: missing BOT_TOKEN' }) };
    }
    const tgBase = `https://api.telegram.org/bot${BOT_TOKEN}`;

    // parse body
    let body;
    try { body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {}); }
    catch (e) { return { statusCode: 400, body: JSON.stringify({ ok:false, error: 'Invalid JSON body' }) }; }

    // Accept parameters: chatId (or to), queueNumber, counterName, extraMessage, storeName, method, photoUrl
    const to = body.chatId ?? body.chat_id ?? body.to;
    const queueNumber = body.queueNumber ?? body.queue_number ?? body.queueId;
    if (!to || !queueNumber) {
      return { statusCode: 400, body: JSON.stringify({ ok:false, error: 'Missing required fields: chatId (or to) and queueNumber' }) };
    }
    const counterName = body.counterName ?? body.counter_name ?? '';
    const storeName = body.storeName ?? body.store_name ?? '';
    const extraMessage = body.extraMessage ?? body.extra_message ?? '';
    const method = (body.method || 'sendMessage').toString();
    const photoUrl = body.photoUrl ?? body.photo ?? null;
    const disablePreview = !!body.disable_web_page_preview;
    const replyMarkup = body.reply_markup ?? body.replyMarkup ?? null;

    // small helpers
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const isNumeric = v => /^-?\d+$/.test(String(v));
    const escapeHtml = str => String(str || '')
      .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
      .replaceAll('"','&quot;').replaceAll("'",'&#39;');

    // Resolve username to chat id if needed
    async function resolveChatId(candidate) {
      if (isNumeric(candidate)) return String(candidate);
      const username = String(candidate).trim();
      // allow '@alice' or 'alice'
      const maybe = username.startsWith('@') ? username : `@${username}`;
      try {
        const res = await fetch(`${tgBase}/getChat?chat_id=${encodeURIComponent(maybe)}`);
        const j = await res.json().catch(()=>null);
        if (res.ok && j && j.ok && j.result && j.result.id) return String(j.result.id);
        throw new Error(`getChat failed: ${JSON.stringify(j)}`);
      } catch (err) {
        throw new Error(`Failed to resolve username "${candidate}": ${err.message || err}`);
      }
    }

    // Telegram request with retry on transient errors
    async function tgRequest(path, payload, tries = 3) {
      let attempt = 0;
      while (attempt < tries) {
        try {
          const res = await fetch(`${tgBase}/${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const j = await res.json().catch(()=>null);
          // success
          if (res.ok && j && j.ok) return { ok:true, result:j };
          // handle known non-retryable Telegram errors
          if (j && j.error_code && [400,401,403,404].includes(j.error_code)) {
            // bubble up detailed info immediately
            return { ok:false, telegramError: j };
          }
          // server error -> retry
          if (res.status >= 500 && attempt < tries - 1) {
            await sleep(200 * (2 ** attempt));
            attempt++;
            continue;
          }
          // fallback return error info
          return { ok:false, telegramError: j || { status: res.status } };
        } catch (err) {
          // network error -> retry
          if (attempt < tries - 1) {
            await sleep(200 * (2 ** attempt));
            attempt++;
            continue;
          }
          return { ok:false, fetchError: String(err) };
        }
      }
      return { ok:false, fetchError: 'Exceeded retry attempts' };
    }

    // resolve to numeric chatId
    let chatId;
    try { chatId = await resolveChatId(to); }
    catch (err) {
      console.error('resolveChatId failed', err.message || err);
      return { statusCode: 400, body: JSON.stringify({ ok:false, error: 'Failed to resolve recipient', detail: String(err.message || err) }) };
    }

    // Build friendly message
    const header = storeName ? `<b>${escapeHtml(storeName)}</b>` : `<b>Queue Joy</b>`;
    const called = `Your queue number <b>${escapeHtml(queueNumber)}</b> is now being served${counterName ? ` at <b>${escapeHtml(counterName)}</b>` : ''}.`;
    const extra = extraMessage ? `\n${escapeHtml(extraMessage)}` : '';
    const footer = `\n\nIf you're not available, the counter will move on — thanks!`;
    const text = `${header}\n${called}${extra}${footer}`;

    // Compose payload
    if (method === 'sendPhoto') {
      if (!photoUrl) return { statusCode: 400, body: JSON.stringify({ ok:false, error: 'photoUrl is required for sendPhoto' }) };
      const payload = { chat_id: chatId, photo: String(photoUrl), caption: text.slice(0,1020), parse_mode:'HTML' };
      if (replyMarkup) payload.reply_markup = replyMarkup;
      // ensure notification is pushed (disable_notification false)
      payload.disable_notification = false;
      const result = await tgRequest('sendPhoto', payload);
      if (!result.ok) {
        console.error('sendPhoto failed', result);
        return { statusCode: 502, body: JSON.stringify({ ok:false, error:'Telegram sendPhoto failed', detail: result }) };
      }
      return { statusCode: 200, body: JSON.stringify({ ok:true, method:'sendPhoto', result: result.result }) };
    }

    // default: sendMessage
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: !!disablePreview,
      // ensure a push - Telegram will still deliver silently if user muted bot; but we set false so default is a push.
      disable_notification: false
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const sendResult = await tgRequest('sendMessage', payload);
    if (!sendResult.ok) {
      // helpful diagnostics for the caller
      console.error('sendMessage failed', sendResult);
      // common Telegram errors: 403 (bot blocked / user privacy), 400 (chat not found)
      return { statusCode: 502, body: JSON.stringify({ ok:false, error:'Telegram sendMessage failed', detail: sendResult }) };
    }

    // Success
    return { statusCode: 200, body: JSON.stringify({ ok:true, method:'sendMessage', result: sendResult.result }) };

  } catch (err) {
    console.error('Unhandled sendTelegram error:', err);
    return { statusCode: 500, body: JSON.stringify({ ok:false, error:'Internal server error', detail: String(err) }) };
  }
};

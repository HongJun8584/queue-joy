// counterNotify.js
// Exposes window.CounterNotify with:
//  - init(config)            // optional global config
//  - notifyOnCall(options)   // main function to call after ticket assignment
// Designed to be included with a simple <script src="counterNotify.js"></script>

(function (global) {
  const DEFAULT_BATCH_DELAY = 200; // ms between sequential sends to avoid rate limiting

  // Internal config (can be set with init())
  const cfg = {
    announceUrl: '/.netlify/functions/announce', // default announce endpoint
    masterKey: '',                               // optional master key for announce function
    broadcastTo: undefined,                      // optional staff chat id (string) or array of ids
    batchDelay: DEFAULT_BATCH_DELAY,
    markNotified: null                            // optional function (ticketId, channel) => Promise
  };

  // Helper: sleep
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Helper: simple POST to announce endpoint
  async function postAnnounce(payload) {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.masterKey) headers['x-master-key'] = cfg.masterKey;
    try {
      const res = await fetch(cfg.announceUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      let json = null;
      try { json = await res.json(); } catch (e) { /* ignore */ }
      return { ok: res.ok, status: res.status, json };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  // Build message text according your phrasing rules
  function buildMessages({ calledFull, recipientFull, counterName }) {
    // normalize
    const called = String(calledFull || '').trim();
    const recip = String(recipientFull || '').trim();
    const counterLabel = counterName ? ` at ${counterName}` : '';

    // if recipient is the called number -> make urgent message
    if (called && recip && called.toLowerCase() === recip.toLowerCase()) {
      // user's number was called
      return {
        text: `🎯 Number ${called} is called — it's your turn! Please proceed to the counter${counterLabel}.`
      };
    }

    // otherwise show both called number and the recipient's number
    // EXACT PHRASE the user requested (with small punctuation fix)
    return {
      text: `Number ${called} is called. Your number is ${recip}. Stay tuned!`
    };
  }

  // Send broadcast to staff (if broadcastTo specified)
  async function sendBroadcast({ calledFull, counterName, overrideRecipients }) {
    const called = String(calledFull || '').trim();
    if (!called) return { ok: false, error: 'missing calledFull' };

    const broadcastText = `📢 Now serving: ${called}${counterName ? ' — ' + counterName : ''}`;

    // If overrideRecipients provided (array), use that; else use cfg.broadcastTo; else skip (announce will fallback to env)
    let payload = { message: broadcastText };
    if (Array.isArray(overrideRecipients) && overrideRecipients.length) {
      payload.recipients = overrideRecipients.map(String);
    } else if (cfg.broadcastTo) {
      if (Array.isArray(cfg.broadcastTo)) payload.recipients = cfg.broadcastTo.map(String);
      else payload.recipients = [String(cfg.broadcastTo)];
    } // else no recipients -> announce endpoint will use its env CHAT_ID

    return postAnnounce(payload);
  }

  // Send personalized messages to recipients array: [{ chatId, theirNumber, ticketId? }]
  async function sendPersonalized({ calledFull, counterName, recipients }) {
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return { ok: false, error: 'no recipients' };
    }

    const results = [];
    for (const r of recipients) {
      const chatId = r?.chatId || r?.chat_id || r?.id;
      const theirNumber = r?.theirNumber || r?.number || r?.recipientFull || r?.fullNumber;
      const ticketId = r?.ticketId || r?.ticket;

      if (!chatId) {
        results.push({ ok: false, error: 'missing chatId', recipient: r });
        continue;
      }

      const msg = buildMessages({ calledFull, recipientFull: theirNumber || '', counterName });

      // Use chat_id override (single target)
      const payload = {
        message: msg.text,
        chat_id: String(chatId)
      };

      const res = await postAnnounce(payload);
      results.push({ recipient: chatId, ticketId, result: res });

      // Mark notified if callback provided and announce succeeded
      if (res.ok && typeof cfg.markNotified === 'function' && ticketId) {
        try {
          // mark notified for telegram (caller decides exact flag)
          // We pass channel = 'telegram' by default
          await cfg.markNotified(ticketId, 'telegram');
        } catch (e) {
          // non-fatal
          console.warn('markNotified failed', e);
        }
      }

      // delay slightly to avoid hitting limits
      if (cfg.batchDelay > 0) await sleep(cfg.batchDelay);
    }

    return { ok: true, results };
  }

  // Public API
  const API = {
    // optional: init global config
    init(options = {}) {
      if (options.announceUrl) cfg.announceUrl = options.announceUrl;
      if (options.masterKey) cfg.masterKey = options.masterKey;
      if (options.broadcastTo) cfg.broadcastTo = options.broadcastTo;
      if (typeof options.batchDelay === 'number') cfg.batchDelay = options.batchDelay;
      if (typeof options.markNotified === 'function') cfg.markNotified = options.markNotified;
      return cfg;
    },

    // Main: call when a ticket is assigned (a number is called).
    // options:
    //  - calledFull: string e.g. "A001" (required)
    //  - counterName: optional string
    //  - recipients: array of { chatId, theirNumber, ticketId }  OR single object for one recipient
    //  - broadcastTo: optional override for staff recipients (string or array)
    //  - markNotified: optional per-call markNotified override function (ticketId, channel)
    //
    // Example:
    // window.CounterNotify.notifyOnCall({
    //   calledFull: 'A001',
    //   counterName: 'Service Counter',
    //   recipients: [{ chatId: '123', theirNumber: 'A003', ticketId: 't1' }]
    // })
    async notifyOnCall(options = {}) {
      try {
        const calledFull = options.calledFull || options.calledNumber || options.fullCalled;
        const counterName = options.counterName || options.counter || '';
        let recipients = options.recipients || options.recipient || options.to || [];

        // normalize single recipient object
        if (recipients && !Array.isArray(recipients)) recipients = [recipients];

        // optional per-call markNotified override
        if (typeof options.markNotified === 'function') {
          cfg.markNotified = options.markNotified;
        }

        // 1) broadcast to staff (best-effort)
        try {
          await sendBroadcast({ calledFull, counterName, overrideRecipients: options.broadcastTo });
        } catch (e) {
          console.warn('broadcast failed', e);
        }

        // 2) personalized sends
        const personalRes = await sendPersonalized({ calledFull, counterName, recipients });

        return { ok: true, broadcast: true, personal: personalRes };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  };

  // expose to global
  global.CounterNotify = API;

  // helpful console message for integrators
  console.log('CounterNotify loaded — call window.CounterNotify.notifyOnCall({...}) after assignment.');

})(window);

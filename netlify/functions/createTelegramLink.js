// createTelegramLink.js
// POST { queueKey?, queueNumber?, queueId?, number?, counterId?, counterName? } -> { link, token, preview }

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }

    const queueKey = body.queueKey || null;             // firebase push key (optional)
    const queueNumber = body.queueNumber || body.queueId || body.number || null; // human readable number
    const counterId = body.counterId || null;
    const counterName = body.counterName || null;

    if (!queueKey && !queueNumber) {
      return { statusCode: 400, body: 'Missing queueKey or queueNumber' };
    }

    // Build payload (keep it minimal but useful)
    const payload = {};
    if (queueKey) payload.queueKey = String(queueKey);
    if (queueNumber) payload.queueId = String(queueNumber);
    if (counterId) payload.counterId = String(counterId);
    if (counterName) payload.counterName = String(counterName);

    const json = JSON.stringify(payload);

    // Base64url encode (URL-safe, no padding)
    const token = Buffer.from(json).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const BOT_USERNAME = (process.env.BOT_USERNAME || '').trim() || 'QueueJoyBot';
    const link = `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(token)}`;

    // Optional preview link if you host a preview page
    const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
    const preview = SITE_URL ? `${SITE_URL}/preview?token=${encodeURIComponent(token)}` : null;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link, token, preview }),
    };
  } catch (err) {
    console.error('createTelegramLink error:', err);
    return { statusCode: 500, body: 'Server error' };
  }
};

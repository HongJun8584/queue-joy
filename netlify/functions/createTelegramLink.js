// /netlify/functions/createTelegramLink.js
// POST { queueKey, queueId?, number?, queueNumber?, counterId?, counterName? } -> { link, token }
// Env: BOT_USERNAME (optional), SITE_URL (optional)

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const body = JSON.parse(event.body || '{}');

    // Determine the primary identifier
    const queueKey = body.queueKey || null; // Firebase push key if exists
    const queueNumber = body.queueNumber || body.number || body.queueId || null; // human-readable number
    const counterId = body.counterId || null;

    if (!queueKey && !queueNumber) {
      return { statusCode: 400, body: 'Missing queueKey or queueNumber' };
    }

    // Build payload
    const payload = {};
    if (queueKey) payload.queueKey = queueKey;
    if (queueNumber) payload.queueId = String(queueNumber);
    if (counterId) payload.counterId = String(counterId);

    // Encode as base64 safe for Telegram
    const json = JSON.stringify(payload);
    const token = Buffer.from(json).toString('base64');

    // Bot username
    const BOT_USERNAME = process.env.BOT_USERNAME || 'QueueJoyBot';
    const link = `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(token)}`;

    // Optional preview link
    const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
    const preview = SITE_URL ? `${SITE_URL}/preview?token=${encodeURIComponent(token)}` : null;

    return {
      statusCode: 200,
      body: JSON.stringify({ link, token, preview }),
    };
  } catch (err) {
    console.error('createTelegramLink error:', err);
    return { statusCode: 500, body: 'Server error' };
  }
};

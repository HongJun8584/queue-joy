// /netlify/functions/createTelegramLink.js
// POST { queueKey, counterId? } -> { link }
// Env: BOT_USERNAME (optional; fallback), SITE_URL (optional)

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const body = JSON.parse(event.body || '{}');
    const queueKey = body.queueKey || body.queueId || null;
    const counterId = body.counterId || body.counterName || null;
    if (!queueKey) return { statusCode: 400, body: 'Missing queueKey' };

    // Build simple payload
    const payload = { queueId: String(queueKey) };
    if (counterId) payload.counterId = String(counterId);

    const json = JSON.stringify(payload);
    const token = Buffer.from(json).toString('base64'); // not url-safe but fine; Telegram allows base64 in start param

    const BOT_USERNAME = process.env.BOT_USERNAME || 'QueueJoyBot';
    const link = `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(token)}`;

    return {
      statusCode: 200,
      body: JSON.stringify({ link, token })
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: 'Server error' };
  }
};

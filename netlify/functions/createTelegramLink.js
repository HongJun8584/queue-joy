// /netlify/functions/createTelegramLink.js
// POST { queueKey, queueId?, number?, queueNumber?, counterId?, counterName? } -> { link, token }
// Env: BOT_USERNAME (optional), SITE_URL (optional)
// Generates a Telegram deep link like: https://t.me/<bot>?start=<base64-token>

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const body = JSON.parse(event.body || '{}');

    // Prioritize human-readable number instead of internal key
    const queueNumber =
      body.queueNumber ||
      body.number ||
      body.queueId ||
      body.queueKey ||
      null;

    const counterName = body.counterName || body.counterId || null;

    if (!queueNumber) {
      return { statusCode: 400, body: 'Missing queueNumber/queueKey' };
    }

    // Build human-friendly payload
    const payload = { queueId: String(queueNumber) };
      queueId: String(queueNumber),
      counterName: body.counterName ? String(body.counterName) : 'To be assigned'
    };

    // Encode as base64 (safe for Telegram)
    const json = JSON.stringify(payload);
    const token = Buffer.from(json).toString('base64');

    // Bot username (env or fallback)
    const BOT_USERNAME = process.env.BOT_USERNAME || 'QueueJoyBot';
    const link = `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(token)}`;

    // Optional: if your site needs to show a preview link
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

// createTelegramLink.js
import { nanoid } from 'nanoid';
import fetch from 'node-fetch';

export async function handler(event, context) {
  try {
    const body = JSON.parse(event.body);
    const queueKey = body.queueKey || 'defaultQueue';
    const counterId = body.counterId || 'defaultCounter';
    const counterName = body.counterName || 'Counter';

    // Generate a random one-time token for this user/session
    const token = nanoid(12);

    // Save token mapping somewhere (Firebase / DB) to identify user later
    // Example: saveToken(token, queueKey, counterId);

    // Create Telegram deep link
    const botUsername = process.env.TELEGRAM_BOT_USERNAME; // e.g. 'QueueJoyBot'
    const telegramLink = `https://t.me/${botUsername}?start=${token}`;

    return {
      statusCode: 200,
      body: JSON.stringify({
        link: telegramLink,
        token, // for admin/debug only, hide from users
      }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to generate link' }) };
  }
}

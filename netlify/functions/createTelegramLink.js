// netlify/functions/createTelegramLink.js
import { nanoid } from 'nanoid';

export async function handler(event, context) {
  try {
    const body = JSON.parse(event.body || '{}');
    const queueKey = body.queueKey || '';
    const counterId = body.counterId || '';
    const counterName = body.counterName || '';
    const token = nanoid(12);
    const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');
    if (FIREBASE_DB_URL) {
      try {
        await fetch(`${FIREBASE_DB_URL}/telegramTokens/${encodeURIComponent(token)}.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ queueKey, counterId, counterName, createdAt: new Date().toISOString() })
        });
      } catch (e) {
        console.warn('Failed to save token mapping to Firebase', e);
      }
    }
    const botUsernameFromEnv = process.env.BOT_USERNAME || process.env.BOT_USER || 'QueueJoyBot';
    const botUsername = String(botUsernameFromEnv).replace(/^@/, '');
    const telegramLink = `https://t.me/${botUsername}?start=${token}`;
    return {
      statusCode: 200,
      body: JSON.stringify({ link: telegramLink, token })
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to generate link' }) };
  }
}

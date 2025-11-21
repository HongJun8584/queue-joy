const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { message, media, mediaType, chatIds, telegramBotToken } = JSON.parse(event.body);

    if (!telegramBotToken) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Telegram bot token is required' })
      };
    }

    if (!chatIds || chatIds.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'No recipients specified' })
      };
    }

    const results = {
      success: 0,
      failed: 0,
      errors: []
    };

    // Send to each chat ID
    for (const chatId of chatIds) {
      try {
        let url = `https://api.telegram.org/bot${telegramBotToken}/`;
        let body = { chat_id: chatId };

        // Determine which Telegram API method to use based on media type
        if (media && mediaType) {
          if (mediaType.startsWith('image/')) {
            url += 'sendPhoto';
            body.photo = media; // base64 or URL
            if (message) body.caption = message;
          } else if (mediaType.startsWith('video/')) {
            url += 'sendVideo';
            body.video = media;
            if (message) body.caption = message;
          } else if (mediaType.startsWith('audio/')) {
            url += 'sendAudio';
            body.audio = media;
            if (message) body.caption = message;
          } else if (mediaType === 'image/gif' || mediaType === 'video/gif') {
            url += 'sendAnimation';
            body.animation = media;
            if (message) body.caption = message;
          } else {
            // Fallback to document
            url += 'sendDocument';
            body.document = media;
            if (message) body.caption = message;
          }
        } else {
          // Text only
          url += 'sendMessage';
          body.text = message || 'Announcement from Queue Joy';
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        const data = await response.json();

        if (data.ok) {
          results.success++;
        } else {
          results.failed++;
          results.errors.push({ chatId, error: data.description || 'Unknown error' });
        }
      } catch (error) {
        results.failed++;
        results.errors.push({ chatId, error: error.message });
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(results)
    };

  } catch (error) {
    console.error('Announce function error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};

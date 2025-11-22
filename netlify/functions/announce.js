exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Use POST only." })
    };
  }
  try {
    const body = JSON.parse(event.body || "{}");
    const message = (body.message || "").trim();
    const mediaBase64 = body.media || "";
    const mediaType = body.mediaType || "";
    const chatIds = Array.isArray(body.chatIds) ? body.chatIds : [];
    const botToken = body.telegramBotToken;
    if (!botToken) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing Telegram bot token" })
      };
    }
    if (!chatIds.length) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "No chatIds provided" })
      };
    }
    const apiBase = `https://api.telegram.org/bot${botToken}/`;
    async function sendTo(chatId) {
      // no media → normal text message
      if (!mediaBase64) {
        const res = await fetch(apiBase + "sendMessage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: message || "Announcement",
            parse_mode: "HTML",
            disable_web_page_preview: true
          })
        });
        return res.json();
      }
      // prepare multipart/form-data for media
      const form = new FormData();
      let method = "sendDocument"; // fallback
      let field = "document";
      if (mediaType.startsWith("image/")) {
        method = "sendPhoto";
        field = "photo";
      } else if (mediaType.startsWith("video/")) {
        method = "sendVideo";
        field = "video";
      } else if (mediaType.startsWith("audio/")) {
        method = "sendAudio";
        field = "audio";
      } else if (mediaType.includes("gif")) {
        method = "sendAnimation";
        field = "animation";
      }
      const fileBuffer = Buffer.from(mediaBase64.split(",")[1], "base64");

      const ext = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'video/mp4': 'mp4',
        'video/quicktime': 'mov',
        'audio/mpeg': 'mp3',
        'audio/ogg': 'ogg'
      }[mediaType] || 'bin';

      form.append(field, new Blob([fileBuffer], { type: mediaType }), `announcement.${ext}`);
      if (message) form.append("caption", message);
      form.append("chat_id", chatId);
      const res = await fetch(apiBase + method, {
        method: "POST",
        body: form
      });
      return res.json();
    }
    const results = {
      success: 0,
      failed: 0,
      errors: []
    };
    for (const id of chatIds) {
      try {
        const r = await sendTo(id);
        if (r.ok) {
          results.success++;
        } else {
          results.failed++;
          results.errors.push({ chatId: id, error: r.description || "Unknown error" });
        }
      } catch (err) {
        results.failed++;
        results.errors.push({ chatId: id, error: err.message });
      }
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(results)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};

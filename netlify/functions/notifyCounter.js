// netlify/functions/notifyCounter.js
}
return `Number ${called} is called. Your number is ${theirNumber}. Stay tuned!`;
};


if (!recipients.length) {
return {
statusCode: 400,
headers: CORS,
body: JSON.stringify({ error: 'No recipients provided. Add recipients array with chatId and theirNumber.' })
};
}


const results = [];


for (const r of recipients) {
const chatId = r && (r.chatId || r.chat_id || r.id) || FALLBACK_CHAT;
const theirNumber = r && (r.theirNumber || r.number || r.recipientFull || r.fullNumber || '');
const ticketId = r && (r.ticketId || r.ticket || null);


if (!chatId) {
results.push({ ok: false, error: 'missing chatId', recipient: r });
continue;
}


const text = buildText(calledFull, theirNumber, counterName || '');


// Prepare buttons: always include a direct "Open Queue Status" URL; include Help/Status buttons as callback buttons
const inlineKeyboard = [
[
{
text: '📲 Open Queue Status',
url: `https://queuejoy.netlify.app/status.html?queueId=${encodeURIComponent(String(r.queueKey || payload.queueKey || '')) || ''}`
}
],
[
{ text: '📄 Help', callback_data: 'help' },
{ text: '📊 Status', callback_data: 'status' }
]
];


// If we don't have a queueKey for URL, remove the URL button (avoid broken links)
if (!r.queueKey && !payload.queueKey) {
inlineKeyboard.shift(); // remove first row (url)
}


const sendRes = await tgSendMessage(chatId, text, { reply_markup: { inline_keyboard: inlineKeyboard } });
results.push({ recipient: chatId, ticketId, theirNumber, result: sendRes });
}


return {
statusCode: 200,
headers: CORS,
body: JSON.stringify({ ok: true, calledFull, counterName, results })
};
}

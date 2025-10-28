// netlify/functions/status.js
exports.handler = async () => {
  return {
    statusCode: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      status: "✅ Queue Joy backend is running fine",
      timestamp: new Date().toISOString(),
    }),
  };
};

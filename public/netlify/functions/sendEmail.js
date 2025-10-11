import fetch from "node-fetch";

export async function handler(event) {
  try {
    const body = JSON.parse(event.body || "{}");
    const { email, queueId, counterName } = body;

    if (!email) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing email" }) };
    }

    // Use your Brevo API key from environment variables
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: "Missing BREVO_API_KEY in env" }) };
    }

    // Prepare email payload
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "api-key": apiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sender: { name: "Queue Joy", email: "no-reply@queuejoy.com" },
        to: [{ email }],
        subject: `Queue Joy - It’s Your Turn!`,
        htmlContent: `
          <div style="font-family:Arial,sans-serif;padding:20px">
            <h2>🎉 It’s Your Turn!</h2>
            <p>Your queue number <b>${queueId}</b> is being called at <b>${counterName}</b>.</p>
            <p>Please proceed to your counter now.</p>
            <br>
            <p style="font-size:12px;color:#888">Powered by Queue Joy</p>
          </div>
        `
      })
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("[sendEmail] Failed:", text);
      return { statusCode: response.status, body: text };
    }

    console.log("[sendEmail] Success:", queueId, email);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true })
    };
  } catch (err) {
    console.error("[sendEmail] Error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error", details: err.message })
    };
  }
}

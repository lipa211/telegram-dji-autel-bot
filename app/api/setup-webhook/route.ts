export async function POST(req: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!token || !secret) {
    return Response.json(
      { ok: false, error: "Telegram environment variables are missing" },
      { status: 500 }
    );
  }

  const auth = req.headers.get("authorization");

  if (auth !== `Bearer ${secret}`) {
    return Response.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const host = req.headers.get("host");

  if (!host) {
    return Response.json(
      { ok: false, error: "Host not found" },
      { status: 500 }
    );
  }

  const url = `https://${host}/api/telegram`;

  const res = await fetch(
    `https://api.telegram.org/bot${token}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        secret_token: secret,
      }),
    }
  );

  const data = await res.json();

  return Response.json({
    ...data,
    webhook_url: url,
  });
}

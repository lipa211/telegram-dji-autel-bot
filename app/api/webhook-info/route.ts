export async function GET(req: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!token || !secret) {
    return Response.json({ ok: false, error: "Webhook is not configured" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getWebhookInfo`,
      { cache: "no-store" }
    );
    if (!res.ok) {
      console.error("getWebhookInfo error:", res.status);
      return Response.json({ ok: false, error: "Telegram API unavailable" }, { status: 502 });
    }
    return Response.json(await res.json());
  } catch (error) {
    console.error("getWebhookInfo request failed:", error);
    return Response.json({ ok: false, error: "Telegram API unavailable" }, { status: 502 });
  }
}

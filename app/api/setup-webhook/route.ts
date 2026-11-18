export async function POST(req: Request) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!token || !secret) {
    return Response.json(
      { ok: false, error: "Telegram environment variables are missing" },
      { status: 503 }
    );
  }

  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // Never register a Telegram webhook from an untrusted Host request header.
  // The exact public URL must be explicitly configured by the deployer.
  const configured = process.env.TELEGRAM_WEBHOOK_URL;
  let url: URL;
  try {
    url = new URL(configured || "");
    if (url.protocol !== "https:" || url.username || url.password ||
        url.search || url.hash || url.pathname !== "/api/telegram") {
      throw new Error("Invalid webhook URL");
    }
  } catch {
    return Response.json(
      { ok: false, error: "Set TELEGRAM_WEBHOOK_URL to https://your-domain/api/telegram" },
      { status: 503 }
    );
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: url.toString(),
        secret_token: secret,
        allowed_updates: ["message"],
      }),
    });

    if (!res.ok) {
      console.error("setWebhook Telegram error:", res.status);
      return Response.json({ ok: false, error: "Telegram API unavailable" }, { status: 502 });
    }
    const data = await res.json();
    return Response.json({ ...data, webhook_url: url.toString() });
  } catch (error) {
    console.error("setWebhook request error:", error);
    return Response.json({ ok: false, error: "Telegram API unavailable" }, { status: 502 });
  }
}

export async function GET() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    return Response.json(
      { ok: false, error: "TELEGRAM_BOT_TOKEN is missing" },
      { status: 500 }
    );
  }

  const res = await fetch(
    `https://api.telegram.org/bot${token}/getWebhookInfo`,
    { cache: "no-store" }
  );

  const data = await res.json();

  return Response.json(data);
}

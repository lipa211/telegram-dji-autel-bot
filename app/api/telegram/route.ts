import OpenAI from "openai";

async function sendMessage(chatId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });
}

export async function POST(req: Request) {
  const secret = req.headers.get("x-telegram-bot-api-secret-token");

  if (
    process.env.TELEGRAM_WEBHOOK_SECRET &&
    secret !== process.env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  const update = await req.json();
  const message = update?.message;

  if (!message?.chat?.id) {
    return Response.json({ ok: true });
  }

  const chatId = message.chat.id;
  const text = message.text ?? "";

  if (text === "/start") {
    await sendMessage(
      chatId,
      "Привет. Я ИИ-помощник по DJI, Mavic и Autel. Задавайте вопрос."
    );
    return Response.json({ ok: true });
  }

  if (!text.trim()) {
    return Response.json({ ok: true });
  }

  try {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const response = await openai.responses.create({
      model: "gpt-6-luna",
      instructions:
        "Ты технический помощник по DJI, Mavic, Matrice и Autel. Отвечай на русском языке, кратко, понятно и технически точно. Если не уверен в факте, прямо скажи об этом.",
      input: text,
    });

    const answer =
      response.output_text?.trim() ||
      "Не удалось сформировать ответ.";

    await sendMessage(chatId, answer);
  } catch (error) {
    console.error(error);

    await sendMessage(
      chatId,
      "Ошибка при обращении к ИИ. Проверьте OPENAI_API_KEY и баланс API."
    );
  }

  return Response.json({ ok: true });
}

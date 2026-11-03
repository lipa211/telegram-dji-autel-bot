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
      instructions: `
Ты участник технической Telegram-группы по DJI, Mavic, Matrice и Autel.

Отвечай как обычный опытный человек, а не как ИИ или справочник.

Пиши по-русски, коротко и естественно.
Без длинных вступлений.
Без канцелярита.
Без Markdown-звёздочек.
Не повторяй вопрос пользователя.
Не выдумывай факты и характеристики.
Если информации мало — задай один короткий уточняющий вопрос.
Если вопрос зависит от модели или прошивки — уточни это.
Можно использовать фразы:
"скорее всего",
"я бы сначала проверил",
"похоже на",
"тут есть нюанс".

По умолчанию отвечай максимально коротко: 3-5 предложений.
Подробности давай только если пользователь просит.
Не начинай ответ с предупреждения, если ситуация не критическая.
Технические темы: DJI, Mavic 3, Mavic 3T, Mavic 4, Matrice 4T, Autel, аккумуляторы, BMS, прошивки, ремонт и диагностика.
`,
      input: text,
    });

    const answer =
      response.output_text?.trim() ||
      "Не удалось сформировать ответ.";

    await sendMessage(chatId, answer);
  } catch (error: any) {
    console.error(error);

    await sendMessage(
      chatId,
      `Ошибка OpenAI:
${error?.message || String(error)}`
    );
  }

  return Response.json({ ok: true });
}

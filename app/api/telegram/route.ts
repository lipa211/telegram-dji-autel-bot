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

async function telegramFileToDataUrl(fileId: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  const fileInfoRes = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`
  );

  const fileInfo = await fileInfoRes.json();

  if (!fileInfo.ok || !fileInfo.result?.file_path) {
    throw new Error("Не удалось получить файл из Telegram");
  }

  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${token}/${fileInfo.result.file_path}`
  );

  if (!fileRes.ok) {
    throw new Error("Не удалось скачать файл из Telegram");
  }

  const bytes = Buffer.from(await fileRes.arrayBuffer());

  let contentType = fileRes.headers.get("content-type") || "";

  if (!contentType.startsWith("image/")) {
    contentType = "image/jpeg";
  }

  return {
    dataUrl: `data:${contentType};base64,${bytes.toString("base64")}`,
    contentType,
  };
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
  const text = message.text ?? message.caption ?? "";

  if (text === "/start") {
    await sendMessage(
      chatId,
      "Привет. Можешь написать вопрос, прислать фото или видео."
    );
    return Response.json({ ok: true });
  }

  try {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const content: any[] = [];

    if (text.trim()) {
      content.push({
        type: "input_text",
        text,
      });
    }

    // ФОТО
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const largestPhoto = message.photo[message.photo.length - 1];

      const { dataUrl } = await telegramFileToDataUrl(
        largestPhoto.file_id
      );

      content.push({
        type: "input_image",
        image_url: dataUrl,
      });

      if (!text.trim()) {
        content.unshift({
          type: "input_text",
          text: "Посмотри фото и кратко скажи, что на нём видно и что важно по теме DJI, Autel, аккумуляторов, ошибок или ремонта.",
        });
      }
    }

    // ВИДЕО
    if (message.video?.file_id) {
      if (message.video.file_size && message.video.file_size > 20 * 1024 * 1024) {
        await sendMessage(
          chatId,
          "Видео больше 20 МБ. Пришли более короткий ролик или сжатую версию."
        );

        return Response.json({ ok: true });
      }

      let thumbnailAdded = false;

      const thumb =
        message.video.thumbnail ||
        message.video.thumb;

      if (thumb?.file_id) {
        const { dataUrl } = await telegramFileToDataUrl(
          thumb.file_id
        );

        content.push({
          type: "input_image",
          image_url: dataUrl,
        });

        thumbnailAdded = true;
      }

      if (!text.trim()) {
        content.unshift({
          type: "input_text",
          text: thumbnailAdded
            ? "Пользователь прислал видео. Сейчас доступен только его кадр-превью. Проанализируй то, что реально видно на кадре, и не делай выводов о событиях во всём видео."
            : "Пользователь прислал видео, но кадр-превью недоступен. Скажи, что для анализа лучше прислать кадр из видео или добавить подпись с вопросом.",
        });
      }
    }

    if (content.length === 0) {
      await sendMessage(
        chatId,
        "Сейчас я понимаю текст, фотографии и видео с доступным превью."
      );

      return Response.json({ ok: true });
    }

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

Если информации мало, не перечисляй много возможных причин.
Назови 1-2 наиболее вероятных варианта и задай один короткий уточняющий вопрос.
Не делай вывод о неисправности BMS, аккумулятора, прошивки или железа без признаков, которые это подтверждают.
Если вопрос зависит от модели или прошивки — уточни это.

Если пользователь прислал фото:
- сначала коротко скажи, что именно видно;
- затем дай практический вывод человеческим языком;
- не превращай ответ в сухой отчёт по характеристикам;
- не перечисляй все надписи подряд, если они не нужны для ответа;
- если виден экран, ошибка, батарея, разъём, повреждение или плата — описывай только то, что реально видно;
- если совместимость, тип ячеек или заявленные характеристики нельзя подтвердить по фото, скажи это естественно, например: "по одному фото я бы это не подтверждал";
- если для вывода нужны параметры, предложи конкретно что проверить: напряжение, ток, размеры, разъём, схему подключения, маркировку;
- не придумывай невидимые детали.

Если пользователь прислал видео:
- учитывай, что сейчас тебе может быть доступно только превью;
- не утверждай, что видел весь ролик;
- если по одному кадру нельзя ответить уверенно, прямо скажи, какой момент или кадр нужен.

По умолчанию отвечай максимально коротко: 3-5 предложений.
Подробности давай только если пользователь просит.

Технические темы: DJI, Mavic 3, Mavic 3T, Mavic 4, Matrice 4T, Autel, аккумуляторы, BMS, прошивки, ремонт и диагностика.
`,
      input: [
        {
          role: "user",
          content,
        },
      ],
    });

    const answer =
      response.output_text?.trim() ||
      "Не удалось сформировать ответ.";

    await sendMessage(chatId, answer);
  } catch (error: any) {
    console.error(error);

    await sendMessage(
      chatId,
      `Ошибка OpenAI:\n${error?.message || String(error)}`
    );
  }

  return Response.json({ ok: true });
}

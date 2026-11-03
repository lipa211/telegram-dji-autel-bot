import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";


function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    return null;
  }

  return createClient(url, key);
}

async function getRecentMessages(chatId: number, limit = 12) {
  const supabase = getSupabase();

  if (!supabase) return [];

  const { data, error } = await supabase
    .from("telegram_messages")
    .select("role, content, created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("Supabase read error:", error);
    return [];
  }

  return (data || []).reverse();
}

async function saveMemoryMessage(params: {
  chatId: number;
  userId?: number;
  username?: string;
  role: "user" | "assistant";
  content: string;
}) {
  const supabase = getSupabase();

  if (!supabase) return;

  const { error } = await supabase
    .from("telegram_messages")
    .insert({
      chat_id: params.chatId,
      user_id: params.userId ?? null,
      username: params.username ?? null,
      role: params.role,
      content: params.content,
    });

  if (error) {
    console.error("Supabase save error:", error);
  }
}


async function getLongTermFacts(chatId: number) {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("telegram_facts")
    .select("fact_key, fact_value")
    .eq("chat_id", chatId);

  if (error) {
    console.error("facts read error:", error);
    return [];
  }

  return data || [];
}


async function saveFact(
  chatId: number,
  key: string,
  value: string
) {
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase
    .from("telegram_facts")
    .upsert(
      {
        chat_id: chatId,
        fact_key: key,
        fact_value: value,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "chat_id,fact_key",
      }
    );

  if (error) {
    console.error("facts save error:", error);
  }
}

async function extractFacts(
  openai: OpenAI,
  text: string
) {
  if (!text.trim()) return [];

  try {
    const result = await openai.responses.create({
      model: "gpt-6-luna",
      instructions: `
Из сообщения пользователя извлеки только постоянные технические факты,
которые пригодятся в следующих разговорах.

Примеры:
- модель дрона
- дополнительная батарея
- ёмкость батареи
- напряжение батареи
- схема подключения
- вес
- версия прошивки
- реальное время полёта
- модель пульта

Не сохраняй вопросы, советы, предположения и временные данные.

Ответ только JSON:
[{"key":"drone_model","value":"DJI Mavic 3T"}]

Если фактов нет:
[]
`,
      input: text,
    });

    let raw = result.output_text?.trim() || "[]";

    raw = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "");

    const parsed = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("fact extraction error:", error);
    return [];
  }
}

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

  const incoming =
    update?.message ??
    update?.edited_message ??
    update?.channel_post ??
    update?.edited_channel_post;

  console.log(
    "TELEGRAM_UPDATE:",
    JSON.stringify({
      update_id: update?.update_id,
      update_keys: Object.keys(update || {}),
      chat_type: incoming?.chat?.type,
      chat_id: incoming?.chat?.id,
      chat_title: incoming?.chat?.title,
      message_thread_id: incoming?.message_thread_id,
      is_topic_message: incoming?.is_topic_message,
      from_id: incoming?.from?.id,
      username: incoming?.from?.username,
      text: incoming?.text,
      caption: incoming?.caption,
      has_photo: Array.isArray(incoming?.photo),
      has_video: !!incoming?.video,
    })
  );

  const message = update?.message;

  if (!message?.chat?.id) {
    return Response.json({ ok: true });
  }

  const chatId = message.chat.id;
  const text = message.text ?? message.caption ?? "";

  if (text.startsWith("/set ")) {
    const raw = text.slice(5).trim();
    const parts = raw.split("=");

    if (parts.length < 2) {
      await sendMessage(
        chatId,
        "Формат: /set ключ = значение\nПример: /set вес батареи = 460 г"
      );
      return Response.json({ ok: true });
    }

    const rawKey = parts.shift()!.trim();
    const value = parts.join("=").trim();

    if (!rawKey || !value) {
      await sendMessage(
        chatId,
        "Нужно указать и ключ, и значение."
      );
      return Response.json({ ok: true });
    }

    const aliases: Record<string, string> = {
      "вес батареи": "additional_battery_weight",
      "реальное время полёта": "real_flight_time",
      "время полёта": "flight_time",
      "подключение батареи": "battery_connection",
      "тип подключения": "connection_type",
      "полезная нагрузка": "payload_weight",
      "вес дрона": "drone_weight",
      "прошивка": "firmware_version",
      "дрон": "drone_model",
    };

    const normalizedKey =
      aliases[rawKey.toLowerCase()] ||
      rawKey
        .toLowerCase()
        .replace(/[^a-zа-яё0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "");

    await saveFact(chatId, normalizedKey, value);

    await sendMessage(
      chatId,
      `Запомнил: ${rawKey} — ${value}`
    );

    return Response.json({ ok: true });
  }

  if (text.startsWith("/del ")) {
    const rawKey = text.slice(5).trim();

    if (!rawKey) {
      await sendMessage(
        chatId,
        "Формат: /del ключ\nПример: /del вес батареи"
      );
      return Response.json({ ok: true });
    }

    const aliases: Record<string, string> = {
      "вес батареи": "additional_battery_weight",
      "реальное время полёта": "real_flight_time",
      "время полёта": "flight_time",
      "подключение батареи": "battery_connection",
      "тип подключения": "connection_type",
      "полезная нагрузка": "payload_weight",
      "вес дрона": "drone_weight",
      "прошивка": "firmware_version",
      "дрон": "drone_model",
    };

    const normalizedKey =
      aliases[rawKey.toLowerCase()] ||
      rawKey
        .toLowerCase()
        .replace(/[^a-zа-яё0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "");

    const supabase = getSupabase();

    if (!supabase) {
      await sendMessage(chatId, "Не удалось открыть память.");
      return Response.json({ ok: true });
    }

    const { error } = await supabase
      .from("telegram_facts")
      .delete()
      .eq("chat_id", chatId)
      .eq("fact_key", normalizedKey);

    if (error) {
      console.error("delete fact error:", error);
      await sendMessage(chatId, "Не получилось удалить факт.");
    } else {
      await sendMessage(chatId, `Удалил: ${rawKey}`);
    }

    return Response.json({ ok: true });
  }

  if (text === "/profile") {
    const facts = await getLongTermFacts(chatId);

    if (!facts.length) {
      await sendMessage(chatId, "Пока профиль пуст.");
      return Response.json({ ok: true });
    }

    const map = Object.fromEntries(
      facts.map((f: any) => [f.fact_key, f.fact_value])
    );

    const labels: Record<string, string> = {
      drone_model: "Дрон",
      firmware: "Прошивка",
      firmware_version: "Прошивка",
      additional_battery: "Дополнительная батарея",
      additional_battery_configuration: "Конфигурация батареи",
      additional_battery_capacity: "Ёмкость батареи",
      additional_battery_energy: "Энергия батареи",
      additional_battery_weight: "Вес батареи",
      battery_weight: "Вес батареи",
      connection_type: "Подключение",
      battery_connection: "Подключение батареи",
      flight_time: "Время полёта",
      real_flight_time: "Реальное время полёта",
      payload: "Полезная нагрузка",
      payload_weight: "Полезная нагрузка",
      drone_weight: "Вес дрона",
      notes: "Примечание",
    };

    const lines: string[] = [];

    if (map.drone_model) {
      lines.push(`Дрон: ${map.drone_model}`);
    }

    const batteryParts: string[] = [];

    if (map.additional_battery_configuration) {
      batteryParts.push(map.additional_battery_configuration);
    }

    if (map.additional_battery_capacity) {
      batteryParts.push(map.additional_battery_capacity);
    }

    if (map.additional_battery_energy) {
      batteryParts.push(map.additional_battery_energy);
    }

    if (batteryParts.length) {
      lines.push(`Дополнительная батарея: ${batteryParts.join(", ")}`);
    } else if (map.additional_battery) {
      lines.push(`Дополнительная батарея: ${map.additional_battery}`);
    }

    const alreadyShown = new Set([
      "drone_model",
      "additional_battery",
      "additional_battery_configuration",
      "additional_battery_capacity",
      "additional_battery_energy",
    ]);

    for (const fact of facts) {
      if (alreadyShown.has(fact.fact_key)) continue;

      const label =
        labels[fact.fact_key] ||
        fact.fact_key
          .replace(/_/g, " ")
          .replace(/^./, (c: string) => c.toUpperCase());

      lines.push(`${label}: ${fact.fact_value}`);
    }

    await sendMessage(chatId, lines.join("\n"));

    return Response.json({ ok: true });
  }

  if (text === "/memory") {
    const facts = await getLongTermFacts(chatId);

    if (!facts.length) {
      await sendMessage(chatId, "Пока ничего постоянного не запомнил.");
      return Response.json({ ok: true });
    }

    const memoryText = facts
      .map((f: any) => `• ${f.fact_key}: ${f.fact_value}`)
      .join("\n");

    await sendMessage(
      chatId,
      "Вот что я помню:\n\n" + memoryText
    );

    return Response.json({ ok: true });
  }

  if (text === "/forget") {
    const supabase = getSupabase();

    if (!supabase) {
      await sendMessage(chatId, "Не удалось открыть память.");
      return Response.json({ ok: true });
    }

    const { error } = await supabase
      .from("telegram_facts")
      .delete()
      .eq("chat_id", chatId);

    if (error) {
      console.error("forget error:", error);
      await sendMessage(chatId, "Не получилось очистить память.");
    } else {
      await sendMessage(chatId, "Постоянная память этого чата очищена.");
    }

    return Response.json({ ok: true });
  }

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

    const memory = await getRecentMessages(chatId, 12);

    const extractedFacts = await extractFacts(openai, text);

    for (const fact of extractedFacts) {
      if (
        fact &&
        typeof fact.key === "string" &&
        typeof fact.value === "string"
      ) {
        await saveFact(
          chatId,
          fact.key.toLowerCase().slice(0, 60),
          fact.value.slice(0, 500)
        );
      }
    }

    const savedFacts = await getLongTermFacts(chatId);
    const facts = await getLongTermFacts(chatId);

    const factsText = facts
      .map((f: any) => `${f.fact_key}: ${f.fact_value}`)
      .join("\n");

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
- отделяй то, что реально написано или видно на фото, от технических выводов;
- не делай категоричных выводов о совместимости по одному фото;
- если речь о внешней батарее 4S/5S, сначала уточни схему подключения и точку подключения, а уже потом оценивай совместимость;
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
        ...(factsText
          ? [
              {
                role: "user" as const,
                content:
                  "Уже известные постоянные факты этого чата:\n" +
                  factsText +
                  "\nИспользуй их как контекст и не проси повторять эти данные.",
              },
            ]
          : []),
        ...memory.map((item: any) => ({
          role: item.role === "assistant" ? "assistant" as const : "user" as const,
          content: item.content,
        })),
        {
          role: "user" as const,
          content,
        },
      ],
    });

    const answer =
      response.output_text?.trim() ||
      "Не удалось сформировать ответ.";

    const memoryText =
      text.trim() ||
      (Array.isArray(message.photo) && message.photo.length > 0
        ? "[Пользователь прислал фото]"
        : message.video?.file_id
          ? "[Пользователь прислал видео]"
          : "[Сообщение]");

    await saveMemoryMessage({
      chatId,
      userId: message.from?.id,
      username: message.from?.username,
      role: "user",
      content: memoryText,
    });

    await saveMemoryMessage({
      chatId,
      role: "assistant",
      content: answer,
    });

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

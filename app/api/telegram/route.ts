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



async function saveWebKnowledge(
  chatId: number,
  query: string,
  response: any
) {
  try {
    const supabase = getSupabase();
    if (!supabase) return;

    const output = Array.isArray(response?.output)
      ? response.output
      : [];

    const usedWebSearch = output.some(
      (item: any) => item?.type === "web_search_call"
    );

    if (!usedWebSearch) return;

    const sources: Array<{ url: string; title?: string }> = [];

    for (const item of output) {
      if (item?.type !== "message") continue;

      for (const content of item?.content || []) {
        for (const annotation of content?.annotations || []) {
          if (annotation?.type !== "url_citation") continue;

          const citation =
            annotation?.url_citation || annotation;

          if (!citation?.url) continue;

          if (!sources.some((x) => x.url === citation.url)) {
            sources.push({
              url: citation.url,
              title: citation.title || undefined,
            });
          }
        }
      }
    }

    const answer = response?.output_text?.trim();
    if (!answer) return;

    const { error } = await supabase
      .from("web_knowledge")
      .insert({
        chat_id: chatId,
        query,
        answer,
        sources,
        verified_at: new Date().toISOString(),
      });

    if (error) {
      console.error("saveWebKnowledge error:", error);
    }
  } catch (error) {
    console.error("saveWebKnowledge failed:", error);
  }
}

async function getSelectedModel(chatId: number) {
  const facts = await getLongTermFacts(chatId);
  const saved = facts.find(
    (f: any) => f.fact_key === "openai_model"
  );

  return saved?.fact_value || "gpt-6-luna";
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
Из сообщения пользователя извлеки только устойчивые факты об автомобиле,
которые пригодятся в следующих разговорах.

Разрешённые ключи:

car_make — марка автомобиля
car_model — модель
car_year — год выпуска
engine — двигатель, объём, топливо
vin — VIN
mileage — пробег
license_plate — госномер
transmission — коробка передач
dtc_codes — подтверждённые коды ошибок
current_problem — текущая неисправность или устойчивый симптом
repair_history — выполненный ремонт
parts — заменённые или установленные детали
repair_cost — стоимость ремонта, работ или деталей

Правила:
- сохраняй только то, что пользователь сообщил как факт;
- не угадывай марку, двигатель, VIN или причину неисправности;
- не сохраняй советы и предположения;
- не превращай предполагаемый диагноз в факт;
- код ошибки сохраняй только если пользователь его явно указал;
- один факт = один объект;
- используй только ключи из списка выше.

Пример сообщения:
"У меня Kia Sportage 2010, 2.0 бензин, автомат, пробег 185 тысяч"

Ответ:
[
  {"key":"car_make","value":"Kia"},
  {"key":"car_model","value":"Sportage"},
  {"key":"car_year","value":"2010"},
  {"key":"engine","value":"2.0 бензин"},
  {"key":"transmission","value":"автомат"},
  {"key":"mileage","value":"185000 км"}
]

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


async function saveServiceEvent(
  chatId: number,
  eventType: string,
  eventValue: string,
  mileage?: string,
  carId?: number
) {
  try {
    const supabase = getSupabase();
    if (!supabase) return;

    const { data: lastEvent } = await supabase
      .from("service_events")
      .select("event_type,event_value")
      .eq("chat_id", chatId)
      .eq("event_type", eventType)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Не записываем один и тот же факт подряд дважды
    if (
      lastEvent?.event_type === eventType &&
      lastEvent?.event_value === eventValue
    ) {
      return;
    }

    const { error } = await supabase
      .from("service_events")
      .insert({
        chat_id: chatId,
        event_type: eventType,
        event_value: eventValue,
        mileage: mileage || null,
        car_id: carId || null,
        parts: eventType === "parts" ? eventValue : null,
        cost: eventType === "repair_cost" ? eventValue : null,
      });

    if (error) {
      console.error("saveServiceEvent error:", error);
    }
  } catch (error) {
    console.error("saveServiceEvent failed:", error);
  }
}


async function getActiveCar(chatId: number) {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("cars")
    .select("id,slot,is_active")
    .eq("chat_id", chatId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.error("getActiveCar error:", error);
    return null;
  }

  return data;
}

async function getCars(chatId: number) {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("cars")
    .select("id,slot,is_active,display_name,created_at")
    .eq("chat_id", chatId)
    .order("slot", { ascending: true });

  if (error) {
    console.error("getCars error:", error);
    return [];
  }

  return data || [];
}

async function getCarFacts(carId: number) {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("car_facts")
    .select("fact_key,fact_value,updated_at")
    .eq("car_id", carId);

  if (error) {
    console.error("getCarFacts error:", error);
    return [];
  }

  return data || [];
}


async function saveCarFact(
  carId: number,
  key: string,
  value: string
) {
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase
    .from("car_facts")
    .upsert(
      {
        car_id: carId,
        fact_key: key,
        fact_value: value,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "car_id,fact_key",
      }
    );

  if (error) {
    console.error("saveCarFact error:", error);
  }
}


async function getRecentCarEvents(carId: number, limit = 10) {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("service_events")
    .select("event_type,event_value,mileage,created_at")
    .eq("car_id", carId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("getRecentCarEvents error:", error);
    return [];
  }

  return data || [];
}

async function createCar(chatId: number) {
  const supabase = getSupabase();
  if (!supabase) return null;

  const cars = await getCars(chatId);
  const nextSlot =
    cars.length > 0
      ? Math.max(...cars.map((c: any) => c.slot)) + 1
      : 1;

  await supabase
    .from("cars")
    .update({ is_active: false })
    .eq("chat_id", chatId);

  const { data, error } = await supabase
    .from("cars")
    .insert({
      chat_id: chatId,
      slot: nextSlot,
      is_active: true,
    })
    .select("id,slot,is_active")
    .single();

  if (error) {
    console.error("createCar error:", error);
    return null;
  }

  return data;
}


async function deleteCar(chatId: number, slot: number) {
  const supabase = getSupabase();
  if (!supabase) return false;

  const { data: car } = await supabase
    .from("cars")
    .select("id,is_active")
    .eq("chat_id", chatId)
    .eq("slot", slot)
    .maybeSingle();

  if (!car) return false;

  const wasActive = car.is_active === true;

  const { error } = await supabase
    .from("cars")
    .delete()
    .eq("id", car.id);

  if (error) {
    console.error("deleteCar error:", error);
    return false;
  }

  if (wasActive) {
    const remaining = await getCars(chatId);

    if (remaining.length) {
      await selectCar(chatId, remaining[0].slot);
    }
  }

  return true;
}

async function renameCar(
  chatId: number,
  slot: number,
  name: string
) {
  const supabase = getSupabase();
  if (!supabase) return false;

  const { error } = await supabase
    .from("cars")
    .update({ display_name: name })
    .eq("chat_id", chatId)
    .eq("slot", slot);

  if (error) {
    console.error("renameCar error:", error);
    return false;
  }

  return true;
}

async function selectCar(chatId: number, slot: number) {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data: car, error } = await supabase
    .from("cars")
    .select("id,slot")
    .eq("chat_id", chatId)
    .eq("slot", slot)
    .maybeSingle();

  if (error || !car) {
    if (error) console.error("selectCar find error:", error);
    return null;
  }

  await supabase
    .from("cars")
    .update({ is_active: false })
    .eq("chat_id", chatId);

  const { error: updateError } = await supabase
    .from("cars")
    .update({ is_active: true })
    .eq("id", car.id);

  if (updateError) {
    console.error("selectCar update error:", updateError);
    return null;
  }

  return car;
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

  if (text === "/model" || text.startsWith("/model ")) {
    const arg = text.slice(6).trim();

    if (!arg) {
      const facts = await getLongTermFacts(chatId);
      const saved = facts.find(
        (f: any) => f.fact_key === "openai_model"
      );

      await sendMessage(
        chatId,
        `Текущая модель OpenAI: ${saved?.fact_value || "gpt-6-luna"}`
      );

      return Response.json({ ok: true });
    }

    if (arg.toLowerCase() === "reset") {
      const supabase = getSupabase();

      if (supabase) {
        await supabase
          .from("telegram_facts")
          .delete()
          .eq("chat_id", chatId)
          .eq("fact_key", "openai_model");
      }

      await sendMessage(
        chatId,
        "Модель сброшена на gpt-6-luna"
      );

      return Response.json({ ok: true });
    }

    await saveFact(chatId, "openai_model", arg);

    await sendMessage(
      chatId,
      `Модель переключена на: ${arg}`
    );

    return Response.json({ ok: true });
  }

  if (text === "/stats") {
    const supabase = getSupabase();

    if (!supabase) {
      await sendMessage(chatId, "Supabase недоступен.");
      return Response.json({ ok: true });
    }

    const { count: messageCount, error: messageError } = await supabase
      .from("telegram_messages")
      .select("id", { count: "exact", head: true })
      .eq("chat_id", chatId);

    const { count: factCount, error: factError } = await supabase
      .from("telegram_facts")
      .select("id", { count: "exact", head: true })
      .eq("chat_id", chatId);

    const { data: latestFact, error: latestError } = await supabase
      .from("telegram_facts")
      .select("updated_at")
      .eq("chat_id", chatId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (messageError || factError || latestError) {
      console.error("stats error:", {
        messageError,
        factError,
        latestError,
      });

      await sendMessage(chatId, "Не удалось получить статистику.");
      return Response.json({ ok: true });
    }

    const lastUpdated = latestFact?.updated_at
      ? new Date(latestFact.updated_at).toLocaleString("ru-RU", {
          timeZone: "Europe/Kyiv",
        })
      : "нет данных";

    await sendMessage(
      chatId,
      [
        `Сообщений в памяти: ${messageCount ?? 0}`,
        `Долгих фактов: ${factCount ?? 0}`,
        `Последнее обновление: ${lastUpdated}`,
      ].join("\n")
    );

    return Response.json({ ok: true });
  }

  if (text === "/status") {
    const statusLines: string[] = [];

    statusLines.push("Бот: работает");

    const supabase = getSupabase();

    if (!supabase) {
      statusLines.push("Supabase: недоступен");
    } else {
      const { error } = await supabase
        .from("telegram_facts")
        .select("id")
        .limit(1);

      statusLines.push(
        error ? "Supabase: ошибка" : "Supabase: работает"
      );
    }

    try {
      const facts = await getLongTermFacts(chatId);
      statusLines.push(`Память: работает, фактов ${facts.length}`);
    } catch (error) {
      console.error("status memory error:", error);
      statusLines.push("Память: ошибка");
    }

    statusLines.push(
      process.env.OPENAI_API_KEY
        ? "OpenAI API: ключ подключён"
        : "OpenAI API: ключ отсутствует"
    );

    statusLines.push(
      process.env.TELEGRAM_BOT_TOKEN
        ? "Telegram: токен подключён"
        : "Telegram: токен отсутствует"
    );

    await sendMessage(chatId, statusLines.join("\n"));

    return Response.json({ ok: true });
  }

  if (text === "/help") {
    await sendMessage(
      chatId,
      [
        "Команды:",
        "",
        "/profile — показать профиль",
        "/memory — показать всю память",
        "/set ключ = значение — сохранить факт",
        "/del ключ — удалить один факт",
        "/forget — очистить долгую память",
        "",
        "Примеры:",
        "/set вес батареи = 460 г",
        "/set реальное время полёта = 58 минут",
        "/set прошивка = 1001"
      ].join("\n")
    );

    return Response.json({ ok: true });
  }

  if (text.startsWith("/car delete ")) {
    const slot = Number(text.slice("/car delete ".length).trim());

    if (!Number.isInteger(slot) || slot < 1) {
      await sendMessage(
        chatId,
        "Формат: /car delete 2"
      );
      return Response.json({ ok: true });
    }

    const ok = await deleteCar(chatId, slot);

    await sendMessage(
      chatId,
      ok
        ? `Автомобиль №${slot} удалён.`
        : `Автомобиль №${slot} не найден.`
    );

    return Response.json({ ok: true });
  }

  if (text.startsWith("/car rename ")) {
    const raw = text.slice("/car rename ".length).trim();
    const parts = raw.split("=");

    if (parts.length < 2) {
      await sendMessage(
        chatId,
        "Формат: /car rename 2 = Моя Kia"
      );
      return Response.json({ ok: true });
    }

    const slot = Number(parts.shift()?.trim());
    const name = parts.join("=").trim();

    if (!Number.isInteger(slot) || slot < 1 || !name) {
      await sendMessage(
        chatId,
        "Формат: /car rename 2 = Моя Kia"
      );
      return Response.json({ ok: true });
    }

    const ok = await renameCar(chatId, slot, name);

    await sendMessage(
      chatId,
      ok
        ? `Автомобиль №${slot} переименован: ${name}`
        : `Не удалось переименовать автомобиль №${slot}.`
    );

    return Response.json({ ok: true });
  }

  if (text === "/car add") {
    const car = await createCar(chatId);

    if (!car) {
      await sendMessage(chatId, "Не удалось создать автомобиль.");
      return Response.json({ ok: true });
    }

    await sendMessage(
      chatId,
      `Автомобиль №${car.slot} создан и выбран.\nТеперь напиши данные машины обычным сообщением.`
    );

    return Response.json({ ok: true });
  }

  if (text === "/cars") {
    const cars = await getCars(chatId);

    if (!cars.length) {
      await sendMessage(
        chatId,
        "Автомобилей пока нет.\nИспользуй /car add"
      );
      return Response.json({ ok: true });
    }

    const lines: string[] = [];

    for (const car of cars) {
      const facts = await getCarFacts(car.id);

      const map = Object.fromEntries(
        facts.map((f: any) => [f.fact_key, f.fact_value])
      );

      const name =
        car.display_name ||
        [map.car_make, map.car_model, map.car_year]
          .filter(Boolean)
          .join(" ") ||
        "Профиль не заполнен";

      lines.push(
        `${car.is_active ? "👉 " : ""}${car.slot}. ${name}`
      );
    }

    await sendMessage(
      chatId,
      ["🚗 Автомобили", "", ...lines].join("\n")
    );

    return Response.json({ ok: true });
  }

  if (/^\/car\s+\d+$/.test(text)) {
    const slot = Number(text.split(/\s+/)[1]);
    const car = await selectCar(chatId, slot);

    if (!car) {
      await sendMessage(
        chatId,
        `Автомобиль №${slot} не найден.`
      );
      return Response.json({ ok: true });
    }

    await sendMessage(
      chatId,
      `Активный автомобиль: №${slot}`
    );

    return Response.json({ ok: true });
  }

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
    "марка": "car_make",
    "модель": "car_model",
    "год": "car_year",
    "год выпуска": "car_year",
    "двигатель": "engine",
    "мотор": "engine",
    "vin": "vin",
    "вин": "vin",
    "пробег": "mileage",
    "госномер": "license_plate",
    "коробка": "transmission",
    "кпп": "transmission",
    "ошибка": "dtc_codes",
    "ошибки": "dtc_codes",
    "код ошибки": "dtc_codes",
    "коды ошибок": "dtc_codes",
    "неисправность": "current_problem",
    "проблема": "current_problem",
    "история ремонта": "repair_history",
    "детали": "parts",
    "запчасти": "parts",
    "замененные детали": "parts",
    "заменённые детали": "parts",
    "стоимость ремонта": "repair_cost",
    "стоимость": "repair_cost",
    "сумма ремонта": "repair_cost",
    };

    const normalizedKey =
      aliases[rawKey.toLowerCase()] ||
      rawKey
        .toLowerCase()
        .replace(/[^a-zа-яё0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "");

    const activeCar = await getActiveCar(chatId);

    if (!activeCar) {
      await sendMessage(
        chatId,
        "Сначала создай или выбери автомобиль: /car add"
      );
      return Response.json({ ok: true });
    }

    await saveCarFact(
      activeCar.id,
      normalizedKey,
      value
    );

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

  if (text === "/history") {
    const supabase = getSupabase();

    if (!supabase) {
      await sendMessage(chatId, "Supabase недоступен.");
      return Response.json({ ok: true });
    }

    const activeCar = await getActiveCar(chatId);

    if (!activeCar) {
      await sendMessage(
        chatId,
        "Активный автомобиль не выбран."
      );
      return Response.json({ ok: true });
    }

    const facts = await getCarFacts(activeCar.id);

    const map = Object.fromEntries(
      facts.map((f: any) => [f.fact_key, f.fact_value])
    );

    const { data: events, error } = await supabase
      .from("service_events")
      .select("event_type,event_value,mileage,created_at,parts,cost")
      .eq("car_id", activeCar.id)
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) {
      console.error("history error:", error);
      await sendMessage(chatId, "Не удалось получить историю.");
      return Response.json({ ok: true });
    }

    if (!events?.length) {
      await sendMessage(
        chatId,
        "История этого автомобиля пока пустая."
      );
      return Response.json({ ok: true });
    }

    const labels: Record<string, string> = {
      current_problem: "Неисправность",
      dtc_codes: "Ошибка",
      repair_history: "Ремонт",
      parts: "Детали",
      repair_cost: "Стоимость",
    };

    const carName =
      [map.car_make, map.car_model, map.car_year]
        .filter(Boolean)
        .join(" ") || `Автомобиль №${activeCar.slot}`;

    const lines = events.map((event: any) => {
      const date = new Date(event.created_at).toLocaleDateString(
        "ru-RU",
        { timeZone: "Europe/Kyiv" }
      );

      const mileage = event.mileage
        ? ` · ${event.mileage}`
        : "";

      return `${date}${mileage}\n${labels[event.event_type] || event.event_type}: ${event.event_value}`;
    });

    await sendMessage(
      chatId,
      [
        "🔧 История автомобиля",
        `🚗 ${carName}`,
        "",
        ...lines,
      ].join("\n\n")
    );

    return Response.json({ ok: true });
  }

  if (text === "/profile") {
    const activeCar = await getActiveCar(chatId);

    if (!activeCar) {
      await sendMessage(
        chatId,
        "Активный автомобиль не выбран.\nИспользуй /cars или /car add"
      );
      return Response.json({ ok: true });
    }

    const facts = await getCarFacts(activeCar.id);

    const map = Object.fromEntries(
      facts.map((f: any) => [f.fact_key, f.fact_value])
    );

    const fields: Array<[string, string]> = [
      ["car_make", "Марка"],
      ["car_model", "Модель"],
      ["car_year", "Год выпуска"],
      ["engine", "Двигатель"],
      ["transmission", "Коробка"],
      ["mileage", "Пробег"],
      ["vin", "VIN"],
      ["license_plate", "Госномер"],
      ["dtc_codes", "Ошибки"],
      ["current_problem", "Текущая неисправность"],
      ["repair_history", "Последний ремонт"],
    ];

    const lines = fields
      .filter(([key]) => map[key])
      .map(([key, label]) => `${label}: ${map[key]}`);

    await sendMessage(
      chatId,
      [
        `🚗 Автомобиль №${activeCar.slot}`,
        "",
        ...(lines.length
          ? lines
          : ["Профиль пока не заполнен."]),
      ].join("\n")
    );

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
          text: "Посмотри фото автомобиля, детали, приборной панели или узла и кратко скажи, что видно. Отдельно укажи важные признаки неисправности, повреждения, ошибки, маркировку детали или следы ремонта. Не придумывай то, чего на фото не видно.",
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

    const memory: any[] = [];

    const extractedFacts = await extractFacts(openai, text);

    for (const fact of extractedFacts) {
      if (
        fact &&
        typeof fact.key === "string" &&
        typeof fact.value === "string"
      ) {
        const factKey = fact.key.toLowerCase().slice(0, 60);
        const factValue = fact.value.slice(0, 500);

        const activeCar = await getActiveCar(chatId);

        if (activeCar) {
          await saveCarFact(
            activeCar.id,
            factKey,
            factValue
          );
        }

        if (
          [
            "current_problem",
            "dtc_codes",
            "repair_history",
            "parts",
            "repair_cost"
          ].includes(factKey)
        ) {
          const mileageFact = extractedFacts.find(
            (item: any) =>
              item?.key?.toLowerCase() === "mileage" &&
              typeof item?.value === "string"
          );

          const savedMileageFacts = await getLongTermFacts(chatId);
          const savedMileage = savedMileageFacts.find(
            (item: any) => item.fact_key === "mileage"
          )?.fact_value;

          const eventCar = await getActiveCar(chatId);

          if (eventCar) {
            await saveServiceEvent(
              chatId,
              factKey,
              factValue,
              mileageFact?.value || savedMileage,
              eventCar.id
            );
          }
        }
      }
    }

    const diagnosticCar = await getActiveCar(chatId);

    let factsText = "Активный автомобиль не выбран.";

    if (diagnosticCar) {
      const carFacts = await getCarFacts(diagnosticCar.id);
      const carEvents = await getRecentCarEvents(
        diagnosticCar.id,
        10
      );

      const carMap = Object.fromEntries(
        carFacts.map(
          (f: any) => [f.fact_key, f.fact_value]
        )
      );

      const carName =
        [
          carMap.car_make,
          carMap.car_model,
          carMap.car_year,
        ]
          .filter(Boolean)
          .join(" ") ||
        `Автомобиль №${diagnosticCar.slot}`;

      const profileText = carFacts
        .map(
          (f: any) =>
            `${f.fact_key}: ${f.fact_value}`
        )
        .join("\n");

      const historyText = carEvents
        .map(
          (e: any) =>
            `${e.event_type}: ${e.event_value}` +
            (e.mileage
              ? `, пробег ${e.mileage}`
              : "")
        )
        .join("\n");

      factsText = [
        `АКТИВНЫЙ АВТОМОБИЛЬ: ${carName}`,
        `Номер: ${diagnosticCar.slot}`,
        "",
        "Используй ТОЛЬКО этот автомобиль.",
        "Не используй сведения о других машинах пользователя.",
        "Не спрашивай, какая машина активна: она уже указана.",
        "",
        profileText
          ? "Профиль:\n" + profileText
          : "",
        historyText
          ? "История:\n" + historyText
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    }

    const response = await openai.responses.create({
      model: await getSelectedModel(chatId),
      tools: [
        {
          type: "web_search",
          search_context_size: "medium",
          external_web_access: true,
        },
      ],
      tool_choice: "required",
      instructions: `
Ты опытный AI-помощник автосервиса и автомеханика. Помогаешь диагностировать автомобили по симптомам, кодам ошибок, фото, видео и описанию владельца.

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

Основные темы: автомобили, двигатель, АКПП и МКПП, электрика, электроника, CAN, диагностика OBD-II, ошибки DTC, подвеска, тормоза, рулевое управление, охлаждение, кондиционер, топливная система, аккумулятор, генератор, стартер, мультимедиа, кузов, запчасти, ремонт и техническое обслуживание.

Работай как опытный диагност:
- сначала учитывай марку, модель, год, двигатель и пробег, если они известны;
- по симптомам давай наиболее вероятные причины в порядке вероятности;
- объясняй, что проверить сначала;
- отличай подтвержденный факт от предположения;
- не утверждай точный диагноз без достаточных данных;
- если нужен код ошибки, напряжение, давление, температура или другой замер — скажи какой;
- для диагностики неисправностей обязательно используй интернет-поиск;
- при поиске учитывай марку, модель, год, двигатель, коробку, пробег и симптомы активного автомобиля;
- сначала ищи технические бюллетени, официальные сервисные материалы, известные TSB, типичные неисправности и профильные технические источники;
- сравнивай найденное с симптомами конкретного автомобиля;
- не выдавай типичную неисправность из интернета за подтверждённый диагноз;
- указывай, что проверить в первую очередь;
- если найден источник, оставляй ссылку или цитирование;
- при необходимости используй интернет-поиск для актуальной технической информации;
- предпочитай официальные руководства, сервисную документацию и надежные технические источники;
- отвечай по-русски, кратко, понятно и по делу.
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
        {
          role: "user" as const,
          content,
        },
      ],
    });

    await saveWebKnowledge(
      chatId,
      text,
      response
    );


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

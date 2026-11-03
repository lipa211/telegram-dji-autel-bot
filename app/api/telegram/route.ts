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
generation — поколение / кузов / код кузова, только если пользователь указал явно
drive — тип привода: 2WD / 4WD / передний / полный, только если пользователь указал явно
side — сторона ремонта: передняя/задняя + левая/правая, только если пользователь указал явно
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

    let lastEventQuery = supabase
      .from("service_events")
      .select("event_type,event_value")
      .eq("chat_id", chatId)
      .eq("event_type", eventType);

    if (carId) {
      lastEventQuery = lastEventQuery.eq("car_id", carId);
    }

    const { data: lastEvent } = await lastEventQuery
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


async function saveCarMessage(
  carId: number,
  role: "user" | "assistant",
  content: string
) {
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase
    .from("car_messages")
    .insert({
      car_id: carId,
      role,
      content,
    });

  if (error) {
    console.error("saveCarMessage error:", error);
  }
}

async function getRecentCarMessages(
  carId: number,
  limit = 12
) {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("car_messages")
    .select("role,content,created_at")
    .eq("car_id", carId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("getRecentCarMessages error:", error);
    return [];
  }

  return (data || []).reverse();
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


async function buildDiagnosticSummary(
  openai: any,
  userText: string,
  assistantText: string
) {
  try {
    const result = await openai.responses.create({
      model: "gpt-6-luna",
      instructions: `
Сделай очень краткий итог автомобильной диагностики на русском языке.

Формат:
Симптом: ...
Проверено: ...
Вероятно: ...
Дальше: ...

Правила:
- максимум 4 короткие строки;
- не придумывай выполненные проверки;
- не превращай предположение в подтвержденный диагноз;
- если чего-то нет, пиши "не указано";
- никаких ссылок и длинных объяснений.
`,
      input: `Сообщение клиента:
${userText}

Ответ диагноста:
${assistantText}`,
    });

    return result.output_text?.trim() || null;
  } catch (error) {
    console.error("buildDiagnosticSummary failed:", error);
    return null;
  }
}


function cleanTelegramText(text: string) {
  return text
    // Markdown-ссылки целиком
    .replace(/\[[^\]]+\]\(https?:\/\/[^\s)]+\)/gi, "")

    // Любые URL
    .replace(/https?:\/\/[^\s)]+/gi, "")
    .replace(/www\.[^\s)]+/gi, "")

    // Домены в скобках: (site.com), (static.nhtsa.gov)
    .replace(
      /\(\s*(?:[a-z0-9-]+\.)+[a-z]{2,}\s*\)/gi,
      ""
    )

    // Обычные домены без скобок
    .replace(
      /\b(?:[a-z0-9-]+\.)+(?:com|org|net|gov|edu|io|ru|de|uk|info|co)\b/gi,
      ""
    )

    // Остаточные фразы про скрытые ссылки и цитаты
    .replace(/.*нажмите на цитату.*$/gim, "")
    .replace(/.*смотрите по ссылке.*$/gim, "")
    .replace(/.*схема по ссылке.*$/gim, "")
    .replace(/.*источник выше.*$/gim, "")
    // Строки Источник / Источники
    .replace(/^Источники?:.*$/gim, "")

    // Остатки пустых скобок
    .replace(/\(\s*\)/g, "")

    // Пробелы перед пунктуацией
    .replace(/\s+([,.!?;:])/g, "$1")

    // Лишние пробелы
    .replace(/[ \t]{2,}/g, " ")

    // Лишние пустые строки
    .replace(/\n{3,}/g, "\n\n")
    
    .replace(/^.*смотрите здесь.*$/gim, "")
    .replace(/^.*смотрите ниже.*$/gim, "")
    .replace(/^.*нажмите здесь.*$/gim, "")
    .replace(/^.*по ссылке.*$/gim, "")
    .replace(/^.*каталожная схема.*здесь.*$/gim, "")
    .replace(/^.*источник (ниже|выше).*$/gim, "")
.trim();
}

async function sendMessage(chatId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("sendMessage: TELEGRAM_BOT_TOKEN is missing");
    return false;
  }

  const cleaned = cleanTelegramText(text);
  if (!cleaned) return false;

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: cleaned,
    }),
  });

  if (!response.ok) {
    console.error("sendMessage error:", await response.text());
    return false;
  }

  return true;
}



type VehicleSideCode =
  | "front_left"
  | "front_right"
  | "rear_left"
  | "rear_right";

type VehicleRepairState = {
  mode: "UNKNOWN" | "PARTIAL" | "CONFIRMED";
  model?: string;
  generation?: string;
  drive?: string;
  engine?: string;
  side?: string;
  sideCode?: VehicleSideCode;
  missing: string[];
};

function pickFact(
  facts: Record<string, string>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = facts[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function parseExplicitVehicleFacts(text: string) {
  const lower = text.toLowerCase();
  const result: Record<string, string> = {};

  const generationMatch =
    text.match(/\b(KM|SL)\b/) ||
    text.match(/(?:кузов|поколение|код кузова|sportage\s*(?:ii|2)?)[^a-zа-яё0-9]{0,8}\b(km|sl)\b/i);
  if (generationMatch) result.generation = (generationMatch[1] || "").toUpperCase();

  if (/\b2wd\b/i.test(text) || lower.includes("передний привод")) {
    result.drive = "2WD";
  } else if (/\b4wd\b/i.test(text) || lower.includes("полный привод")) {
    result.drive = "4WD";
  }

  const engineMatch = text.match(/(?:двигател[ья]?|мотор|объ[её]м)[^\d]{0,12}(1[.,]6|2[.,]0|2[.,]4|2[.,]7|3[.,]3)|\b(1[.,]6|2[.,]0|2[.,]4|2[.,]7|3[.,]3)\s*(?:л|литр)/i);
  const engine = engineMatch?.[1] || engineMatch?.[2];
  if (engine) result.engine = engine.replace(",", ".");

  const pair = (a: string, b: string) =>
    new RegExp(`(?:${a})\\w*[^а-яёa-z0-9]{0,8}(?:${b})\\w*|(?:${b})\\w*[^а-яёa-z0-9]{0,8}(?:${a})\\w*`, "i").test(text);

  if (pair("задн", "прав")) {
    result.side = "задняя правая";
    result.sideCode = "rear_right";
  } else if (pair("задн", "лев")) {
    result.side = "задняя левая";
    result.sideCode = "rear_left";
  } else if (pair("передн", "прав")) {
    result.side = "передняя правая";
    result.sideCode = "front_right";
  } else if (pair("передн", "лев")) {
    result.side = "передняя левая";
    result.sideCode = "front_left";
  }

  return result;
}

function deriveVehicleRepairState(
  facts: Record<string, string>,
  userText: string
): VehicleRepairState {
  // Current user message always overrides stale memory.
  const explicit = parseExplicitVehicleFacts(userText);

  const model = pickFact(facts, ["car_model", "vehicle_model", "model"]);
  const generation = explicit.generation || pickFact(facts, ["generation", "body_code", "body", "car_generation"]);
  const drive = explicit.drive || pickFact(facts, ["drive", "drive_type", "drivetrain", "car_drive"]);
  const engine = explicit.engine || pickFact(facts, ["engine", "engine_volume", "engine_displacement", "motor"]);
  const side = explicit.side || pickFact(facts, ["side", "repair_side", "wheel_side"]);

  let sideCode = explicit.sideCode as VehicleSideCode | undefined;
  if (!sideCode && side) {
    const parsed = parseExplicitVehicleFacts(side);
    sideCode = parsed.sideCode as VehicleSideCode | undefined;
  }

  const missing: string[] = [];
  if (!generation) missing.push("поколение / кузов");
  if (!drive) missing.push("привод");
  if (!engine) missing.push("двигатель");

  const mode: VehicleRepairState["mode"] =
    !generation || !drive
      ? "UNKNOWN"
      : !engine
        ? "PARTIAL"
        : "CONFIRMED";

  return { mode, model, generation, drive, engine, side, sideCode, missing };
}

function vehicleStateHeader(state: VehicleRepairState): string {
  const values: string[] = [];
  const add = (value?: string) => {
    if (!value) return;
    const normalized = value.toLowerCase().trim();
    if (!values.some((x) => x.toLowerCase().trim() === normalized)) values.push(value.trim());
  };

  add(state.model);
  add(state.generation);
  add(state.drive);
  if (state.engine) add(`двигатель ${state.engine}`);
  add(state.side);

  const confirmed = values.length ? values.join(", ") : "данные автомобиля";
  if (state.mode === "UNKNOWN") {
    return `Статус: версия автомобиля не определена.\nПодтверждено: ${confirmed}.\nТребует уточнения: ${state.missing.join(", ")}.`;
  }
  if (state.mode === "PARTIAL") {
    return `Подтверждено: ${confirmed}.\nТребует уточнения: ${state.missing.join(", ")}.`;
  }
  return `Подтверждено: ${confirmed}.`;
}

function cleanRepairAnswerForState(text: string, state: VehicleRepairState): string {
  let result = text.trim();

  // Remove model-generated status headers; the application adds one canonical header.
  result = result
    .replace(/^\s*(?:Статус|Подтверждено|Требует уточнения):.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Do not let the assistant re-ask facts that are already structurally known.
  if (state.generation) {
    result = result.replace(/^[^\n]*(?:уточн|определ|проверь)[^\n]*(?:поколен|кузов)[^\n]*$/gim, "");
  }
  if (state.drive) {
    result = result.replace(/^[^\n]*(?:уточн|определ|проверь)[^\n]*(?:2wd|4wd|привод)[^\n]*$/gim, "");
  }

  if (!state.engine) {
    result = result
      .split("\n")
      .filter((line) => !/\b\d{2,4}\s*(?:[–—-]\s*\d{2,4}\s*)?(?:н[·.\s]?м|nm)\b/i.test(line))
      .join("\n");
  }

  return result.replace(/\n{3,}/g, "\n\n").trim();
}

function composeRepairAnswer(answer: string, state: VehicleRepairState): string {
  const cleaned = cleanRepairAnswerForState(answer, state);
  const header = vehicleStateHeader(state);

  if (state.mode === "UNKNOWN") {
    return `${header}\n\nДля точной инструкции сначала нужно определить недостающие данные.\n\nДостаточно прислать фото нужной стороны/узла и указать поколение или кузов и привод, если они известны. До подтверждения версии не применяй точную разборку, каталожные номера и моменты затяжки.`;
  }

  if (state.mode === "PARTIAL") {
    return `${header}\n\n${cleaned}\n\nТочные моменты затяжки, номер детали и отличия по двигателю нужно сверить после уточнения двигателя или по VIN.`
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  return `${header}\n\n${cleaned}`.replace(/\n{3,}/g, "\n\n").trim();
}

async function generateDiagnosticImage(
  openai: any,
  carName: string,
  problem: string,
  diagnosis: string,
  state: VehicleRepairState
) {
  try {
    const sideInstruction = state.sideCode
      ? `TARGET_SIDE_CODE: ${state.sideCode.toUpperCase()}. Это сторона автомобиля по ходу движения. Не зеркаль и не меняй её.`
      : "Сторона автомобиля не подтверждена: не выбирай левую или правую сторону самостоятельно.";

    const modeRules = state.mode === "UNKNOWN"
      ? `РЕЖИМ: ИДЕНТИФИКАЦИЯ. Не показывай демонтаж, инструменты, снятие колеса, ступицы, суппорта, диска или подшипника. Покажи только нужную область, что сфотографировать и какие данные уточнить.`
      : state.mode === "PARTIAL"
        ? `РЕЖИМ: ЧАСТИЧНО ПОДТВЕРЖДЕНО. Поколение/кузов и привод считаются известными. Не проси их повторно и не показывай другой привод как альтернативу. Можно показать общий порядок ремонта, но без неподтверждённых моментов затяжки, каталожных номеров и отличий по двигателю.`
        : `РЕЖИМ: ПОДТВЕРЖДЕНО. Показывай только подтверждённую модель/кузов/привод/двигатель/сторону. Можно показывать последовательность ремонта, если она описана в диагностическом тексте. Не добавляй неподтверждённые моменты затяжки, номера деталей или крепёж.`;

    const result = await openai.images.generate({
      model: "gpt-image-2.5-flare",
      size: "1024x1536",
      prompt: `
Создай вертикальную техническую иллюстрацию для автомеханика.

Автомобиль: ${carName}
Проблема: ${problem}
Диагностический текст: ${diagnosis}

${modeRules}
${sideInstruction}

ОБЩИЕ ПРАВИЛА:
- максимум 4-5 ключевых шагов;
- изображение строго соответствует диагностическому тексту;
- не смешивай разные поколения, кузова, 2WD/4WD или варианты узла;
- не изображай предположение как подтверждённую конструкцию;
- не придумывай номера предохранителей, реле, контактов, распиновку, цвет проводов, каталожные номера или точный крепёж;
- числовой момент затяжки показывай только если в тексте он явно помечен VERIFIED; иначе напиши: "Момент затяжки — сверить по сервисным данным / VIN";
- право/лево всегда определяются по ходу движения автомобиля;
- добавь маленькую ориентацию: "ПЕРЕД АВТОМОБИЛЯ ↑" и "ЛЕВО ←   → ПРАВО";
- не используй "водительская/пассажирская сторона", если расположение руля не подтверждено;
- не рисуй URL, QR-коды, сайты, водяные знаки, слова source/catalog/manual;
- называй результат только наглядной схемой/иллюстрацией, не официальной сервисной схемой.
`,
    });

    const b64 = result.data?.[0]?.b64_json;
    if (!b64) {
      console.error("Image generation returned no image");
      return null;
    }
    return Buffer.from(b64, "base64");
  } catch (error) {
    console.error("generateDiagnosticImage error:", error);
    return null;
  }
}

function shouldGenerateDiagnosticImage(
  text: string,
  _answer: string
) {
  const value = text.toLowerCase();
  const explicitVisualIntent = [
    "покажи",
    "наглядно",
    "схема",
    "нарисуй",
    "где находится",
    "куда смотреть",
    "куда лезть",
    "как снять",
    "как установить",
    "как заменить",
    "покажи фото",
    "покажи на фото",
  ];
  return explicitVisualIntent.some((phrase) => value.includes(phrase));
}

async function sendPhotoBuffer(
  chatId: number,
  imageBuffer: Buffer,
  caption?: string
) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const form = new FormData();

  form.append("chat_id", String(chatId));

  if (caption) {
    form.append(
      "caption",
      cleanTelegramText(caption)
    );
  }

  form.append(
    "photo",
    new Blob([new Uint8Array(imageBuffer)], {
      type: "image/png",
    }),
    "diagnostic.png"
  );

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendPhoto`,
    {
      method: "POST",
      body: form,
    }
  );

  if (!response.ok) {
    console.error(
      "sendPhotoBuffer error:",
      await response.text()
    );
  }
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

function isDroneRequest(text: string) {
  const value = text.toLowerCase();
  return [
    "dji", "mavic", "мавик", "matrice", "матрич", "autel", "аутел",
    "дрон", "квадрокоптер", "прошивка 1001", "firmware 1001",
    "rc pro", "o3", "o4", "дополнительная батарея", "внешняя батарея"
  ].some((word) => value.includes(word));
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

  // Защита от повторной доставки одного Telegram update.
  // Telegram может повторить webhook, пока генерируется длинный ответ/изображение.
  const telegramUpdateId = Number(update?.update_id);

  if (Number.isFinite(telegramUpdateId)) {
    const dedupeSupabase = getSupabase();

    if (dedupeSupabase) {
      const { error: dedupeError } = await dedupeSupabase
        .from("telegram_processed_updates")
        .insert({
          update_id: telegramUpdateId,
        });

      if (dedupeError) {
        // PostgreSQL unique_violation:
        // этот update уже обрабатывался.
        if (dedupeError.code === "23505") {
          console.log("Duplicate Telegram update ignored:", telegramUpdateId);
          return Response.json({ ok: true });
        }

        console.error("Telegram update dedupe error:", dedupeError);
      }
    }
  }


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
        "/set ключ = значение — сохранить факт (авто → профиль машины, остальное → общая память)",
        "/del ключ — удалить факт из соответствующей памяти",
        "/forget — очистить общую долгую память чата",
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

  if (text.startsWith("/repair")) {
    const activeCar = await getActiveCar(chatId);

    if (!activeCar) {
      await sendMessage(
        chatId,
        "Сначала выбери автомобиль: /cars"
      );
      return Response.json({ ok: true });
    }

    const raw = text.slice("/repair".length).trim().toLowerCase();

    const statuses: Record<string, string> = {
      "new": "Новая проблема",
      "новая": "Новая проблема",

      "diagnostic": "Диагностика",
      "диагностика": "Диагностика",

      "parts": "Ожидает запчасти",
      "запчасти": "Ожидает запчасти",

      "repair": "В ремонте",
      "ремонт": "В ремонте",

      "done": "Готово",
      "готово": "Готово",
    };

    if (!raw) {
      const facts = await getCarFacts(activeCar.id);

      const status = facts.find(
        (f: any) => f.fact_key === "service_status"
      )?.fact_value;

      await sendMessage(
        chatId,
        status
          ? `Статус автомобиля №${activeCar.slot}: ${status}`
          : `Статус автомобиля №${activeCar.slot}: не установлен`
      );

      return Response.json({ ok: true });
    }

    const status = statuses[raw];

    if (!status) {
      await sendMessage(
        chatId,
        [
          "Доступные статусы:",
          "/repair new",
          "/repair diagnostic",
          "/repair parts",
          "/repair repair",
          "/repair done",
        ].join("\n")
      );

      return Response.json({ ok: true });
    }

    await saveCarFact(
      activeCar.id,
      "service_status",
      status
    );

    const facts = await getCarFacts(activeCar.id);

    const mileage = facts.find(
      (f: any) => f.fact_key === "mileage"
    )?.fact_value;

    await saveServiceEvent(
      chatId,
      "service_status",
      status,
      mileage,
      activeCar.id
    );

    await sendMessage(
      chatId,
      `Статус автомобиля №${activeCar.slot}: ${status}`
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
    "поколение": "generation",
    "кузов": "generation",
    "код кузова": "generation",
    "привод": "drive",
    "сторона": "side",
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

    const carFactKeys = new Set([
      "car_make", "car_model", "car_year", "generation", "drive", "side",
      "engine", "vin", "mileage", "license_plate", "transmission",
      "dtc_codes", "current_problem", "repair_history", "parts",
      "repair_cost", "service_status"
    ]);

    if (carFactKeys.has(normalizedKey)) {
      const activeCar = await getActiveCar(chatId);
      if (!activeCar) {
        await sendMessage(chatId, "Для автомобильного факта сначала выбери автомобиль: /cars");
        return Response.json({ ok: true });
      }
      await saveCarFact(activeCar.id, normalizedKey, value);
      await sendMessage(chatId, `Запомнил в профиле автомобиля: ${rawKey} — ${value}`);
    } else {
      await saveFact(chatId, normalizedKey, value);
      await sendMessage(chatId, `Запомнил в общей памяти: ${rawKey} — ${value}`);
    }

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
      "марка": "car_make",
      "модель": "car_model",
      "год": "car_year",
      "год выпуска": "car_year",
      "двигатель": "engine",
      "мотор": "engine",
      "поколение": "generation",
      "кузов": "generation",
      "код кузова": "generation",
      "привод": "drive",
      "сторона": "side",
      "vin": "vin",
      "вин": "vin",
      "пробег": "mileage",
      "коробка": "transmission",
      "кпп": "transmission",
    };

    const normalizedKey =
      aliases[rawKey.toLowerCase()] ||
      rawKey
        .toLowerCase()
        .replace(/[^a-zа-яё0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "");

    const carFactKeys = new Set([
      "car_make", "car_model", "car_year", "generation", "drive", "side",
      "engine", "vin", "mileage", "license_plate", "transmission",
      "dtc_codes", "current_problem", "repair_history", "parts",
      "repair_cost", "service_status"
    ]);
    const supabase = getSupabase();

    if (!supabase) {
      await sendMessage(chatId, "Не удалось открыть память.");
      return Response.json({ ok: true });
    }

    if (carFactKeys.has(normalizedKey)) {
      const activeCar = await getActiveCar(chatId);
      if (!activeCar) {
        await sendMessage(chatId, "Для автомобильного факта сначала выбери автомобиль: /cars");
        return Response.json({ ok: true });
      }
      const { error } = await supabase
        .from("car_facts")
        .delete()
        .eq("car_id", activeCar.id)
        .eq("fact_key", normalizedKey);
      if (error) {
        console.error("delete car fact error:", error);
        await sendMessage(chatId, "Не получилось удалить факт автомобиля.");
      } else {
        await sendMessage(chatId, `Удалил из профиля автомобиля: ${rawKey}`);
      }
    } else {
      const { error } = await supabase
        .from("telegram_facts")
        .delete()
        .eq("chat_id", chatId)
        .eq("fact_key", normalizedKey);
      if (error) {
        console.error("delete global fact error:", error);
        await sendMessage(chatId, "Не получилось удалить факт из общей памяти.");
      } else {
        await sendMessage(chatId, `Удалил из общей памяти: ${rawKey}`);
      }
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
      diagnostic_summary: "Итог диагностики",
      service_status: "Статус",
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
      ["generation", "Поколение / кузов"],
      ["drive", "Привод"],
      ["engine", "Двигатель"],
      ["side", "Сторона ремонта"],
      ["transmission", "Коробка"],
      ["mileage", "Пробег"],
      ["vin", "VIN"],
      ["license_plate", "Госномер"],
      ["dtc_codes", "Ошибки"],
      ["current_problem", "Текущая неисправность"],
      ["repair_history", "Последний ремонт"],
      ["service_status", "Статус ремонта"],
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

    const diagnosticCar = await getActiveCar(chatId);
    const vehicleContextEnabled = Boolean(diagnosticCar) && !isDroneRequest(text);

    const extractedFacts = vehicleContextEnabled
      ? await extractFacts(openai, text)
      : [];

    const explicitVehicleFacts = parseExplicitVehicleFacts(text);
    for (const [key, value] of Object.entries(explicitVehicleFacts)) {
      if (key === "sideCode") continue;
      if (!extractedFacts.some((item: any) => item?.key?.toLowerCase() === key)) {
        extractedFacts.push({ key, value });
      }
    }

    for (const fact of extractedFacts) {
      if (
        fact &&
        typeof fact.key === "string" &&
        typeof fact.value === "string"
      ) {
        const factKey = fact.key.toLowerCase().slice(0, 60);
        const factValue = fact.value.slice(0, 500);

        if (vehicleContextEnabled && diagnosticCar) {
          await saveCarFact(
            diagnosticCar.id,
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

          const savedMileageFacts = diagnosticCar
            ? await getCarFacts(diagnosticCar.id)
            : [];
          const savedMileage = savedMileageFacts.find(
            (item: any) => item.fact_key === "mileage"
          )?.fact_value;

          if (vehicleContextEnabled && diagnosticCar) {
            await saveServiceEvent(
              chatId,
              factKey,
              factValue,
              mileageFact?.value || savedMileage,
              diagnosticCar.id
            );
          }
        }
      }
    }

    let factsText = "";

    if (vehicleContextEnabled && diagnosticCar) {
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


    const diagnosticMessages = vehicleContextEnabled && diagnosticCar
      ? await getRecentCarMessages(diagnosticCar.id, 12)
      : [];

    if (vehicleContextEnabled && diagnosticCar && text) {
      await saveCarMessage(
        diagnosticCar.id,
        "user",
        text
      );
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
      tool_choice: "auto",
      instructions: `
Ты технический диагност. Для автомобильных запросов работаешь как опытный автомеханик. Для DJI, Mavic, Matrice и Autel отвечаешь как специалист по дронам и их электронике. Никогда не смешивай данные активного автомобиля с запросом про дрон.

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

Отвечай как опытный автомобильный диагност.

Структура ответа по неисправности:

1. Короткий вывод:
- назови 1-3 наиболее вероятные причины;
- сразу скажи, что проверять первым.

2. Быстрая проверка за 5 минут:
Дай 3-5 самых быстрых действий, которые можно выполнить без разборки или с минимальной разборкой.
Пиши их по порядку, от самого простого к более сложному.

3. Схема диагностики:
Используй компактную текстовую схему со стрелками и ветвлениями.

Пример:

Симптом
↓
Проверка
├─ да → следующее действие
└─ нет → другое действие

Схема должна быть короткой, понятной и вести к следующему конкретному шагу.
Не повторяй в схеме одно и то же несколько раз.

4. Что измерить:
Указывай только реально полезные измерения:
- напряжение;
- падение напряжения по массе;
- предохранители;
- управляющие сигналы;
- коды ошибок;
- конкретные разъёмы и точки проверки, если они подтверждены.

5. Почему это важно:
Кратко объясни техническую логику, без длинной теории.

6. Что пока не менять:
Если деталь не подтверждена как неисправная, прямо скажи не менять её до проверки.

6. Интернет и источники:
Используй интернет для проверки технической информации, но НЕ показывай пользователю ссылки, URL, названия сайтов или список источников.

Правила:
- не делай ответы сухими;
- для неисправности давай полноценную пошаговую диагностику;
- схема должна вести мастера от симптома к конкретной следующей проверке;
- делай ветвления "если да / если нет", когда это полезно;
- после схемы отдельно указывай, что измерить мультиметром или диагностическим оборудованием;
- объясняй, почему каждая ключевая проверка важна;
- отдельно указывай, что пока не менять без подтверждения;
- не пиши огромные вступления;
- не перегружай теорией, которая не помогает ремонту;
- не повторяй одну и ту же проверку в нескольких разделах;
- на каждый запрос формируй только ОДИН законченный ответ;
- не присылай сначала предварительный ответ, а затем второй итоговый;
- все уточнения, вывод, схема и следующий шаг объединяй в одно сообщение;
- если данных недостаточно, всё равно дай один ответ: что известно, чего не хватает и что сделать дальше;

- если проверка уже есть в "Быстрой проверке", в схеме можно сослаться на неё коротко;
- для простого вопроса отвечай кратко;
- если данных недостаточно, после схемы задай один конкретный уточняющий вопрос;
- не выдумывай распиновки, напряжения, номера предохранителей и номера контактов;
- не утверждай точное расположение блока, усилителя, реле, датчика или разъёма, если оно не подтверждено для конкретной модели, года и комплектации;
- если расположение зависит от комплектации, прямо скажи: "точное расположение зависит от комплектации";
- перед конкретным указанием "где находится" сначала используй интернет-поиск и проверяй сервисную документацию;
- если подтверждения точного расположения нет, объясняй общий принцип поиска узла, а не придумывай место;
- отдельно отличай подтверждённый факт от предположения;

КОНТРОЛЬ ТОЧНОСТИ ДЛЯ РЕМОНТА:
- перед описанием разборки определи, достаточно ли данных о машине;
- учитывай марку, модель, год, поколение/кузов, двигатель, коробку и привод, если они влияют на процедуру;
- один год выпуска может относиться к разным поколениям или комплектациям;
- если процедура ремонта отличается между версиями, НЕ выбирай одну версию наугад;
- сначала явно скажи, какие варианты возможны;
- если точную версию нельзя определить из сохранённого профиля, дай только безопасные общие проверки и задай один короткий уточняющий вопрос;
- не говори одновременно "меняется ступица в сборе" и "подшипник нужно прессовать", если это разные варианты конструкции;
- если существуют два варианта узла, сначала раздели их:
  "Вариант A — ..."
  "Вариант B — ..."
  и только после подтверждения версии давай точную процедуру;
- никогда не превращай предположение в подтверждённый факт в следующем сообщении;
- не называй сгенерированное изображение "каталожной схемой", "сервисной процедурой", "официальной схемой" или "фото из мануала", если это действительно не было получено из такого источника;
- не пиши "это точно не вариант с четырьмя болтами", "здесь точно центральная гайка" и подобные категоричные утверждения, если конструкция не подтверждена надёжными данными;
- если уверенность ограничена, используй формулировку:
  "по имеющимся данным для этой версии применяется такой вариант узла; перед покупкой детали всё равно сверить по VIN";

- сгенерированное изображение называй только "наглядная схема", "иллюстрация" или "визуальная подсказка";
- не говори, что картинка относится к конкретному кузову, поколению или комплектации, если это не подтверждено;
- не пиши "старый кузов", "новый кузов", "KM", "SL", "2WD", "4WD" как установленный факт, если это не подтверждено профилем автомобиля или пользователем;
- если кузов не подтверждён, используй формулировку: "для Sportage 2010 возможны разные версии; точный вариант нужно уточнить";
- не пиши "сервисная процедура показывает", "каталожная схема показывает", "мануал показывает", если конкретный официальный документ не был подтверждён;
- в таких случаях говори просто: "общий порядок работы такой";


- не утверждай "это именно ваш узел", если версия автомобиля не подтверждена;
- если пользователь сообщил сторону автомобиля, например "задний правый", запомни сторону, но это не подтверждает конструкцию узла;
- перед советом купить деталь обязательно требуй сверку VIN/каталожного номера/поколения, если есть разные исполнения;
- текст ответа и изображение должны описывать ОДИН И ТОТ ЖЕ вариант ремонта;

ОРИЕНТАЦИЯ ЛЕВО / ПРАВО:
- стороны автомобиля всегда определяются ПО ХОДУ ДВИЖЕНИЯ;
- "левая" = левая сторона автомобиля по ходу движения;
- "правая" = правая сторона автомобиля по ходу движения;
- если пользователь указал конкретную сторону, например "задняя правая", НЕ меняй её ни в тексте, ни на изображении;
- не определяй сторону по тому, где колесо находится на экране;
- вид сзади, вид спереди и зеркальный ракурс не должны менять обозначение стороны;
- не заменяй "правая/левая" на "водительская/пассажирская", если это не подтверждено;
- если есть сомнение в ракурсе изображения, добавь схему ориентации:
  "ПЕРЕД АВТОМОБИЛЯ ↑"
  "ЛЕВО ←   → ПРАВО";


ЕСЛИ КУЗОВ И ПРИВОД УЖЕ ПОДТВЕРЖДЕНЫ, А НЕИЗВЕСТЕН ТОЛЬКО ДВИГАТЕЛЬ:
- НЕ возвращайся в режим "уточнить кузов / поколение / привод";
- НЕ показывай 2WD и 4WD как варианты, если привод уже известен;
- НЕ проси повторно VIN/кузов/привод без необходимости;
- покажи подтверждённую конструкцию узла на общем уровне;
- можно показать общий порядок ремонта;
- НЕ показывай неподтверждённые моменты затяжки, номера деталей и отличия по двигателю как окончательные;
- крупно укажи только: "Для точных моментов и деталей уточнить двигатель";


РАЗДЕЛЯЙ ДАННЫЕ НА ДВА УРОВНЯ:
1. ПОДТВЕРЖДЕНО:
   - модель;
   - поколение / кузов;
   - привод;
   - сторона автомобиля;
   - конструкция узла, если она действительно установлена.
2. ТРЕБУЕТ СВЕРКИ:
   - номер детали;
   - момент затяжки;
   - точный крепёж;
   - одноразовые гайки / болты;
   - различия по двигателю и комплектации.

Не смешивай эти категории.
Если параметр требует сверки — прямо так и пиши.

- перед отправкой ответа мысленно проверь, нет ли противоречия между предыдущими сообщениями, текущим текстом и картинкой;
- если ранее был указан другой вариант конструкции, не продолжай уверенно один из вариантов: сначала объясни, что версия не подтверждена;
- при сомнении лучше дать общий порядок проверки, чем выдумать точную процедуру;
- если момент затяжки не подтверждён именно для текущей версии автомобиля отдельным проверенным техническим источником, НЕ выводи числовое значение как готовую норму;
- число, сгенерированное самой моделью, не считается подтверждением;
- если подтверждения нет, пиши:
  "момент затяжки нужно сверить по сервисным данным / VIN";
- не создавай таблицу моментов затяжки без проверенных данных;
- в таком случае пиши: "момент затяжки нужно сверить по VIN / сервисной документации";
- не помещай неподтверждённые моменты затяжки крупно на изображение;
- если приводишь числовой момент, обязательно укажи, для какой конкретной версии он подтверждён;

- если версия автомобиля или узла НЕ подтверждена, не давай точную последовательность разборки;
- если поколение/кузов, привод и двигатель подтверждены сохранённым профилем или текущим сообщением, не возвращайся к идентификации и можно давать применимую процедуру ремонта;
- никогда не проси повторно параметры, уже присутствующие в профиле активного автомобиля;


- если точное значение не подтверждено, прямо скажи это;
- не подменяй проверку деталей предположением;
- не вставляй ссылки и названия сайтов в ответ;
- никогда не пиши "нажмите на цитату", "смотрите по ссылке", "здесь", "источник выше", "схема по ссылке", если ссылки пользователю скрываются;
- если интернет использовался для проверки фактов, просто используй подтверждённую информацию без упоминания источника;
- не пиши "каталоги показывают", "по каталогу", "в каталоге указано", если пользователь не просил источник;
- не используй формулировки "каталоги действительно показывают";
- не пиши "схемы ремонта подтверждают", "документация подтверждает", "источники подтверждают", если пользователь не просил источники;
- просто сообщай технический вывод без упоминания того, где он найден;

- не проси именно "последние 8 символов VIN" как обязательный вариант;
- лучше проси полный VIN, а если пользователь не хочет его отправлять — фото шильдика или фото узла и сведения о приводе;

- формулируй результат напрямую: например, "для 2WD и 4WD применяются разные варианты узла";

- никогда не пиши "смотрите здесь", "смотрите ниже", "нажмите здесь", "по ссылке", "каталожная схема здесь", "источник ниже", "источник выше";
- никогда не обещай пользователю цитату, ссылку или схему "здесь", если ссылки скрываются;
- если найден каталог или сервисный документ, перескажи полезную информацию своими словами без упоминания самого сайта;




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
- если интернет использован для проверки, используй проверенные сведения без вывода URL и списка источников, если пользователь сам их не попросил;
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
        ...diagnosticMessages.map((item: any) => ({
          role:
            item.role === "assistant"
              ? "assistant" as const
              : "user" as const,
          content: item.content,
        })),
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


    let pendingDiagnosticImage: Buffer | null = null;
    let answer =



      response.output_text?.trim() ||



      "Не удалось сформировать ответ.";




    const repairFacts = vehicleContextEnabled && diagnosticCar
    ? await getCarFacts(diagnosticCar.id)
    : [];

  const repairFactMap = Object.fromEntries(
    repairFacts.map((f: any) => [
      String(f.fact_key),
      String(f.fact_value ?? ""),
    ])
  );

  const vehicleState = deriveVehicleRepairState(
    repairFactMap,
    text
  );

  if (vehicleContextEnabled) {
    answer = composeRepairAnswer(answer, vehicleState);
  }

  if (vehicleContextEnabled && diagnosticCar && answer) {
      await saveCarMessage(
        diagnosticCar.id,
        "assistant",
        answer
      );
    }

    if (
      vehicleContextEnabled &&
      diagnosticCar &&
      cleanTelegramText(answer).length <= 950 &&
      shouldGenerateDiagnosticImage(text, answer)
    ) {
      try {
        const imageFacts =
          await getCarFacts(diagnosticCar.id);

        const imageMap = Object.fromEntries(
          imageFacts.map(
            (f: any) => [
              f.fact_key,
              f.fact_value,
            ]
          )
        );

        const carName =
          [
            imageMap.car_make,
            imageMap.car_model,
            imageMap.car_year,
          ]
            .filter(Boolean)
            .join(" ") ||
          `Автомобиль №${diagnosticCar.slot}`;

        const diagnosticImage =
          await generateDiagnosticImage(
            openai,
            carName,
            text,
            answer,
            vehicleState
          );

        if (diagnosticImage) {

          pendingDiagnosticImage = diagnosticImage;

        }
      } catch (error) {
        console.error(
          "automatic diagnostic image error:",
          error
        );
      }
    }



    if (vehicleContextEnabled && diagnosticCar && text && answer) {
      const diagnosticSummary =
        await buildDiagnosticSummary(
          openai,
          text,
          answer
        );

      if (diagnosticSummary) {
        const activeFacts =
          await getCarFacts(diagnosticCar.id);

        const mileage =
          activeFacts.find(
            (f: any) => f.fact_key === "mileage"
          )?.fact_value;

        await saveServiceEvent(
          chatId,
          "diagnostic_summary",
          diagnosticSummary,
          mileage,
          diagnosticCar.id
        );
      }
    }

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

    if (pendingDiagnosticImage && cleanTelegramText(answer).length <= 950) {
      await sendPhotoBuffer(chatId, pendingDiagnosticImage, answer);
    } else {
      // Preserve the complete answer rather than silently truncating it.
      await sendMessage(chatId, answer);
    }
  } catch (error: any) {
    console.error(error);
    await sendMessage(
      chatId,
      "Не удалось обработать запрос. Повтори сообщение ещё раз."
    );
  }

  return Response.json({ ok: true });
}

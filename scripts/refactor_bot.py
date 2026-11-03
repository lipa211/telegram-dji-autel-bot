from pathlib import Path
import re
import shutil

PATH = Path("app/api/telegram/route.ts")
BACKUP = Path("app/api/telegram/route.ts.before-logic-refactor")

s = PATH.read_text()
shutil.copy2(PATH, BACKUP)


def replace_once(old: str, new: str, label: str):
    global s
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    s = s.replace(old, new, 1)
    print(f"OK: {label}")


def replace_between(start: str, end: str, new: str, label: str):
    global s
    a = s.find(start)
    if a < 0:
        raise SystemExit(f"{label}: start anchor not found")
    b = s.find(end, a)
    if b < 0:
        raise SystemExit(f"{label}: end anchor not found")
    s = s[:a] + new.rstrip() + "\n\n" + s[b:]
    print(f"OK: {label}")

# 1) Remove the redundant in-memory dedupe. Supabase remains the source of truth.
replace_between(
    "// ============================================================\n// TELEGRAM UPDATE DEDUPLICATION",
    "function getSupabase()",
    "",
    "remove duplicate in-memory update cache",
)

replace_once(
    '''  if (!claimTelegramUpdate(update?.update_id)) {\n    return Response.json({ ok: true, duplicate: true });\n  }\n\n\n''',
    "",
    "remove old claimTelegramUpdate call",
)

# 2) Persist structural vehicle facts.
replace_once(
    "car_year — год выпуска\nengine — двигатель, объём, топливо",
    "car_year — год выпуска\ngeneration — поколение / кузов / код кузова, только если пользователь указал явно\ndrive — тип привода: 2WD / 4WD / передний / полный, только если пользователь указал явно\nside — сторона ремонта: передняя/задняя + левая/правая, только если пользователь указал явно\nengine — двигатель, объём, топливо",
    "extend extracted vehicle fact keys",
)

# 3) Harden Telegram text sending and stop silently losing API errors.
old_send = '''async function sendMessage(chatId: number, text: string) {\n  const token = process.env.TELEGRAM_BOT_TOKEN;\n\n  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {\n    method: "POST",\n    headers: { "Content-Type": "application/json" },\n    body: JSON.stringify({\n      chat_id: chatId,\n      text: cleanTelegramText(text),\n    }),\n  });\n}\n'''
new_send = '''async function sendMessage(chatId: number, text: string) {\n  const token = process.env.TELEGRAM_BOT_TOKEN;\n  if (!token) {\n    console.error("sendMessage: TELEGRAM_BOT_TOKEN is missing");\n    return false;\n  }\n\n  const cleaned = cleanTelegramText(text);\n  if (!cleaned) return false;\n\n  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {\n    method: "POST",\n    headers: { "Content-Type": "application/json" },\n    body: JSON.stringify({\n      chat_id: chatId,\n      text: cleaned,\n    }),\n  });\n\n  if (!response.ok) {\n    console.error("sendMessage error:", await response.text());\n    return false;\n  }\n\n  return true;\n}\n'''
replace_once(old_send, new_send, "harden sendMessage")

# 4) Replace all old vehicle-mode helpers with one deterministic state machine.
vehicle_block = r'''type VehicleSideCode =
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

  const generationMatch = text.match(/\b(KM|SL)\b/i);
  if (generationMatch) result.generation = generationMatch[1].toUpperCase();

  if (/\b2wd\b/i.test(text) || lower.includes("передний привод")) {
    result.drive = "2WD";
  } else if (/\b4wd\b/i.test(text) || lower.includes("полный привод")) {
    result.drive = "4WD";
  }

  const engineMatch = text.match(/(?:двигател[ья]?|мотор|объ[её]м)[^\d]{0,12}(1[.,]6|2[.,]0|2[.,]4|2[.,]7|3[.,]3)|\b(1[.,]6|2[.,]0|2[.,]4|2[.,]7|3[.,]3)\s*(?:л|литр)/i);
  const engine = engineMatch?.[1] || engineMatch?.[2];
  if (engine) result.engine = engine.replace(",", ".");

  const hasRear = /задн\w*/i.test(text);
  const hasFront = /передн\w*/i.test(text);
  const hasRight = /прав\w*/i.test(text);
  const hasLeft = /лев\w*/i.test(text);

  if (hasRear && hasRight) {
    result.side = "задняя правая";
    result.sideCode = "rear_right";
  } else if (hasRear && hasLeft) {
    result.side = "задняя левая";
    result.sideCode = "rear_left";
  } else if (hasFront && hasRight) {
    result.side = "передняя правая";
    result.sideCode = "front_right";
  } else if (hasFront && hasLeft) {
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
'''
replace_between(
    "function isEngineClarificationMode",
    "async function generateDiagnosticImage",
    vehicle_block,
    "replace conflicting vehicle state helpers",
)

# 5) Image generation now receives the already-computed state and has mode-specific rules only.
image_func = r'''async function generateDiagnosticImage(
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
'''
replace_between(
    "async function generateDiagnosticImage",
    "function shouldGenerateDiagnosticImage",
    image_func,
    "replace contradictory image prompt",
)

# 6) Generate images only on explicit visual intent, not on generic repair words.
visual_func = r'''function shouldGenerateDiagnosticImage(
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
'''
replace_between(
    "function shouldGenerateDiagnosticImage",
    "async function sendPhotoBuffer",
    visual_func,
    "narrow image generation trigger",
)

# 7) Use incoming message consistently.
replace_once(
    "  const message = update?.message;\n",
    "  const message = update?.message ?? update?.edited_message;\n",
    "use consistent Telegram incoming message",
)

# 8) Web search should be available, not forced for every request.
replace_once(
    '      tool_choice: "required",',
    '      tool_choice: "auto",',
    "make web search optional",
)

# 9) Deterministically persist explicit state facts from the user's current message.
anchor = "    const extractedFacts = await extractFacts(openai, text);\n"
insert = '''    const extractedFacts = await extractFacts(openai, text);\n\n    const explicitVehicleFacts = parseExplicitVehicleFacts(text);\n    for (const [key, value] of Object.entries(explicitVehicleFacts)) {\n      if (key === "sideCode") continue;\n      if (!extractedFacts.some((item: any) => item?.key?.toLowerCase() === key)) {\n        extractedFacts.push({ key, value });\n      }\n    }\n'''
replace_once(anchor, insert, "persist explicit generation/drive/engine/side")

# 10) Fix mileage lookup: mileage belongs to car_facts, not global telegram_facts.
replace_once(
    '''          const savedMileageFacts = await getLongTermFacts(chatId);\n          const savedMileage = savedMileageFacts.find(\n            (item: any) => item.fact_key === "mileage"\n          )?.fact_value;\n\n          const eventCar = await getActiveCar(chatId);\n''',
    '''          const eventCar = await getActiveCar(chatId);\n          const savedMileageFacts = eventCar ? await getCarFacts(eventCar.id) : [];\n          const savedMileage = savedMileageFacts.find(\n            (item: any) => item.fact_key === "mileage"\n          )?.fact_value;\n\n''',
    "fix mileage memory source",
)

# 11) Replace duplicate answer reconstruction with one canonical composer.
replace_between(
    "  answer = cleanRepairAnswerForState(",
    "  if (diagnosticCar && answer)",
    '''  answer = composeRepairAnswer(answer, vehicleState);\n''',
    "simplify final answer construction",
)

# 12) Pass state to image generation and remove dead photoCaption calculation.
replace_once(
    '''            text,\n            answer\n          );''',
    '''            text,\n            answer,\n            vehicleState\n          );''',
    "pass canonical vehicle state to image generator",
)

s = re.sub(
    r'''\n\s*const photoCaption =\n\s*answer\.length > 950\n\s*\? answer\.slice\(0, 947\)\.trimEnd\(\) \+ "\.\.\."\n\s*: answer;\n''',
    "\n",
    s,
    count=1,
)
print("OK: remove dead photoCaption")

# 13) Never truncate the user's diagnostic answer. If it will not fit a photo caption, send text only.
old_final = '''    if (pendingDiagnosticImage) {\n      // Telegram caption ограничен по длине.\n      // Поэтому ответ для фото заранее держим компактным.\n      const caption =\n        answer.length > 950\n          ? answer.slice(0, 947).trimEnd() + "..."\n          : answer;\n\n      await sendPhotoBuffer(\n        chatId,\n        pendingDiagnosticImage,\n        caption\n      );\n    } else {\n      await sendMessage(chatId, answer);\n    }\n'''
new_final = '''    if (pendingDiagnosticImage && cleanTelegramText(answer).length <= 950) {\n      await sendPhotoBuffer(chatId, pendingDiagnosticImage, answer);\n    } else {\n      // Preserve the complete answer rather than silently truncating it.\n      await sendMessage(chatId, answer);\n    }\n'''
replace_once(old_final, new_final, "prevent truncated final answers")

# 14) Do not expose raw OpenAI/internal errors to Telegram users.
error_pattern = re.compile(r'''\s*await sendMessage\(\n\s*chatId,\n\s*`Ошибка OpenAI:[\s\S]*?`\n\s*\);''', re.M)
s, n = error_pattern.subn('''\n    await sendMessage(\n      chatId,\n      "Не удалось обработать запрос. Повтори сообщение ещё раз."\n    );''', s, count=1)
if n != 1:
    raise SystemExit(f"sanitize user-facing error: expected 1 match, found {n}")
print("OK: sanitize user-facing errors")

# 15) Make /set understand structural vehicle keys too.
replace_once(
    '''    "двигатель": "engine",\n    "мотор": "engine",''',
    '''    "двигатель": "engine",\n    "мотор": "engine",\n    "поколение": "generation",\n    "кузов": "generation",\n    "код кузова": "generation",\n    "привод": "drive",\n    "сторона": "side",''',
    "extend /set vehicle aliases",
)

# 16) Show structural facts in /profile.
replace_once(
    '''      ["car_year", "Год выпуска"],\n      ["engine", "Двигатель"],''',
    '''      ["car_year", "Год выпуска"],\n      ["generation", "Поколение / кузов"],\n      ["drive", "Привод"],\n      ["engine", "Двигатель"],\n      ["side", "Сторона ремонта"],''',
    "show structural facts in profile",
)

# Final structural assertions.
for forbidden in ["claimTelegramUpdate(", "isVehicleIdentificationMode(", "isEngineClarificationMode(", "tool_choice: \"required\""]:
    if forbidden in s:
        raise SystemExit(f"Forbidden stale logic remains: {forbidden}")

if s.count("tool_choice: \"auto\"") != 1:
    raise SystemExit("Expected exactly one auto tool_choice")
if s.count("composeRepairAnswer(answer, vehicleState)") != 1:
    raise SystemExit("Expected exactly one canonical answer composer call")
if s.count("pendingDiagnosticImage") < 2:
    raise SystemExit("Image pipeline unexpectedly missing")

PATH.write_text(s)
print("\nRefactor written successfully.")
print(f"Backup: {BACKUP}")

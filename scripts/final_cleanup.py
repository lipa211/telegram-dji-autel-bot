from pathlib import Path
import re
import shutil

PATH = Path("app/api/telegram/route.ts")
BACKUP = Path("app/api/telegram/route.ts.before-final-cleanup")
s = PATH.read_text()
shutil.copy2(PATH, BACKUP)


def replace_once(old: str, new: str, label: str):
    global s
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    s = s.replace(old, new, 1)
    print(f"OK: {label}")


def remove_between(start: str, end: str, label: str):
    global s
    a = s.find(start)
    if a < 0:
        raise SystemExit(f"{label}: start not found")
    b = s.find(end, a)
    if b < 0:
        raise SystemExit(f"{label}: end not found")
    s = s[:a] + s[b:]
    print(f"OK: {label}")

# 1) Remove dead global chat-history reader. Car history uses getRecentCarMessages.
remove_between(
    "async function getRecentMessages(",
    "async function saveMemoryMessage(",
    "remove unused getRecentMessages",
)

# 2) Remove old static visual-guide code; generated image path is the live one.
remove_between(
    "type VisualGuideItem = {",
    "type VehicleSideCode =",
    "remove unused static visual guide",
)

# 3) Remove unused remote-photo helpers; sendPhotoBuffer is the only live generated-image sender.
remove_between(
    "async function sendPhoto(\n",
    "async function telegramFileToDataUrl(",
    "remove unused sendPhoto/sendMediaGroup",
)

# 4) Make generation parsing safe: plain lowercase 'km' mileage must never mean Kia KM body.
old_generation = '''  const generationMatch = text.match(/\\b(KM|SL)\\b/i);\n  if (generationMatch) result.generation = generationMatch[1].toUpperCase();\n'''
new_generation = '''  const generationMatch =\n    text.match(/\\b(KM|SL)\\b/) ||\n    text.match(/(?:кузов|поколение|код кузова|sportage\\s*(?:ii|2)?)[^a-zа-яё0-9]{0,8}\\b(km|sl)\\b/i);\n  if (generationMatch) result.generation = (generationMatch[1] || "").toUpperCase();\n'''
replace_once(old_generation, new_generation, "harden generation parsing")

# 5) Parse a side only when front/rear and left/right form an actual phrase, not merely coexist anywhere.
old_side = '''  const hasRear = /задн\\w*/i.test(text);\n  const hasFront = /передн\\w*/i.test(text);\n  const hasRight = /прав\\w*/i.test(text);\n  const hasLeft = /лев\\w*/i.test(text);\n\n  if (hasRear && hasRight) {\n    result.side = "задняя правая";\n    result.sideCode = "rear_right";\n  } else if (hasRear && hasLeft) {\n    result.side = "задняя левая";\n    result.sideCode = "rear_left";\n  } else if (hasFront && hasRight) {\n    result.side = "передняя правая";\n    result.sideCode = "front_right";\n  } else if (hasFront && hasLeft) {\n    result.side = "передняя левая";\n    result.sideCode = "front_left";\n  }\n'''
new_side = '''  const pair = (a: string, b: string) =>\n    new RegExp(`(?:${a})\\\\w*[^а-яёa-z0-9]{0,8}(?:${b})\\\\w*|(?:${b})\\\\w*[^а-яёa-z0-9]{0,8}(?:${a})\\\\w*`, "i").test(text);\n\n  if (pair("задн", "прав")) {\n    result.side = "задняя правая";\n    result.sideCode = "rear_right";\n  } else if (pair("задн", "лев")) {\n    result.side = "задняя левая";\n    result.sideCode = "rear_left";\n  } else if (pair("передн", "прав")) {\n    result.side = "передняя правая";\n    result.sideCode = "front_right";\n  } else if (pair("передн", "лев")) {\n    result.side = "передняя левая";\n    result.sideCode = "front_left";\n  }\n'''
replace_once(old_side, new_side, "harden side parsing")

# 6) For non-vehicle requests, do not inject a synthetic automobile context message at all.
replace_once(
    '''    let factsText = vehicleContextEnabled\n      ? "Активный автомобиль выбран."\n      : "Автомобильный контекст для этого запроса не используется.";\n''',
    '''    let factsText = "";\n''',
    "remove automobile prompt residue from drone requests",
)

# 7) Remove unused memory placeholder.
replace_once("    const memory: any[] = [];\n\n", "", "remove unused memory variable")

# 8) Split /set storage logically: automotive keys -> active car, everything else -> global chat facts.
old_set_store = '''    const activeCar = await getActiveCar(chatId);\n\n    if (!activeCar) {\n      await sendMessage(\n        chatId,\n        "Сначала создай или выбери автомобиль: /car add"\n      );\n      return Response.json({ ok: true });\n    }\n\n    await saveCarFact(\n      activeCar.id,\n      normalizedKey,\n      value\n    );\n\n    await sendMessage(\n      chatId,\n      `Запомнил: ${rawKey} — ${value}`\n    );\n'''
new_set_store = '''    const carFactKeys = new Set([\n      "car_make", "car_model", "car_year", "generation", "drive", "side",\n      "engine", "vin", "mileage", "license_plate", "transmission",\n      "dtc_codes", "current_problem", "repair_history", "parts",\n      "repair_cost", "service_status"\n    ]);\n\n    if (carFactKeys.has(normalizedKey)) {\n      const activeCar = await getActiveCar(chatId);\n      if (!activeCar) {\n        await sendMessage(chatId, "Для автомобильного факта сначала выбери автомобиль: /cars");\n        return Response.json({ ok: true });\n      }\n      await saveCarFact(activeCar.id, normalizedKey, value);\n      await sendMessage(chatId, `Запомнил в профиле автомобиля: ${rawKey} — ${value}`);\n    } else {\n      await saveFact(chatId, normalizedKey, value);\n      await sendMessage(chatId, `Запомнил в общей памяти: ${rawKey} — ${value}`);\n    }\n'''
replace_once(old_set_store, new_set_store, "route /set to correct memory store")

# 9) Split /del symmetrically using the same key classification.
old_del_store = '''    const activeCar = await getActiveCar(chatId);\n    const supabase = getSupabase();\n\n    if (!supabase || !activeCar) {\n      await sendMessage(chatId, "Сначала выбери автомобиль: /cars");\n      return Response.json({ ok: true });\n    }\n\n    const { error } = await supabase\n      .from("car_facts")\n      .delete()\n      .eq("car_id", activeCar.id)\n      .eq("fact_key", normalizedKey);\n\n    if (error) {\n      console.error("delete car fact error:", error);\n      await sendMessage(chatId, "Не получилось удалить факт автомобиля.");\n    } else {\n      await sendMessage(chatId, `Удалил из профиля автомобиля: ${rawKey}`);\n    }\n'''
new_del_store = '''    const carFactKeys = new Set([\n      "car_make", "car_model", "car_year", "generation", "drive", "side",\n      "engine", "vin", "mileage", "license_plate", "transmission",\n      "dtc_codes", "current_problem", "repair_history", "parts",\n      "repair_cost", "service_status"\n    ]);\n    const supabase = getSupabase();\n\n    if (!supabase) {\n      await sendMessage(chatId, "Не удалось открыть память.");\n      return Response.json({ ok: true });\n    }\n\n    if (carFactKeys.has(normalizedKey)) {\n      const activeCar = await getActiveCar(chatId);\n      if (!activeCar) {\n        await sendMessage(chatId, "Для автомобильного факта сначала выбери автомобиль: /cars");\n        return Response.json({ ok: true });\n      }\n      const { error } = await supabase\n        .from("car_facts")\n        .delete()\n        .eq("car_id", activeCar.id)\n        .eq("fact_key", normalizedKey);\n      if (error) {\n        console.error("delete car fact error:", error);\n        await sendMessage(chatId, "Не получилось удалить факт автомобиля.");\n      } else {\n        await sendMessage(chatId, `Удалил из профиля автомобиля: ${rawKey}`);\n      }\n    } else {\n      const { error } = await supabase\n        .from("telegram_facts")\n        .delete()\n        .eq("chat_id", chatId)\n        .eq("fact_key", normalizedKey);\n      if (error) {\n        console.error("delete global fact error:", error);\n        await sendMessage(chatId, "Не получилось удалить факт из общей памяти.");\n      } else {\n        await sendMessage(chatId, `Удалил из общей памяти: ${rawKey}`);\n      }\n    }\n'''
replace_once(old_del_store, new_del_store, "route /del to correct memory store")

# 10) Don't pay for an image we cannot send in the one-message policy.
old_image_cond = '''      vehicleContextEnabled &&\n      diagnosticCar &&\n      shouldGenerateDiagnosticImage(text, answer)\n'''
new_image_cond = '''      vehicleContextEnabled &&\n      diagnosticCar &&\n      cleanTelegramText(answer).length <= 950 &&\n      shouldGenerateDiagnosticImage(text, answer)\n'''
replace_once(old_image_cond, new_image_cond, "avoid unused image generation for long answers")

# 11) Make help text describe the split memory semantics.
replace_once(
    '''        "/set ключ = значение — сохранить факт",\n        "/del ключ — удалить один факт",\n        "/forget — очистить долгую память",''',
    '''        "/set ключ = значение — сохранить факт (авто → профиль машины, остальное → общая память)",\n        "/del ключ — удалить факт из соответствующей памяти",\n        "/forget — очистить общую долгую память чата",''',
    "clarify memory commands",
)

# Final sanity checks.
for forbidden in ["getRecentMessages(", "getVisualGuideForCase(", "sendMediaGroup(", "async function sendPhoto(\n", "const memory: any[]"]:
    if forbidden in s:
        raise SystemExit(f"dead code remains: {forbidden}")

if s.count("const carFactKeys = new Set([") != 2:
    raise SystemExit("expected matching /set and /del car key classification")
if "cleanTelegramText(answer).length <= 950" not in s:
    raise SystemExit("image length guard missing")

PATH.write_text(s)
print("Final cleanup written successfully")

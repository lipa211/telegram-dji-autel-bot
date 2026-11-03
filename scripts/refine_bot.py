from pathlib import Path
import re
import shutil

PATH = Path("app/api/telegram/route.ts")
BACKUP = Path("app/api/telegram/route.ts.before-second-pass")
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

# 1) Service-event de-duplication must be scoped to the active car.
old = '''    const { data: lastEvent } = await supabase\n      .from("service_events")\n      .select("event_type,event_value")\n      .eq("chat_id", chatId)\n      .eq("event_type", eventType)\n      .order("created_at", { ascending: false })\n      .limit(1)\n      .maybeSingle();\n'''
new = '''    let lastEventQuery = supabase\n      .from("service_events")\n      .select("event_type,event_value")\n      .eq("chat_id", chatId)\n      .eq("event_type", eventType);\n\n    if (carId) {\n      lastEventQuery = lastEventQuery.eq("car_id", carId);\n    }\n\n    const { data: lastEvent } = await lastEventQuery\n      .order("created_at", { ascending: false })\n      .limit(1)\n      .maybeSingle();\n'''
replace_once(old, new, "scope service-event dedupe to car")

# 2) Add explicit domain routing so an active car never contaminates DJI/Autel questions.
domain_helper = r'''function isDroneRequest(text: string) {
  const value = text.toLowerCase();
  return [
    "dji", "mavic", "мавик", "matrice", "матрич", "autel", "аутел",
    "дрон", "квадрокоптер", "прошивка 1001", "firmware 1001",
    "rc pro", "o3", "o4", "дополнительная батарея", "внешняя батарея"
  ].some((word) => value.includes(word));
}

'''
anchor = "export async function POST(req: Request) {"
if "function isDroneRequest(" not in s:
    s = s.replace(anchor, domain_helper + anchor, 1)
    print("OK: add drone/vehicle domain routing")
else:
    raise SystemExit("isDroneRequest already exists unexpectedly")

# 3) For strict one-request/one-answer behavior, process only original message updates.
replace_once(
    "  const message = update?.message ?? update?.edited_message;\n",
    "  const message = update?.message;\n",
    "ignore edited_message replies",
)

# 4) Fetch active car once before fact extraction and disable vehicle context for drone requests.
replace_once(
    '''    const memory: any[] = [];\n\n    const extractedFacts = await extractFacts(openai, text);\n''',
    '''    const memory: any[] = [];\n\n    const diagnosticCar = await getActiveCar(chatId);\n    const vehicleContextEnabled = Boolean(diagnosticCar) && !isDroneRequest(text);\n\n    const extractedFacts = vehicleContextEnabled\n      ? await extractFacts(openai, text)\n      : [];\n''',
    "route domain before auto fact extraction",
)

# Remove later duplicate active-car fetch.
replace_once(
    "    const diagnosticCar = await getActiveCar(chatId);\n\n    let factsText = \"Активный автомобиль не выбран.\";\n",
    "    let factsText = vehicleContextEnabled\n      ? \"Активный автомобиль выбран.\"\n      : \"Автомобильный контекст для этого запроса не используется.\";\n",
    "remove duplicate active-car lookup",
)

# Save extracted car facts only when vehicle context is active; reuse already selected car.
replace_once(
    '''        const activeCar = await getActiveCar(chatId);\n\n        if (activeCar) {\n          await saveCarFact(\n            activeCar.id,\n            factKey,\n            factValue\n          );\n        }\n''',
    '''        if (vehicleContextEnabled && diagnosticCar) {\n          await saveCarFact(\n            diagnosticCar.id,\n            factKey,\n            factValue\n          );\n        }\n''',
    "reuse active car for extracted facts",
)

# Simplify service-event block to the same selected car.
old_event = '''          const eventCar = await getActiveCar(chatId);\n          const savedMileageFacts = eventCar ? await getCarFacts(eventCar.id) : [];\n          const savedMileage = savedMileageFacts.find(\n            (item: any) => item.fact_key === "mileage"\n          )?.fact_value;\n\n\n          if (eventCar) {\n            await saveServiceEvent(\n              chatId,\n              factKey,\n              factValue,\n              mileageFact?.value || savedMileage,\n              eventCar.id\n            );\n          }\n'''
new_event = '''          const savedMileageFacts = diagnosticCar\n            ? await getCarFacts(diagnosticCar.id)\n            : [];\n          const savedMileage = savedMileageFacts.find(\n            (item: any) => item.fact_key === "mileage"\n          )?.fact_value;\n\n          if (vehicleContextEnabled && diagnosticCar) {\n            await saveServiceEvent(\n              chatId,\n              factKey,\n              factValue,\n              mileageFact?.value || savedMileage,\n              diagnosticCar.id\n            );\n          }\n'''
replace_once(old_event, new_event, "reuse active car for service events")

# Gate all vehicle-specific memory/context behind the domain decision.
replace_once("    if (diagnosticCar) {\n", "    if (vehicleContextEnabled && diagnosticCar) {\n", "gate factsText to vehicle domain")
replace_once(
    '''    const diagnosticMessages = diagnosticCar\n      ? await getRecentCarMessages(diagnosticCar.id, 12)\n      : [];\n\n    if (diagnosticCar && text) {\n''',
    '''    const diagnosticMessages = vehicleContextEnabled && diagnosticCar\n      ? await getRecentCarMessages(diagnosticCar.id, 12)\n      : [];\n\n    if (vehicleContextEnabled && diagnosticCar && text) {\n''',
    "gate car conversation memory",
)

# 5) Remove unconditional identification prohibitions from the main model prompt.
conflict_start = '''- если версия узла не подтверждена, не описывай конкретную последовательность его разборки;\n'''
conflict_end = '''- после подтверждения версии уже можно давать точную процедуру ремонта и подробную картинку;\n'''
a = s.find(conflict_start)
b = s.find(conflict_end, a)
if a < 0 or b < 0:
    raise SystemExit("main prompt conflict block not found")
b += len(conflict_end)
replacement = '''- если версия автомобиля или узла НЕ подтверждена, не давай точную последовательность разборки;\n- если поколение/кузов, привод и двигатель подтверждены сохранённым профилем или текущим сообщением, не возвращайся к идентификации и можно давать применимую процедуру ремонта;\n- никогда не проси повторно параметры, уже присутствующие в профиле активного автомобиля;\n'''
s = s[:a] + replacement + s[b:]
print("OK: remove unconditional repair prohibitions")

# Remove explicit source/link contradiction near the end of the prompt.
replace_once(
    "- если найден источник, оставляй ссылку или цитирование;\n",
    "- если интернет использован для проверки, используй проверенные сведения без вывода URL и списка источников, если пользователь сам их не попросил;\n",
    "remove source-display contradiction",
)

# 6) Make the model aware that DJI/Autel and automotive questions are separate domains.
replace_once(
    "Ты опытный AI-помощник автосервиса и автомеханика. Помогаешь диагностировать автомобили по симптомам, кодам ошибок, фото, видео и описанию владельца.\n",
    "Ты технический диагност. Для автомобильных запросов работаешь как опытный автомеханик. Для DJI, Mavic, Matrice и Autel отвечаешь как специалист по дронам и их электронике. Никогда не смешивай данные активного автомобиля с запросом про дрон.\n",
    "clarify dual-domain role",
)

# 7) Vehicle state post-processing only applies to vehicle-domain requests.
replace_once(
    '''    const repairFacts = diagnosticCar\n    ? await getCarFacts(diagnosticCar.id)\n    : [];\n''',
    '''    const repairFacts = vehicleContextEnabled && diagnosticCar\n    ? await getCarFacts(diagnosticCar.id)\n    : [];\n''',
    "gate repair facts",
)

replace_once(
    "  answer = composeRepairAnswer(answer, vehicleState);\n\n  if (diagnosticCar && answer) {\n",
    '''  if (vehicleContextEnabled) {\n    answer = composeRepairAnswer(answer, vehicleState);\n  }\n\n  if (vehicleContextEnabled && diagnosticCar && answer) {\n''',
    "compose repair answer only for vehicle domain",
)

replace_once(
    '''      diagnosticCar &&\n      shouldGenerateDiagnosticImage(text, answer)\n''',
    '''      vehicleContextEnabled &&\n      diagnosticCar &&\n      shouldGenerateDiagnosticImage(text, answer)\n''',
    "gate automotive image generation",
)

replace_once(
    "    if (diagnosticCar && text && answer) {\n",
    "    if (vehicleContextEnabled && diagnosticCar && text && answer) {\n",
    "gate diagnostic summary",
)

# 8) /del must delete the same car_facts table where /set writes.
old_del = '''    const supabase = getSupabase();\n\n    if (!supabase) {\n      await sendMessage(chatId, "Не удалось открыть память.");\n      return Response.json({ ok: true });\n    }\n\n    const { error } = await supabase\n      .from("telegram_facts")\n      .delete()\n      .eq("chat_id", chatId)\n      .eq("fact_key", normalizedKey);\n\n    if (error) {\n      console.error("delete fact error:", error);\n      await sendMessage(chatId, "Не получилось удалить факт.");\n    } else {\n      await sendMessage(chatId, `Удалил: ${rawKey}`);\n    }\n'''
new_del = '''    const activeCar = await getActiveCar(chatId);\n    const supabase = getSupabase();\n\n    if (!supabase || !activeCar) {\n      await sendMessage(chatId, "Сначала выбери автомобиль: /cars");\n      return Response.json({ ok: true });\n    }\n\n    const { error } = await supabase\n      .from("car_facts")\n      .delete()\n      .eq("car_id", activeCar.id)\n      .eq("fact_key", normalizedKey);\n\n    if (error) {\n      console.error("delete car fact error:", error);\n      await sendMessage(chatId, "Не получилось удалить факт автомобиля.");\n    } else {\n      await sendMessage(chatId, `Удалил из профиля автомобиля: ${rawKey}`);\n    }\n'''
replace_once(old_del, new_del, "make /del symmetric with /set")

# Mirror the structural aliases in /del too.
old_alias_tail = '''      "прошивка": "firmware_version",\n      "дрон": "drone_model",\n    };\n\n    const normalizedKey =\n'''
# There are two alias objects; patch the second occurrence only.
positions = [m.start() for m in re.finditer(re.escape(old_alias_tail), s)]
if len(positions) != 1:
    # After first-pass /set expansion, only /del retains this exact tail.
    raise SystemExit(f"/del alias tail expected once, found {len(positions)}")
pos = positions[0]
new_alias_tail = '''      "прошивка": "firmware_version",\n      "дрон": "drone_model",\n      "марка": "car_make",\n      "модель": "car_model",\n      "год": "car_year",\n      "год выпуска": "car_year",\n      "двигатель": "engine",\n      "мотор": "engine",\n      "поколение": "generation",\n      "кузов": "generation",\n      "код кузова": "generation",\n      "привод": "drive",\n      "сторона": "side",\n      "vin": "vin",\n      "вин": "vin",\n      "пробег": "mileage",\n      "коробка": "transmission",\n      "кпп": "transmission",\n    };\n\n    const normalizedKey =\n'''
s = s[:pos] + s[pos:].replace(old_alias_tail, new_alias_tail, 1)
print("OK: extend /del aliases")

# 9) Guard assistant car-message save in case a drone answer is produced with an active car selected.
# This was already patched by the exact block above; verify only.
if "if (vehicleContextEnabled && diagnosticCar && answer)" not in s:
    raise SystemExit("assistant car-message domain guard missing")

# Structural checks.
for forbidden in [
    "const message = update?.message ?? update?.edited_message",
    "- если найден источник, оставляй ссылку или цитирование;",
    '.from("telegram_facts")\n      .delete()\n      .eq("chat_id", chatId)\n      .eq("fact_key", normalizedKey)',
]:
    if forbidden in s:
        raise SystemExit(f"stale logic remains: {forbidden}")

if s.count("vehicleContextEnabled") < 8:
    raise SystemExit("vehicle domain routing not applied broadly enough")
if s.count("function isDroneRequest(") != 1:
    raise SystemExit("expected exactly one isDroneRequest")

PATH.write_text(s)
print("Second-pass refinement written successfully")

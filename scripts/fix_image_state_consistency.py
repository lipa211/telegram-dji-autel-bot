from pathlib import Path
import re

p = Path('app/api/telegram/route.ts')
s = p.read_text()

pattern = re.compile(r'async function generateDiagnosticImage\([\s\S]*?\n}\n\nfunction shouldGenerateDiagnosticImage\(', re.M)

replacement = r'''async function generateDiagnosticImage(
  openai: any,
  carName: string,
  problem: string,
  diagnosis: string,
  state: VehicleRepairState
) {
  try {
    const knownFacts = [
      state.model,
      state.generation,
      state.drive,
      state.engine ? `двигатель ${state.engine}` : undefined,
      state.side,
    ]
      .filter(Boolean)
      .join(", ");

    const missingFacts = state.missing.length
      ? state.missing.join(", ")
      : "нет";

    const sideInstruction = state.sideCode
      ? `TARGET_SIDE_CODE: ${state.sideCode.toUpperCase()}. Это сторона автомобиля по ходу движения. Никогда не зеркаль и не меняй её. Для ориентации используй маленькую схему ВИД СВЕРХУ, а не перспективный вид автомобиля.`
      : "Сторона автомобиля не подтверждена: не выбирай левую или правую сторону самостоятельно.";

    const stateContract = state.mode === "CONFIRMED"
      ? `
STATE_LOCK: CONFIRMED.
ИЗВЕСТНЫЕ ДАННЫЕ: ${knownFacts || "автомобиль подтверждён"}.
MISSING_FIELDS: NONE.

ЖЁСТКИЙ ЗАПРЕТ ДЛЯ CONFIRMED:
- НЕ пиши \"Требует уточнения\";
- НЕ пиши \"Сначала уточнить\";
- НЕ проси повторно поколение, кузов, привод, двигатель или сторону;
- НЕ показывай альтернативные 2WD/4WD или другие поколения;
- НЕ создавай карточки \"Подтверждено / Требует уточнения\" вообще;
- верхний заголовок может содержать только подтверждённые данные и название ремонта.

Это финальная ремонтная иллюстрация для уже определённой версии автомобиля.`
      : state.mode === "PARTIAL"
        ? `
STATE_LOCK: PARTIAL.
ИЗВЕСТНЫЕ ДАННЫЕ: ${knownFacts || "частично подтверждены"}.
ЕДИНСТВЕННО НЕДОСТАЁТ: ${missingFacts}.

Покажи только одну короткую заметку: \"Для точных деталей уточнить: ${missingFacts}\".
НЕ проси повторно уже известные поколение/кузов/привод/сторону.
НЕ добавляй другие недостающие поля от себя.`
        : `
STATE_LOCK: UNKNOWN.
ИЗВЕСТНЫЕ ДАННЫЕ: ${knownFacts || "недостаточно данных"}.
НЕДОСТАЮЩИЕ ДАННЫЕ: ${missingFacts}.

Это только схема идентификации. Не показывай демонтаж и не придумывай точную конструкцию узла.`;

    const result = await openai.images.generate({
      model: "gpt-image-2.5-flare",
      size: "1024x1536",
      prompt: `
Создай вертикальную техническую иллюстрацию для автомеханика на русском языке.

Автомобиль: ${carName}
Проблема: ${problem}
Диагностический текст: ${diagnosis}

${stateContract}
${sideInstruction}

ОБЯЗАТЕЛЬНАЯ ЛОГИКА:
- состояние автомобиля задаётся кодом выше и НЕ МОЖЕТ быть переопределено изображением;
- если STATE_LOCK=CONFIRMED, на изображении не должно быть ни одной фразы об уточнении версии автомобиля;
- если STATE_LOCK=PARTIAL, допускается упоминать ТОЛЬКО поля из строки \"ЕДИНСТВЕННО НЕДОСТАЁТ\";
- если STATE_LOCK=UNKNOWN, только тогда разрешён режим идентификации;
- не смешивай эти три режима на одной картинке.

ОРИЕНТАЦИЯ:
- стороны автомобиля всегда определяются по ходу движения;
- добавь небольшую схему ВИД СВЕРХУ с надписями: \"ПЕРЕД АВТОМОБИЛЯ ↑\" и \"ЛЕВО ←   → ПРАВО\";
- если задан TARGET_SIDE_CODE, выдели именно эту четверть автомобиля на виде сверху;
- не используй перспективный вид автомобиля как доказательство стороны;
- не используй \"водительская/пассажирская сторона\".

ТЕХНИЧЕСКИЕ ПРАВИЛА:
- максимум 4-5 ключевых шагов;
- изображение строго соответствует диагностическому тексту;
- не смешивай поколения, кузова, 2WD/4WD или варианты узла;
- не изображай предположение как подтверждённую конструкцию;
- не придумывай номера предохранителей, реле, контактов, распиновку, цвет проводов, каталожные номера или точный крепёж;
- числовой момент затяжки показывай только если в тексте он явно помечен VERIFIED; иначе напиши: \"Момент затяжки — сверить по сервисным данным / VIN\";
- не рисуй URL, QR-коды, сайты, водяные знаки, слова source/catalog/manual;
- называй результат только наглядной схемой или иллюстрацией, не официальной сервисной схемой.

КОНТРОЛЬ ПЕРЕД ГЕНЕРАЦИЕЙ:
1. Сверь STATE_LOCK.
2. Сверь известные и недостающие поля.
3. Убедись, что ни один подтверждённый параметр не попал в блок уточнения.
4. Убедись, что сторона не зеркальна.
5. Только после этого рисуй.
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

function shouldGenerateDiagnosticImage('''

new_s, n = pattern.subn(replacement, s, count=1)
if n != 1:
    raise SystemExit(f'Expected one generateDiagnosticImage block, replaced {n}')

p.write_text(new_s)
print('OK: image state consistency hardened')

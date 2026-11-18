export type VehicleSideCode =
  | "front_left"
  | "front_right"
  | "rear_left"
  | "rear_right";

export type VehicleRepairState = {
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

export function parseExplicitVehicleFacts(text: string) {
  const lower = text.toLowerCase();
  const result: Record<string, string> = {};

  const generationMatch =
    text.match(/\b(KM|SL)\b/i) ||
    text.match(/(?:кузов|поколение|код кузова|sportage\s*(?:ii|2)?)[^a-zа-яё0-9]{0,8}\b(km|sl)\b/i);
  if (generationMatch) result.generation = (generationMatch[1] || "").toUpperCase();

  const has2wd = /\b2\s*wd\b/i.test(text) || lower.includes("передний привод");
  const has4wd = /\b4\s*wd\b/i.test(text) || lower.includes("полный привод");
  if (has2wd && !has4wd) result.drive = "2WD";
  if (has4wd && !has2wd) result.drive = "4WD";
  if (has2wd && has4wd) {
    // Comparison ("2WD или 4WD?") is not a confirmed drive.
    // A clear correction ("не 4WD, а 2WD") is an exception.
    const deny4 = /\bне\s*(?:4\s*wd|полный\s+привод)\b/i.test(text);
    const deny2 = /\bне\s*(?:2\s*wd|передний\s+привод)\b/i.test(text);
    if (deny4 !== deny2) result.drive = deny4 ? "2WD" : "4WD";
  }

  const engineMatch = text.match(/(?:двигател[ья]?|мотор|объ[её]м)[^\d]{0,12}(1[.,]6|2[.,]0|2[.,]4|2[.,]7|3[.,]3)|\b(1[.,]6|2[.,]0|2[.,]4|2[.,]7|3[.,]3)\s*(?:л|литр)/i);
  const engine = engineMatch?.[1] || engineMatch?.[2];
  if (engine) result.engine = engine.replace(",", ".");

  // Preserve the actual location rather than matching the first occurrence
  // of "правый" or "левый" anywhere in a long user message.
  const sides: Array<{ code: VehicleSideCode; label: string; pattern: RegExp }> = [
    { code: "rear_right", label: "задняя правая", pattern: /(?:задн[а-яё]*[\s,]{1,16}прав[а-яё]*|прав[а-яё]*[\s,]{1,16}задн[а-яё]*|справа\s+сзади|сзади\s+справа)/gi },
    { code: "rear_left", label: "задняя левая", pattern: /(?:задн[а-яё]*[\s,]{1,16}лев[а-яё]*|лев[а-яё]*[\s,]{1,16}задн[а-яё]*|слева\s+сзади|сзади\s+слева)/gi },
    { code: "front_right", label: "передняя правая", pattern: /(?:передн[а-яё]*[\s,]{1,16}прав[а-яё]*|прав[а-яё]*[\s,]{1,16}передн[а-яё]*|справа\s+спереди|спереди\s+справа)/gi },
    { code: "front_left", label: "передняя левая", pattern: /(?:передн[а-яё]*[\s,]{1,16}лев[а-яё]*|лев[а-яё]*[\s,]{1,16}передн[а-яё]*|слева\s+спереди|спереди\s+слева)/gi },
  ];
  const matches = sides.flatMap((side) =>
    [...text.matchAll(side.pattern)].map((match) => ({
      ...side, index: match.index ?? -1,
    }))
  ).sort((a, b) => a.index - b.index);
  // When both sides are mentioned, don't silently overwrite the selected side.
  const uniqueSides = new Set(matches.map((match) => match.code));
  if (uniqueSides.size === 1 && matches[0]) {
    result.side = matches[0].label;
    result.sideCode = matches[0].code;
  }

  return result;
}

export function deriveVehicleRepairState(
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

export function composeRepairAnswer(answer: string, state: VehicleRepairState): string {
  const cleaned = cleanRepairAnswerForState(answer, state);
  const header = vehicleStateHeader(state);

  // Missing profile details must not erase the actual diagnostic answer.
  // This is especially important for general checks that do not require VIN.
  if (state.mode === "UNKNOWN") {
    return `${header}\n\n${cleaned}\n\nПеред применением точных каталожных номеров и моментов затяжки уточни недостающие параметры автомобиля.`
      .replace(/\n{3,}/g, "\n\n").trim();
  }
  if (state.mode === "PARTIAL") {
    return `${header}\n\n${cleaned}\n\nЕсли деталь или момент затяжки зависит от двигателя, уточни двигатель или VIN.`
      .replace(/\n{3,}/g, "\n\n").trim();
  }
  return `${header}\n\n${cleaned}`.replace(/\n{3,}/g, "\n\n").trim();
}


export function isAmbiguousDriveMention(text: string): boolean {
  const lower = text.toLowerCase();
  const both = (/\b2\s*wd\b/i.test(text) || lower.includes("передний привод")) &&
    (/\b4\s*wd\b/i.test(text) || lower.includes("полный привод"));
  return both && !parseExplicitVehicleFacts(text).drive;
}

export function isAmbiguousSideMention(text: string): boolean {
  const left = /(?:\bлев[а-яё]*\b|\bслева\b)/i.test(text);
  const right = /(?:\bправ[а-яё]*\b|\bсправа\b)/i.test(text);
  if (!left || !right) return false;

  // Explicit corrections carry an unambiguous intent despite mentioning both.
  const negatedLeft = /\bне\s+лев[а-яё]*\b/i.test(text);
  const negatedRight = /\bне\s+прав[а-яё]*\b/i.test(text);
  return negatedLeft === negatedRight;
}

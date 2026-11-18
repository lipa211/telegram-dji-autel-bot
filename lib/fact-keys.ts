// Shared key aliases for /set and /del. Both commands must target the same row.
export const CAR_FACT_KEYS = new Set([
  "car_make", "car_model", "car_year", "generation", "drive", "side",
  "engine", "vin", "mileage", "license_plate", "transmission",
  "dtc_codes", "current_problem", "repair_history", "parts",
  "repair_cost", "service_status",
]);

const ALIASES: Record<string, string> = {
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

export function normalizeFactKey(rawKey: string): string {
  const normalized = rawKey.trim().toLowerCase();
  return ALIASES[normalized] ||
    normalized.replace(/[^a-zа-яё0-9]+/gi, "_").replace(/^_+|_+$/g, "");
}

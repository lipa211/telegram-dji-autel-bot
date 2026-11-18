import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFactKey, CAR_FACT_KEYS } from "../lib/fact-keys.ts";

test("aliases for memory deletion and saving resolve identically", () => {
  const cases = {
    "ошибка": "dtc_codes",
    "код ошибки": "dtc_codes",
    "запчасти": "parts",
    "госномер": "license_plate",
    "двигатель": "engine",
    "прошивка": "firmware_version",
    "вес батареи": "additional_battery_weight",
  };
  for (const [input, output] of Object.entries(cases)) {
    assert.equal(normalizeFactKey(input), output);
  }
});

test("automotive keys never fall into global memory", () => {
  for (const key of ["код ошибки", "госномер", "запчасти", "двигатель"]) {
    assert.equal(CAR_FACT_KEYS.has(normalizeFactKey(key)), true, key);
  }
  assert.equal(CAR_FACT_KEYS.has(normalizeFactKey("прошивка")), false);
});

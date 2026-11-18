import test from "node:test";
import assert from "node:assert/strict";
import {
  parseExplicitVehicleFacts,
  deriveVehicleRepairState,
  composeRepairAnswer,
  isAmbiguousDriveMention,
} from "../lib/vehicle-logic.ts";

test("vehicle side is oriented along travel direction, not camera direction", () => {
  const cases = [
    ["задняя правая ступица", "rear_right"],
    ["правая задняя ступица", "rear_right"],
    ["сзади справа", "rear_right"],
    ["задняя левая", "rear_left"],
    ["слева сзади", "rear_left"],
    ["передняя правая", "front_right"],
    ["справа спереди", "front_right"],
    ["передняя левая", "front_left"],
    ["слева спереди", "front_left"],
  ];
  for (const [text, expected] of cases) {
    assert.equal(parseExplicitVehicleFacts(text).sideCode, expected, text);
  }
});

test("ambiguous sides are not silently saved", () => {
  const parsed = parseExplicitVehicleFacts("передняя левая и задняя правая");
  assert.equal(parsed.sideCode, undefined);
  assert.equal(parsed.side, undefined);
});

test("current explicit statements beat stale saved drive/side", () => {
  const facts = {
    car_model: "Sportage",
    generation: "KM",
    drive: "4WD",
    engine: "2.0",
    side: "задняя левая",
  };
  const state = deriveVehicleRepairState(facts, "Это 2WD, задняя правая ступица");
  assert.equal(state.drive, "2WD");
  assert.equal(state.sideCode, "rear_right");
  assert.equal(state.mode, "CONFIRMED");
});

test("known car parameters are not repeatedly requested", () => {
  const facts = {
    car_model: "Sportage", generation: "KM", drive: "2WD",
    engine: "2.0", side: "задняя правая",
  };
  const state = deriveVehicleRepairState(facts, "как проверить ступицу?");
  const answer = composeRepairAnswer("Сначала проверь люфт колеса.", state);
  assert.match(answer, /Сначала проверь люфт колеса/);
  assert.doesNotMatch(answer, /Требует уточнения/);
  assert.doesNotMatch(answer, /Для точной инструкции сначала/);
});

test("missing car details do not erase safe general diagnostics", () => {
  const state = deriveVehicleRepairState({car_model:"Sportage"}, "Почему стучит?");
  const answer = composeRepairAnswer("Проверь люфт и крепления на подъёмнике.", state);
  assert.match(answer, /Проверь люфт/);
  assert.match(answer, /уточни недостающие параметры/);
});

test("missing engine does not falsely mark version fully confirmed", () => {
  const state = deriveVehicleRepairState({
    car_model: "Sportage", generation: "KM", drive: "2WD",
  }, "как проверить?");
  assert.equal(state.mode, "PARTIAL");
  assert.deepEqual(state.missing, ["двигатель"]);
});

test("a fresh saved side is retained if current request names no side", () => {
  const state = deriveVehicleRepairState({
    car_model:"Sportage", generation:"KM", drive:"2WD",
    engine:"2.0", side:"задняя правая",
  }, "Как заменить подшипник?");
  assert.equal(state.sideCode, "rear_right");
});

test("comparisons of vehicle drives must not overwrite confirmed facts", () => {
  assert.equal(parseExplicitVehicleFacts("Для 2WD и 4WD разные ступицы?").drive, undefined);
  assert.equal(isAmbiguousDriveMention("Для 2WD и 4WD разные ступицы?"), true);
  const state = deriveVehicleRepairState({
    car_model: "Sportage", generation: "KM", drive: "2WD", engine: "2.0"
  }, "А для 2WD и 4WD одинаковые узлы?");
  assert.equal(state.drive, "2WD");
  assert.equal(parseExplicitVehicleFacts("У меня не 4WD, а 2WD").drive, "2WD");
  assert.equal(parseExplicitVehicleFacts("Нет, это не 2WD, а 4WD").drive, "4WD");
});

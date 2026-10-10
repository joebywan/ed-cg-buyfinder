import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MIXED, MIXED_COLS, cleanCols, moveCol, toggleCol } from "../src/columns.js";
import { loadPrefs } from "../src/prefs.js";
import { buildMixed } from "../src/model.js";

test("defaults are today's columns and all registered", () => {
  assert.equal(DEFAULT_MIXED.length, 10);
  assert.deepEqual(loadPrefs(null).cols_mixed, DEFAULT_MIXED);
  for (const id of DEFAULT_MIXED) assert.ok(MIXED_COLS.some((c) => c.id === id));
  for (const c of MIXED_COLS) assert.ok(c.title && c.label);
});

test("unknown, duplicate and junk saved ids are ignored", () => {
  assert.deepEqual(cleanCols(["ly", "nope", "ly", 5, "supply"]), ["ly", "supply"]);
  assert.deepEqual(cleanCols(["nope"]), DEFAULT_MIXED);
  assert.deepEqual(cleanCols("x"), DEFAULT_MIXED);
  assert.deepEqual(loadPrefs({ cols_mixed: ["buy", "zzz"] }).cols_mixed, ["buy"]);
});

test("toggle adds at the end, removes, and keeps STATION", () => {
  assert.deepEqual(toggleCol(["ly"], "supply"), ["ly", "supply"]);
  assert.deepEqual(toggleCol(["ly", "supply"], "ly"), ["supply"]);
  assert.deepEqual(toggleCol(["station", "ly"], "station"), ["station", "ly"]);
  assert.deepEqual(toggleCol(["ly"], "nope"), ["ly"]);
});

test("moveCol swaps neighbours and clamps at the ends", () => {
  assert.deepEqual(moveCol(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveCol(["a", "b", "c"], "a", -1), ["a", "b", "c"]);
  assert.deepEqual(moveCol(["a", "b", "c"], "c", 1), ["a", "b", "c"]);
});

test("mixed plans carry supply: per commodity, summed per station", () => {
  const r = (c, supply, profit) => ({ commodity: c, station: "S", system: "Y", supply, profit_per_t: profit, buy: 1, trip_minutes: 10, ly: 1, ls: 1 });
  const [p] = buildMixed([r("Gold", 40, 9), r("Tea", 500, 1)], 100);
  assert.deepEqual(p.mix.map((m) => m.supply), [40, 500]);
  assert.equal(p.supply, 540);
});

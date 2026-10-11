import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MIXED, MIXED_COLS, cleanCols, moveCol, toggleCol } from "../src/columns.js";
import { loadPrefs } from "../src/prefs.js";
import { buildMixed } from "../src/model.js";

test("defaults are today's columns and all registered", () => {
  assert.equal(DEFAULT_MIXED.length, 11);
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

import { DEFAULT_SINGLE, SINGLE_COLS, cleanWidths, colWidths, placeCol } from "../src/columns.js";

test("ALL SOURCES columns default to today's and clean like the mixed ones", () => {
  assert.equal(DEFAULT_SINGLE.length, 14);
  assert.ok(!DEFAULT_SINGLE.includes("pad") && SINGLE_COLS.some((c) => c.id === "pad"));
  assert.deepEqual(loadPrefs(null).cols_single, DEFAULT_SINGLE);
  assert.deepEqual(loadPrefs({ cols_single: ["pad", "zzz", "pad"] }).cols_single, ["pad"]);
  assert.deepEqual(cleanCols(["total"], "single"), DEFAULT_SINGLE);   // a mixed-only id is unknown here
  assert.deepEqual(toggleCol(["ly"], "pad", "single"), ["ly", "pad"]);
  assert.ok(MIXED_COLS.some((c) => c.id === "pad") && !DEFAULT_MIXED.includes("pad"));
});

test("widths: unknown ids dropped, clamped, junk ignored, defaults fill in", () => {
  assert.deepEqual(cleanWidths({ ly: 5, station: 99999, zzz: 80, buy: "x", ls: 120.4 }),
    { ly: 30, station: 1200, ls: 120 });
  assert.deepEqual(cleanWidths(null), {});
  assert.deepEqual(loadPrefs({ colw_single: { src: 70, total: 90 } }).colw_single, { src: 70 });
  assert.deepEqual(colWidths(["station", "ly", "pad"], { ly: 55 }, "mixed", 10), [180, 55, 60]);
});

test("placeCol drops before or after the target", () => {
  assert.deepEqual(placeCol(["a", "b", "c", "d"], "a", "c"), ["b", "a", "c", "d"]);
  assert.deepEqual(placeCol(["a", "b", "c", "d"], "a", "c", true), ["b", "c", "a", "d"]);
  assert.deepEqual(placeCol(["a", "b", "c", "d"], "d", "a"), ["d", "a", "b", "c"]);
  assert.deepEqual(placeCol(["a", "b"], "a", "a"), ["a", "b"]);
  assert.deepEqual(placeCol(["a", "b"], "a", "x"), ["a", "b"]);
});

test("mixed plans: EDSM confirmed only if all rows are, pending if any; pad carried", () => {
  const r = (c, o) => ({ commodity: c, station: "S", system: "Y", supply: 10, profit_per_t: 5, buy: 1, trip_minutes: 10, ly: 1, ls: 1, pad: "M", ...o });
  const plan = (rows) => buildMixed(rows, 100)[0];
  assert.equal(plan([r("A", { edsm: true }), r("B", { edsm: true })]).confirmed, true);
  assert.equal(plan([r("A", { edsm: true }), r("B", { pending: true })]).confirmed, false);
  assert.equal(plan([r("A", { edsm: true }), r("B", { pending: true })]).pending, true);
  assert.equal(plan([r("A", {}), r("B", {})]).confirmed, false);
  assert.equal(plan([r("A", {})]).pending, false);
  assert.equal(plan([r("A", {})]).pad, "M");
});

test("fitWidth: content width, text columns capped, unmeasured falls back to the default", async () => {
  const { fitWidth, MIXED_COLS } = await import("../src/columns.js");
  const col = (id) => MIXED_COLS.find((c) => c.id === id);
  assert.equal(fitWidth(95.2, col("total"), 13), 96);            // numbers: exactly what they need
  assert.equal(fitWidth(5000, col("total"), 13), 1200);          // only the global ceiling
  assert.equal(fitWidth(900, col("system"), 13), 22 * 13);       // long text stops at its cap
  assert.equal(fitWidth(150, col("system"), 13), 150);
  assert.equal(fitWidth(0, col("station"), 13), 18 * 13);        // could not measure
  assert.equal(fitWidth(10, col("pad"), 13), 30);                // never vanishes
});

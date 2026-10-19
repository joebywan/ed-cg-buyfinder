import test from "node:test";
import assert from "node:assert/strict";
import { copySummary } from "../src/summary.js";

const now = new Date("2026-10-19T12:00:00Z");
const line = (station, o = {}) => ({ station, system: "Eravate", ls: 1240, ly: 14.2, updated: "2026-10-17",
  parts: [{ commodity: "Gold", tonnes: 600 }], cr_per_min: 41234, ...o });
const base = { dest: "Jameson Memorial", hold: 790, now };

test("header, then one line per station in the order given", () => {
  const out = copySummary({ ...base, lines: [
    line("Ackerman Market", { parts: [{ commodity: "Gold", tonnes: 600 }, { commodity: "Silver", tonnes: 190 }] }),
    line("Hahn Gateway", { system: "LHS 3447", ls: 380, ly: 22.8, parts: [{ commodity: "Gold", tonnes: 790 }], cr_per_min: 38900 })] });
  assert.equal(out, [
    "cgbuy · Jameson Memorial · 790t hold · data 2d old",
    "Ackerman Market (1,240 ls) · Eravate (14.2 ly) · Gold 600t + Silver 190t · 41.2k cr/min",
    "Hahn Gateway (380 ls) · LHS 3447 (22.8 ly) · Gold 790t · 38.9k cr/min"].join("\n"));
});

test("a single station", () => {
  assert.equal(copySummary({ ...base, lines: [line("Solo")] }).split("\n").length, 2);
});

test("ALL SOURCES rows of one station merge: commodities joined, best cr/min, oldest age", () => {
  const out = copySummary({ ...base, lines: [
    line("Ackerman Market", { cr_per_min: 30000 }),
    line("Hahn Gateway", { system: "LHS 3447" }),
    line("Ackerman Market", { parts: [{ commodity: "Silver", tonnes: 190 }], cr_per_min: 35000, updated: "2026-10-12" })] });
  assert.equal(out.split("\n").length, 3);
  assert.match(out, /^cgbuy .* data 7d old\nAckerman Market \(1,240 ls\) · Eravate \(14.2 ly\) · Gold 600t \+ Silver 190t · 35.0k cr\/min\nHahn/);
});

test("fresh data reads <1d", () => {
  assert.match(copySummary({ ...base, lines: [line("X", { updated: "2026-10-19" })] }), /data <1d old/);
});

test("a million cr/min or more reads in M", () => {
  assert.match(copySummary({ ...base, lines: [line("X", { cr_per_min: 3516100 })] }), /3\.52M cr\/min$/);
});

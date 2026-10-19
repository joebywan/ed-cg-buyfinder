import test from "node:test";
import assert from "node:assert/strict";
import { record, drain, drainText, KEEP } from "../src/trend.js";

const H = 3600e3, T = Date.parse("2026-10-01T00:00:00Z");
const row = (h, supply) => ({ system: "S", station: "T", commodity: "gold", supply, at: new Date(T + h * H).toISOString() });
const key = "S\0T\0gold";

test("the same market time is one reading, however often it is fetched", () => {
  let hist = record({}, [row(0, 500)], T);
  hist = record(hist, [row(0, 500), row(0, 500)], T);
  assert.equal(hist[key].length, 1);
});

test("keeps the newest readings, in time order", () => {
  let hist = {};
  for (let i = 9; i >= 0; i--) hist = record(hist, [row(i, 100 + i)], T + 10 * H);
  assert.equal(hist[key].length, KEEP);
  assert.equal(hist[key][0][0], T + 4 * H);
});

test("drops keys not read for two weeks; ignores rows without a timestamp", () => {
  const hist = record({}, [row(0, 5), { ...row(1, 5), at: "" }], T + 15 * 86400e3);
  assert.deepEqual(hist, {});
});

test("drain needs two readings and a fall", () => {
  assert.equal(drain([[T, 500]], T), null);
  assert.equal(drain([[T, 500], [T + H, 600]], T + H), null);
  assert.equal(drain([[T, 500], [T + H, 500]], T + H), null);
});

test("drain rate and projection", () => {
  const d = drain([[T, 1000], [T + 2 * H, 600]], T + 3 * H);   // 200 t/h, read 1 h ago
  assert.equal(d.rate, 200);
  assert.equal(d.left, 400);
  assert.equal(drainText(d), "fell from 1000 t to 600 t over 2.0 h; at that rate about 400 t left now");
  const gone = drain([[T, 1000], [T + 2 * H, 600]], T + 9 * H);
  assert.equal(gone.left, 0);
  assert.match(drainText(gone), /likely empty$/);
});

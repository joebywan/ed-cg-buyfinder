import test from "node:test";
import assert from "node:assert/strict";
import { widen, nextRange, stepsTo } from "../src/widen.js";
import { Watcher } from "../src/watch.js";

// A fake world: station i sits i-th along a line; `at` lists their distances.
const world = (at) => {
  const calls = [];
  const run = async (range) => { calls.push(range); return { rows: at.filter((d) => d <= range) }; };
  return { calls, run, count: (r) => r.rows.length, rows: (r) => r.rows.length };
};
const go = (w, o = {}) => {
  const said = [], steps = [];
  return widen({ user: 120, cap: 500, ...w, say: (t) => said.push(t), onStep: (e) => steps.push(e), ...o })
    .then((out) => ({ ...out, said, steps }));
};

test("ranges grow x1.5 in whole 10 ly, capped", () => {
  assert.deepEqual([120, 180, 270, 410].map((r) => nextRange(r, 500)), [180, 270, 410, 500]);
  assert.equal(stepsTo(120, 500), 4);
  assert.equal(nextRange(5, 500), 15);
});

test("120 -> 180 -> 270 stops at 5 stations, saying each step", async () => {
  const w = world([50, 100, 150, 170, 200, 260, 400]);
  const o = await go(w);
  assert.deepEqual(w.calls, [120, 180, 270]);
  assert.deepEqual(o.said, [
    "120 ly found 2 stations - not enough for a top 5, widening to 180 ly…",
    "180 ly found 4 stations - not enough for a top 5, widening to 270 ly…",
  ]);
  assert.equal(o.note, "Widened to 270 ly to find 5 stations (your radius: 120 ly)");
  assert.deepEqual(o.steps.map((s) => s.range), [180, 270, 270]);
});

test("enough at the user's radius: no widening, no note", async () => {
  const w = world([1, 2, 3, 4, 5]);
  const o = await go(w);
  assert.deepEqual([w.calls, o.said, o.note], [[120], [], ""]);
});

test("cap respected, and the reason given", async () => {
  const w = world([10, 200, 300]);
  const o = await go(w);
  assert.deepEqual(w.calls, [120, 180, 270, 410, 500]);
  assert.equal(o.note, "Widening stopped: reached the 500 ly limit - only 3 stations exist within it");
});

test("no progress twice in a row stops early", async () => {
  const w = world([10, 20, 30]);
  const o = await go(w);
  assert.deepEqual(w.calls, [120, 180, 270]);
  assert.equal(o.note, "Widening stopped: 270 ly added nothing new - only 3 stations found");
});

test("continuing from a shown result (filter change) starts at the next step", async () => {
  const w = world([50, 100, 150, 170, 200]);
  const o = await go(w, { range: 120, n: 2, baseRows: 2 });
  assert.deepEqual(w.calls, [180, 270]);
  assert.match(o.said[0], /^120 ly found 2 stations/);
  assert.equal(o.res.rows.length, 5);
});

test("the user's radius is an input, never changed", async () => {
  const p = { range: 120 };
  await go(world([1]), { user: p.range });
  assert.equal(p.range, 120);
});

test("widening that adds farther stations below the copied target raises no alert", () => {
  const plan = (n, cr) => ({ station: n, system: `${n}s`, cr_per_min: cr, tonnes: 100, updated: "2026-10-01", src: "A", mix: [] });
  const w = new Watcher({ shown: 40 });
  const before = [plan("A", 90), plan("B", 80), plan("C", 70)];
  w.begin(before, {});
  w.setTarget(before[1], before);
  const after = [...before, plan("D", 40), plan("E", 30)];
  assert.equal(w.check(after, {}), null);
});

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

// Ardent probes see `a`; the full source (Spansh) sees `s`, a superset.
const two = (a, s) => {
  const calls = [], probed = [], shown = [];
  const mk = (at, log) => async (range) => { log.push(range); return { rows: at.filter((d) => d <= range) }; };
  return { calls, probed, shown, probe: mk(a, probed), run: mk(s, calls), count: (r) => r.rows.length,
           rows: (r) => r.rows.length, onProbe: (r, range) => shown.push(range) };
};

test("probes use only Ardent, show each step, then ONE full run at the final radius", async () => {
  const w = two([50, 100, 150, 170, 200], [50, 90, 100, 150, 170, 200, 250]);
  const o = await go(w, { label: "Spansh" });
  assert.deepEqual(w.probed, [120, 180, 270]);
  assert.deepEqual(w.shown, [120, 180, 270]);
  assert.deepEqual(w.calls, [270]);
  assert.deepEqual(o.said, [
    "120 ly found 2 stations - not enough for a top 5, widening to 180 ly…",
    "180 ly found 4 stations - not enough for a top 5, widening to 270 ly…",
    "270 ly picked from Ardent's quick count - searching Spansh at 270 ly…",
  ]);
  assert.equal(o.note, "Widened to 270 ly to find 5 stations (your radius: 120 ly) (radius picked from Ardent's quick count)");
  assert.ok(o.steps.some((s) => s.final));
});

test("enough at the user's radius: probe once, full once, no messages", async () => {
  const w = two([1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 6]);
  const o = await go(w);
  assert.deepEqual([w.probed, w.calls, o.said, o.note], [[120], [120], [], ""]);
});

test("full source still short of 5: ONE more widening step, with its message", async () => {
  const w = two([50, 100, 150, 170, 200], [50, 100, 150, 170, 200, 300]);
  w.run = async (r) => { w.calls.push(r); return { rows: [50, 100, 150, 170, 200].filter((d) => d <= r).slice(0, r < 300 ? 4 : 5) }; };
  const o = await go(w);
  assert.deepEqual(w.probed, [120, 180, 270]);
  assert.deepEqual(w.calls, [270, 410]);
  assert.match(o.said.at(-1), /^270 ly found 4 stations - not enough for a top 5, widening to 410 ly…$/);
  assert.equal(o.n, 5);
});

test("continuing from a shown result probes with Ardent from the next step", async () => {
  const w = two([50, 100, 150, 170, 200], [50, 100, 150, 170, 200]);
  const o = await go(w, { range: 120, n: 2, baseRows: 7 });
  assert.deepEqual(w.probed, [180, 270]);
  assert.deepEqual(w.calls, [270]);
  assert.equal(o.res.rows.length, 5);
});

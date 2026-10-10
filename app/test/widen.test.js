import test from "node:test";
import assert from "node:assert/strict";
import { widen, nextRange, stepsTo } from "../src/widen.js";
import { buildMixed, viewRows } from "../src/model.js";
import { Watcher } from "../src/watch.js";
import { EdsmGate } from "../src/edsm.js";
import { buildRows as spansh } from "../src/spansh.js";
import { searchSources } from "../src/merge.js";

// -- the loop, over a fake world: station i sits at distance at[i] --------------

const world = (at) => {
  const calls = [];
  const run = async (range, prev) => { calls.push([prev, range]); return { rows: at.filter((d) => d <= range) }; };
  return { calls, run, count: (r) => r.rows.length, rows: (r) => r.rows.length };
};
const go = (w, o = {}) => {
  const said = [], shown = [];
  return widen({ user: 120, cap: 500, ...w, say: (t) => said.push(t), onResult: (r, range) => shown.push([range, r.rows.length]), ...o })
    .then((out) => ({ ...out, said, shown }));
};

test("ranges grow x1.5 in whole 10 ly, capped", () => {
  assert.deepEqual([120, 180, 270, 410].map((r) => nextRange(r, 500)), [180, 270, 410, 500]);
  assert.equal(nextRange(5, 500), 15);
  assert.equal(stepsTo(120, 500), 5);
});

test("120 -> 180 -> 270 stops at 5 stations; each step is announced and shown", async () => {
  const w = world([50, 100, 150, 170, 200, 300, 400]);
  const o = await go(w, { label: "Ardent + Spansh" });
  assert.deepEqual(w.calls, [[0, 120], [120, 180], [180, 270]]);
  assert.deepEqual(o.said, [
    "120 ly: 2 stations from Ardent + Spansh - not enough for a top 5, widening to 180 ly…",
    "180 ly: 4 stations from Ardent + Spansh - not enough for a top 5, widening to 270 ly…",
  ]);
  assert.equal(o.note, "270 ly: 5 stations - done (your radius: 120 ly)");
  assert.deepEqual(o.shown, [[120, 2], [180, 4], [270, 5]]);
});

test("enough at the user's radius: one step, no note", async () => {
  const w = world([1, 2, 3, 4, 5]);
  const o = await go(w);
  assert.deepEqual([w.calls, o.said, o.note], [[[0, 120]], [], ""]);
});

test("cap respected, and the reason given", async () => {
  const o = await go(world([10, 200, 300]));
  assert.equal(o.note, "Reached the 500 ly limit - only 3 stations within it");
});

test("no progress twice in a row stops early", async () => {
  const w = world([10, 20, 30]);
  const o = await go(w);
  assert.deepEqual(w.calls, [[0, 120], [120, 180], [180, 270]]);
  assert.equal(o.note, "270 ly added nothing new - stopping");
});

test("filter change: continues from the shown radius with the next ring", async () => {
  const w = world([50, 100, 150, 170, 200]);
  const o = await go(w, { range: 120, n: 2, baseRows: 2 });
  assert.deepEqual(w.calls, [[120, 180], [180, 270]]);
  assert.equal(o.res.rows.length, 5);
});

test("a failing later step keeps what was found", async () => {
  const w = world([50]);
  const run = async (r, prev) => { if (prev) throw new Error("boom"); return w.run(r, prev); };
  const o = await go({ ...w, run });
  assert.equal(o.res.rows.length, 1);
  assert.match(o.note, /Widening stopped: 180 ly failed \(boom\)/);
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
  assert.equal(w.check([...before, plan("D", 40), plan("E", 30)], {}), null);
});

// -- with the real Spansh builder: the requests are disjoint rings --------------

const mk = (name, distance) => ({ name, system_name: `${name}-sys`, distance, distance_to_arrival: 100, type: "Coriolis Starport",
  large_pads: 1, market_updated_at: "2026-09-14T01:00:00Z", body_name: "",
  market: [{ commodity: "Palladium", supply: 1000, buy_price: 1000 }] });
const NOW = new Date("2026-09-15T10:00:00Z");
const P = (o = {}) => ({ dest: { system: "Ega", station: "Metz Enterprise", commodities: ["Palladium"] },
  range: 120, min_supply: 200, hold: 720, pad: "L", carriers: false, jump_empty: 25, jump_laden: 18,
  max_age_days: 7, verify_edsm: false, ...o });

function pair(at, { pageSize = 500 } = {}) {
  const requests = [], ardent = [], order = [];
  const fetchJson = async (url, init) => {
    if (url.startsWith("https://spansh")) {
      const b = JSON.parse(init.body);
      const [min, max] = b.filters.distance.value;
      requests.push([min, max, b.page]);
      const hit = at.filter(([, d]) => d >= min && d <= max).sort((a, b) => a[1] - b[1]);
      order.push("spansh");
      return { results: hit.slice(b.page * b.size, (b.page + 1) * b.size).map(([n, d]) => mk(n, d)) };
    }
    return { commodities: [{ name: "Palladium", sellPrice: 150000, demand: 99 }], stations: [{ name: "Metz Enterprise", distanceToArrival: 5000 }] };
  };
  fetchJson.pageSize = pageSize;
  const gate = new EdsmGate({ now: () => 1e6, sleep: async () => {} });
  const builders = {
    spansh: (p, o) => spansh(p, { ...o, fetchJson, now: NOW, gate, sleep: async () => {} }),
    // Ardent is slower than Spansh: a decision made before it answers would be visible.
    ardent: async (p) => { ardent.push(p.range); await new Promise((r) => setTimeout(r, 5)); order.push("ardent");
      return { rows: [], cg: {}, cgLs: 0, hiddenStale: 0, allStale: false, errors: [] }; },
  };
  return { requests, ardent, order, builders };
}

test("Both: every step waits for both sources; Spansh asks disjoint rings, Ardent once per step", async () => {
  const w = pair([["a", 50], ["b", 100], ["c", 150], ["d", 170], ["e", 200], ["f", 400]]);
  let held, calls = 0;
  const o = await widen({
    user: 120, cap: 500,
    run: async (range, prev) => {
      calls++;
      const r = await searchSources("both", { ...P(), range, minLy: prev, held: prev ? held : undefined, defer_verify: true }, w.builders, {});
      held = r.held;
      return r;
    },
    count: (r) => buildMixed(viewRows(r.rows), 720).length,
    rows: (r) => r.rows.length,
  });
  assert.deepEqual(w.requests, [[0, 120, 0], [120, 180, 0], [180, 270, 0]]);
  assert.deepEqual(w.ardent, [120, 180, 270]);
  assert.equal(calls, 3);
  assert.deepEqual(w.order.filter((_, i) => i % 2 === 1), ["ardent", "ardent", "ardent"]);   // Ardent always finished before the next step
  assert.equal(o.res.rows.length, 5);
  assert.equal(o.res.rows.every((r, i, a) => a.findIndex((x) => x.station === r.station) === i), true);
});

test("a ring's paging stays inside the ring, and an edge station is not counted twice", async () => {
  const w = pair([["a", 100], ["b", 120], ["c", 120], ["d", 130], ["e", 140], ["f", 150]]);
  let held;
  const steps = [[120, 0], [180, 120]];
  for (const [range, prev] of steps) {
    const r = await searchSources("spansh", { ...P(), range, minLy: prev, held: prev ? held : undefined, defer_verify: true }, w.builders, {});
    held = r.held;
  }
  assert.deepEqual(w.requests, [[0, 120, 0], [120, 180, 0]]);
  assert.deepEqual(held.rows.map((r) => r.station).sort(), ["a", "b", "c", "d", "e", "f"]);
});

test("the last step starts EDSM verification, earlier ones do not", async () => {
  const w = pair([["a", 50]]);
  const r = await searchSources("spansh", { ...P({ verify_edsm: true }), defer_verify: true }, w.builders, {});
  assert.equal(r.verifying, undefined);
  assert.equal(typeof r.startVerify, "function");
});

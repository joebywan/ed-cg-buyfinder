import test from "node:test";
import assert from "node:assert/strict";
import { mergeResults, searchSources } from "../src/merge.js";
import { buildMixed } from "../src/model.js";
import { Watcher } from "../src/watch.js";

const row = (o) => ({ commodity: "Gold", station: "X", system: "Y", cr_per_min: 10, updated: "2026-10-01", ...o });
const res = (rows, o = {}) => ({ rows, cg: {}, cgLs: 0, hiddenStale: 0, allStale: false, errors: [], ...o });
const now = new Date("2026-10-02");

test("fresher reading wins, tie goes to Ardent, loser age recorded", () => {
  const a = res([row({ updated: "2026-09-30", buy: 1 }), row({ station: "T", updated: "2026-10-01", buy: 1 }), row({ station: "A", buy: 1 })]);
  const s = res([row({ updated: "2026-10-01", buy: 2 }), row({ station: "T", updated: "2026-10-01", buy: 2 }), row({ station: "S", buy: 2 })]);
  const m = mergeResults(a, s, { max_age_days: 7 }, now);
  const by = Object.fromEntries(m.rows.map((r) => [r.station, r]));
  assert.deepEqual([by.X.src, by.X.buy, by.X.other], ["AS", 2, { src: "A", updated: "2026-09-30" }]);
  assert.deepEqual([by.T.src, by.T.buy, by.T.other.src], ["AS", 1, "S"]);
  assert.deepEqual([by.A.src, by.S.src, by.A.other], ["A", "S", undefined]);
});

test("one source failing keeps the other and reports why", async () => {
  const builders = {
    ardent: async () => { throw new Error("down"); },
    spansh: async () => res([row()], { errors: ["bad page"] }),
  };
  const r = await searchSources("both", { max_age_days: 7 }, builders, {});
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.errors, ["Spansh: bad page", "Ardent: down"]);
  await assert.rejects(searchSources("both", {}, { ...builders, spansh: builders.ardent }, {}), /Ardent: down; Spansh: down/);
});

test("the first source to land is shown on its own while the other is out", async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const partials = [];
  const run = searchSources("both", { max_age_days: 7 }, {
    ardent: async () => res([row({ station: "A" })]),
    spansh: () => slow,
  }, { onPartial: (r, waiting) => partials.push([r.rows.map((x) => x.src), r.sources, waiting]) });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(partials, [[["A"], ["ardent"], "Spansh"]]);
  release(res([row({ station: "A" })]));
  assert.equal((await run).rows[0].src, "AS");
  assert.equal(partials.length, 1);
});

test("an EDSM drop survives Both mode: reason in the alert, no resurrection from older Ardent", async () => {
  const mk = (n, o = {}) => ({ commodity: "Gold", station: n, system: `${n}-sys`, carrier: false, planetary: false, pad: "L",
    supply: 1000, buy: 1000, sell: 5000, profit_per_t: 4000, load: 100, trip_minutes: 20, t_per_min: 5,
    cr_per_min: 60000 - 1000 * "ABCDEFG".indexOf(n), updated: "2026-10-01", ...o });
  const names = [..."ABCDEFG"];
  const spanshAll = names.map((n) => mk(n));
  const ardent = res(names.map((n) => mk(n, { updated: "2026-09-25" })));
  const after = res(spanshAll.filter((r) => r.station !== "B"), {
    dropped: { "B\0B-sys": "sold out" }, gone: ["B-sys\0B\0Gold"] });
  let update;
  const first = await searchSources("both", { max_age_days: 30, hold: 100 }, {
    ardent: async () => ardent,
    spansh: async (p, o) => { update = () => o.onUpdate(after); return res(spanshAll, { dropped: {} }); },
  }, { onUpdate: (r) => { got = r; } });
  let got;
  const w = new Watcher();
  const plans = buildMixed(first.rows, 100);
  w.begin(plans, first.dropped);
  w.setTarget(plans.find((p) => p.station === "B"), plans);
  update();
  assert.equal(got.rows.some((r) => r.station === "B"), false);       // Ardent's older B stays dropped
  assert.deepEqual(got.dropped, { "B\0B-sys": "sold out" });
  const a = w.check(buildMixed(got.rows, 100), got.dropped);
  assert.match(a.text, /Your target B is gone from the results \(EDSM: sold out\)/);
});

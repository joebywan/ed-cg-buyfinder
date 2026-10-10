import test from "node:test";
import assert from "node:assert/strict";
import { mergeResults, searchSources } from "../src/merge.js";

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

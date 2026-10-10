import test from "node:test";
import assert from "node:assert/strict";
import { EdsmGate } from "../src/edsm.js";
import { STALL_MS, Watcher, stallAlert } from "../src/watch.js";

const plan = (station, system = `${station}-sys`) => ({ station, system });
const list = (...names) => names.map((n) => plan(n));
const rig = () => { let t = 0; const w = new Watcher({ now: () => t }); return { w, tick: (ms) => { t += ms; } }; };

test("without a copied target nothing is ever raised, however the ranking shuffles", () => {
  const { w } = rig();
  assert.equal(w.begin(list("A", "B", "C", "D", "E", "F")), null);
  assert.equal(w.check(list("B", "C", "D", "A", "E", "F")), null);
  assert.equal(w.check(list("F", "E", "D", "C", "B", "A")), null);
});

test("a copied target that moves raises the priority alert, even outside the top 5", () => {
  const { w } = rig();
  const before = list("A", "B", "C", "D", "E", "F", "G");
  w.begin(before);
  w.setTarget(plan("G"), before);
  const a = w.check(list("A", "B", "C", "D", "E", "G", "F"));
  assert.equal(a.kind, "target");
  assert.match(a.text, /Your target G moved #7 -> #6 - A \(A-sys\) is now #1\. New destination\?/);
  assert.equal(a.ok, "KEEP");
  w.acknowledge(list("A", "B", "C", "D", "E", "G", "F"));
  assert.equal(w.check(list("A", "B", "C", "D", "E", "G", "F")), null);
});

test("a dropped target says so; a new search compares it too; clearing silences it", () => {
  const { w } = rig();
  const before = list("A", "B", "C");
  w.begin(before);
  w.setTarget(plan("B"), before);
  assert.match(w.check(list("A", "C")).text, /Your target B is gone/);
  const again = w.begin(list("C", "A", "B"));        // new search of the same destination
  assert.match(again.text, /B moved #2 -> #3/);
  w.clearTarget();
  assert.equal(w.begin(list("C", "A", "B")), null);
});

test("EDSM drop reasons reach the alert text", () => {
  const { w } = rig();
  const before = list("A", "B", "C");
  w.begin(before);
  const key = (n) => `${n}\0${n}-sys`;
  w.setTarget(plan("B"), before);
  assert.match(w.check(list("A", "C"), { [key("B")]: "sold out" }).text, /gone from the results \(EDSM: sold out\)/);
  w.setTarget(plan("A"), before);
  assert.match(w.check(list("C", "B"), { [key("A")]: "no longer profitable" }).text, /gone from the results \(EDSM: no longer profitable\)/);
});

test("a target pushed past the rows on screen reads as gone from the results", () => {
  const w = new Watcher({ now: () => 0, shown: 6 });
  const before = list("A", "B", "C", "D", "E", "F", "G");
  w.begin(before);
  w.setTarget(plan("C"), before);
  assert.match(w.check(list("A", "B", "G", "D", "E", "F", "C")).text, /Your target C is gone from the results/);
});

const rich = (station, cr, supply, buy, extra = {}) => ({ station, system: `${station}-sys`, cr_per_min: cr, tonnes: 100, updated: "2026-10-01",
  mix: [{ commodity: "Gold", supply, buy }], ...extra });

test("the target alert says why it moved: supply, price, EDSM, fresher reading; only the target is highlighted", () => {
  const { w } = rig();
  const before = [rich("A", 5e6, 64317, 5808), rich("B", 4e6, 9000, 5000), rich("C", 3e6, 9000, 5000)];
  w.begin(before);
  w.setTarget(before[0], before);
  const a = w.check([rich("B", 4e6, 9000, 5000), rich("A", 3.5e6, 2188, 5808, { edsm: true }), rich("C", 3e6, 9000, 5000)]);
  assert.match(a.text, /A moved #1 -> #2 \(EDSM: supply 64,317 -> 2,188\)/);
  assert.deepEqual([...a.keys], ["A\0A-sys"]);
  w.acknowledge(before);
  const p = w.check([rich("B", 4e6, 9000, 6240), rich("C", 3.5e6, 9000, 5000), rich("A", 1e6, 64317, 5808)]);
  assert.match(p.text, /A moved #1 -> #3 \(cr\/min 5\.00M -> 1\.00M\)|A moved #1 -> #3/);
  w.setTarget(rich("C", 3e6, 9000, 5000), before);
  const n = w.check([rich("A", 5e6, 64317, 5808), rich("B", 4e6, 9000, 5000), rich("C", 3e6, 9000, 5000, { updated: "2026-10-05", src: "S" })]);
  assert.equal(n, null);                                  // same rank: quiet
});

test("EDSM stalled: the gate counts unbroken 429s from the first, and a good reply ends it", async () => {
  let t = 1e6;
  const gate = new EdsmGate({ now: () => t, sleep: async (ms) => { t += ms; } });
  assert.equal(gate.stalledMs(), 0);
  let n = 0;
  const seen = [];
  const fetchJson = async () => {
    seen.push(gate.stalledMs());
    if (++n <= 8) throw Object.assign(new Error("429"), { status: 429, retryAfter: "100" });   // 100 s apart
    return {};
  };
  await gate.request(fetchJson, "a");
  assert.ok(seen[7] >= STALL_MS, `after 7 refusals ~700 s in, got ${seen[7]}`);
  assert.ok(seen[2] < STALL_MS);
  assert.equal(gate.stalledMs(), 0);
});

test("stallAlert: silent under 5 min or with nothing pending, else the one-line text", () => {
  assert.equal(stallAlert(STALL_MS - 1, 4), null);
  assert.equal(stallAlert(STALL_MS, 0), null);
  const a = stallAlert(STALL_MS, 4);
  assert.equal(a.kind, "edsm");
  assert.match(a.text, /^EDSM has been rate-limiting for 5\+ min - 4 stations still unconfirmed \(shown with \?\)\. Results are Spansh\/Ardent data until it recovers\.$/);
  assert.equal(a.ok, "GOT IT");
});

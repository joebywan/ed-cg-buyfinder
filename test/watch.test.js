import test from "node:test";
import assert from "node:assert/strict";
import { Watcher } from "../src/watch.js";

const plan = (station, system = `${station}-sys`) => ({ station, system });
const list = (...names) => names.map((n) => plan(n));
const rig = () => { let t = 0; const w = new Watcher({ now: () => t }); return { w, tick: (ms) => { t += ms; } }; };

test("the first render is the baseline; an unchanged top 5 stays quiet", () => {
  const { w } = rig();
  assert.equal(w.begin(list("A", "B", "C", "D", "E", "F")), null);
  assert.equal(w.check(list("A", "B", "C", "D", "E", "G")), null);   // only #6 moved
});

test("a changed top 5 says what moved and who leads", () => {
  const { w } = rig();
  w.begin(list("A", "B", "C", "D", "E", "F"));
  const a = w.check(list("B", "C", "D", "A", "E", "F"));
  assert.equal(a.kind, "top5");
  assert.match(a.text, /A #1 -> #4/);
  assert.match(a.text, /B is now #1/);
  assert.equal(a.copy.plan.station, "B");
  const d = w.check(list("B", "C", "D", "E", "F", "A"));
  assert.match(d.text, /A #1 dropped off the list|A #1 -> #6/);
});

test("bursts coalesce: one alert, one sound per 10s, cleared when the ranking returns", () => {
  const { w, tick } = rig();
  w.begin(list("A", "B", "C", "D", "E"));
  assert.equal(w.check(list("B", "A", "C", "D", "E")).beep, true);
  tick(800);
  assert.equal(w.check(list("B", "A", "C", "D", "E")).beep, false);      // same alert
  tick(800);
  assert.equal(w.check(list("B", "C", "A", "D", "E")).beep, false);      // new text, inside 10s
  tick(11_000);
  assert.equal(w.check(list("C", "B", "A", "D", "E")).beep, true);
  assert.equal(w.check(list("A", "B", "C", "D", "E")), null);
});

test("acknowledging makes the current ranking the baseline", () => {
  const { w } = rig();
  w.begin(list("A", "B", "C", "D", "E"));
  const now = list("B", "A", "C", "D", "E");
  assert.ok(w.check(now));
  w.acknowledge(now);
  assert.equal(w.check(now), null);
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

test("a station pushed past the rows on screen reads as off the list, and newcomers are named", () => {
  const w = new Watcher({ now: () => 0, shown: 6 });
  w.begin(list("A", "B", "C", "D", "E", "F", "G"));
  const a = w.check(list("A", "B", "G", "D", "E", "F", "C"));
  assert.match(a.text, /C #3 dropped off the list/);
  assert.match(a.text, /G up to #3/);
});

const rich = (station, cr, supply, buy, extra = {}) => ({ station, system: `${station}-sys`, cr_per_min: cr, tonnes: 100, updated: "2026-10-01",
  mix: [{ commodity: "Gold", supply, buy }], ...extra });

test("alerts say why a station moved: supply, price, EDSM, fresher reading", () => {
  const { w } = rig();
  const before = [rich("A", 5e6, 64317, 5808), rich("B", 4e6, 9000, 5000), rich("C", 3e6, 9000, 5000),
                  rich("D", 2e6, 9000, 5000), rich("E", 1e6, 9000, 5000), rich("F", 9e5, 9000, 5000)];
  w.begin(before);
  const a = w.check([rich("B", 4e6, 9000, 5000), rich("C", 3e6, 9000, 5000), rich("D", 2e6, 9000, 5000),
    rich("A", 1.5e6, 2188, 5808, { edsm: true }), rich("E", 1e6, 9000, 5000), rich("F", 9e5, 9000, 5000)]);
  assert.match(a.text, /A #1 -> #4 \(EDSM: supply 64,317 -> 2,188\)/);
  const p = w.check([rich("B", 4e6, 9000, 6240), rich("C", 3e6, 9000, 5000), rich("D", 2e6, 9000, 5000),
    rich("A", 1.5e6, 64317, 5808), rich("E", 1e6, 9000, 5000), rich("F", 9e5, 9000, 5000)]);
  assert.match(p.text, /B #2 -> #1 \(buy price 5,000 -> 6,240\)/);
  const n = w.check([rich("A", 5e6, 64317, 5808), rich("B", 4e6, 9000, 5000), rich("C", 3e6, 9000, 5000),
    rich("D", 2e6, 9000, 5000), rich("F", 9e5, 9000, 5000, { updated: "2026-10-05", src: "S" })]);
  assert.match(n.text, /F up to #5 \(fresher Spansh reading\)/);
});

test("a long alert is cut for the banner but kept whole in detail", () => {
  const { w } = rig();
  const names = "ABCDEFGH".split("").map((c) => `Station ${c} with a long name`);
  w.begin(list(...names));
  const a = w.check(list(...[...names].reverse()));
  assert.ok(a.text.length <= 170);
  assert.ok(a.detail.length > a.text.length);
});

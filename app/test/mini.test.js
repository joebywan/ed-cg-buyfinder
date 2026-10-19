import test from "node:test";
import assert from "node:assert/strict";
import { miniCard, miniStanding, miniTarget } from "../src/mini.js";
import { keyOf } from "../src/watch.js";

const plan = (station, cr) => ({ station, system: `${station}-sys`, ly: 12.5, ls: 1234, cr_per_min: cr, updated: "2000-01-01",
  confirmed: false, pending: true, mix: [{ commodity: "Gold", tonnes: 600 }, { commodity: "Silver", tonnes: 190 }] });
const plans = [plan("A", 5000), plan("B", 4000)];

test("target is the copied station while it is listed, else the best", () => {
  assert.equal(miniTarget(plans, { key: keyOf(plans[1]) }).station, "B");
  assert.equal(miniTarget(plans, { key: "gone\0x" }).station, "A");
  assert.equal(miniTarget([], null), null);
});

test("card fields", () => {
  const { plan: p, alert } = miniCard({ plans, target: { key: keyOf(plans[1]) } });
  assert.equal(alert, null);
  assert.deepEqual([p.station, p.ls, p.ly, p.load, p.crpm, p.ageClass, p.mark, p.copied],
    ["B", "1,234 ls", "12.5 ly", "Gold 600t + Silver 190t", "4,000 cr/min", "age-old", "?", true]);
});

test("a target alert shows its text and the new best station", () => {
  const c = miniCard({ plans, target: { key: keyOf(plans[1]) }, alert: { kind: "target", text: "moved", copy: { plan: plans[0] } } });
  assert.equal(c.alert, "moved");
  assert.equal(c.plan.station, "A");
  assert.equal(miniCard({ plans, target: null, alert: { kind: "edsm", text: "x" } }).alert, null);
});

test("short standing keeps tier, progress and runs", () => {
  const s = miniStanding("Your contribution 5 t · 2d left · top 25% band · tier 3/5 globally · 100 t to top 10% (40% of the way, 2 runs) · 300 t clear (2 runs)");
  assert.equal(s, "tier 3/5 globally · 100 t to top 10% (40% of the way, 2 runs) · 300 t clear (2 runs)");
  assert.equal(miniCard({ plans: [], target: null }).plan, null);
});

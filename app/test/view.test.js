import test from "node:test";
import assert from "node:assert/strict";
import { buildMixed, hiddenBy, viewRows } from "../src/model.js";
import { Watcher } from "../src/watch.js";
import { loadPrefs } from "../src/prefs.js";

const row = (station, o = {}) => ({ commodity: "Gold", station, system: `${station}-sys`, carrier: false, planetary: false,
  stype: "Coriolis", body: "", pad: "L", ly: 10, ls: 100, supply: 1000, buy: 1000, sell: 5000, profit_per_t: 4000,
  load: 100, trip_minutes: 20, cr_per_min: 20000, t_per_min: 5, updated: "2026-09-15", src: "A", ...o });
const rows = [row("Orbit"), row("Surf", { planetary: true, body: "Hub 3", trip_minutes: 10, cr_per_min: 40000 }),
  row("FC", { carrier: true, cr_per_min: 10000 }), row("Small", { pad: "S", cr_per_min: 5000 }), row("NoPad", { pad: "", cr_per_min: 1 })];
const names = (v) => v.map((r) => r.station);

test("ODYSSEY, CARRIERS and PAD hide rows without touching the cache", () => {
  assert.deepEqual(names(viewRows(rows, {})), ["Orbit"]);
  assert.deepEqual(names(viewRows(rows, { odyssey: true })), ["Surf", "Orbit"]);
  assert.deepEqual(names(viewRows(rows, { carriers: true })), ["Orbit", "FC"]);
  assert.deepEqual(names(viewRows(rows, { pad: "S", odyssey: true, carriers: true })), ["Surf", "Orbit", "FC", "Small"]);
  assert.equal(rows.length, 5);
  assert.equal(hiddenBy(rows[1], {}), "odyssey");
});

test("surface penalty re-scores planetary rows only, from the stored trip, and can reorder", () => {
  const v = viewRows(rows, { odyssey: true, penalty: 5 });
  assert.deepEqual(names(v), ["Surf", "Orbit"]);
  const s = v.find((r) => r.station === "Surf");
  assert.deepEqual([s.trip_minutes, s.cr_per_min, s.penalty], [15, 26667, 5]);
  assert.equal(rows[1].trip_minutes, 10);                              // cache untouched
  const big = viewRows(rows, { odyssey: true, penalty: 30 });
  assert.deepEqual(names(big), ["Orbit", "Surf"]);
  assert.equal(buildMixed(big, 100)[0].station, "Orbit");
  assert.equal(buildMixed(big, 100).find((p) => p.station === "Surf").penalty, 30);
  assert.equal(viewRows(rows, { odyssey: true, penalty: 0 })[0].penalty, undefined);
});

test("surface_penalty pref defaults to 0 and survives legacy / junk saves", () => {
  assert.equal(loadPrefs(null).surface_penalty, 0);
  assert.equal(loadPrefs({ font_size: 9 }).surface_penalty, 0);
  assert.equal(loadPrefs({ surface_penalty: "x" }).surface_penalty, 0);
  assert.equal(loadPrefs({ surface_penalty: 8 }).surface_penalty, 8);
});

const plans = (...n) => n.map((station) => ({ station, system: `${station}-sys` }));

test("a filter change rebases quietly: no top-5 alert", () => {
  const w = new Watcher();
  w.begin(plans("A", "B", "C", "D", "E", "F"));
  assert.equal(w.rebase(plans("B", "C", "D", "E", "F", "A")), null);
  assert.equal(w.check(plans("B", "C", "D", "E", "F", "A")), null);
});

test("a target hidden by a filter is reported by cause, until it shows again", () => {
  const w = new Watcher();
  w.begin(plans("A", "B", "Hub"));
  w.setTarget(plans("Hub")[0], plans("A", "B", "Hub"));
  const a = w.rebase(plans("A", "B"), "ODYSSEY filter (surface station)");
  assert.equal(a.kind, "target");
  assert.match(a.text, /Your target Hub is hidden by the ODYSSEY filter \(surface station\) - A \(A-sys\) is now #1\. New destination\?/);
  assert.equal(a.copy.label, "COPY NEW #1");
  assert.equal(a.beep, true);
  const again = w.check(plans("A", "B"));                // an EDSM update meanwhile: still said, no second chime
  assert.equal(again.text, a.text);
  assert.equal(again.beep, false);
  assert.equal(w.rebase(plans("A", "B", "Hub")), null);  // switched back on: alert clears
  assert.equal(w.check(plans("A", "B", "Hub")), null);
});

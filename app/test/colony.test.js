// Real lines from a commander's journal: dock at Bray Venture (a planetary construction
// depot), a run to Peralta Station for titanium, a delivery, and the depot's own event.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chooseAuto, depotDest, depotExtras, open, progressLine, remaining, takeLine } from "../src/colony.js";
import { dockedDestination } from "../src/destination.js";
import { buildMixed, capRows } from "../src/model.js";
import { JournalState } from "../src/journal.js";

const lines = readFileSync(new URL("./fixtures/colonisation.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);
const depotLines = lines.filter((l) => l.includes('"ColonisationConstructionDepot"'));
const sum = (d, k) => d.resources.reduce((n, r) => n + r[k], 0);
const MID = 4392609539;

test("a depot event alone is not enough: it has no name until the Docked before it", () => {
  const depots = {};
  assert.equal(takeLine(depots, depotLines[0]), false);
  assert.deepEqual(depots, {});
});

test("Docked names the depot, the event pairs by MarketID, repeats are ignored", () => {
  const depots = {};
  for (const l of lines.slice(0, 4)) takeLine(depots, l);
  const d = depots[MID];
  assert.equal(d.station, "Planetary Construction Site: Bray Venture");
  assert.equal(d.system, "Praea Euq PY-Y b1-0");
  assert.equal(takeLine(depots, depotLines[0]), false);          // the 15 s repeat
  assert.equal(Object.keys(depots).length, 1);                    // Peralta is not a depot
});

test("progress maths: 7445 of 36829 t, then +1088 titanium", () => {
  const depots = {};
  for (const l of lines) takeLine(depots, l);
  const d = depots[MID];
  const first = JSON.parse(depotLines[0]);
  assert.equal(first.ConstructionProgress, 0.20215);
  assert.equal(d.progress, 0.231692);
  assert.equal(sum(d, "required"), 36829);
  assert.ok(Math.abs(sum(d, "provided") / 36829 - 0.231692) < 1e-6);
  assert.ok(Math.abs(7445 / 36829 - 0.20215) < 1e-5);
});

test("remaining and destination: only what is still needed, at the depot's payment", () => {
  const depots = {};
  for (const l of lines) takeLine(depots, l);
  const d = depots[MID];
  const left = remaining(d);
  assert.ok(left.every((r) => r.left > 0));
  assert.equal(left.find((r) => r.name === "Aluminium").left, 7047);
  assert.equal(left.find((r) => r.name === "CMM Composite").left, 6776 - 1485);
  assert.ok(!left.some((r) => r.name === "Copper"));              // delivered in full
  const dest = depotDest(d);
  assert.equal(dest.prices.Aluminium, 3239);
  assert.equal(dest.needs.Aluminium, 7047);
  assert.equal(dest.source, "construction site");
  assert.equal(left.reduce((n, r) => n + r.left, 0), 36829 - sum(d, "provided"));
});

test("a finished or failed depot stops being a destination", () => {
  const depots = {};
  for (const l of lines) takeLine(depots, l);
  assert.ok(open(depots[MID]));
  assert.equal(chooseAuto(null, depots, 0).station, depots[MID].station);
  depots[MID].complete = true;
  assert.equal(chooseAuto(null, depots, 0), null);
  depots[MID].complete = false;
  depots[MID].failed = true;
  assert.equal(chooseAuto({ station: "CG" }, depots, 0).station, "CG");
});

test("the most recently docked goal wins between a CG and a depot", () => {
  const depots = {};
  for (const l of lines) takeLine(depots, l);
  const at = depots[MID].dockedAt;
  assert.equal(chooseAuto({ station: "CG" }, depots, at - 1).depot, true);
  assert.equal(chooseAuto({ station: "CG" }, depots, at + 1).station, "CG");
});

test("typed-in depot gets its prices and needs for the goods chosen", () => {
  const depots = {};
  for (const l of lines) takeLine(depots, l);
  const x = depotExtras(depots, { station: depots[MID].station, system: depots[MID].system, commodities: ["Aluminium", "Gold"] });
  assert.deepEqual(x, { prices: { Aluminium: 3239 }, needs: { Aluminium: 7047 }, depot: true });
  assert.deepEqual(depotExtras(depots, { station: "Elsewhere", system: "X", commodities: ["Aluminium"] }), {});
});

test("progress line", () => {
  const depots = {};
  for (const l of lines) takeLine(depots, l);
  const d = depots[MID];
  const left = 36829 - sum(d, "provided");
  const text = progressLine(d, 1088, 11.5);
  assert.ok(text.startsWith("Bray Venture: 23.2% built · "), text);
  assert.ok(text.includes(`${left.toLocaleString("en-US")} t to go`), text);
  assert.ok(text.includes(`~${Math.ceil(left / 1088)} loads of your hold`), text);
  assert.match(text, /h at your pace$/);
  assert.equal(progressLine(d), "Bray Venture: 23.2% built · " + `${left.toLocaleString("en-US")} t to go`);
});

test("USE WHERE I'M DOCKED at a depot fills the remaining resources", () => {
  const depots = {};
  const j = new JournalState();
  for (const l of lines) { j.handle(l); takeLine(depots, l); }
  assert.equal(j.station, "Planetary Construction Site: Bray Venture");
  const d = dockedDestination(j, null, depots);
  assert.ok(d.commodities.includes("Aluminium") && !d.commodities.includes("Copper"));
});

const row = (commodity, supply, profit_per_t, station = "Peralta Station") => ({
  commodity, supply, profit_per_t, buy: 1, station, system: "S", ly: 0, ls: 25, trip_minutes: 10,
  load: Math.min(supply, 100), carrier: false, planetary: true, stype: "", body: "", pad: "L", updated: "" });

test("caps hold a mixed load to what is still needed; no caps, no change", () => {
  const rows = [row("Titanium", 500, 2000), row("Steel", 500, 1000)];
  const [free] = buildMixed(rows, 100);
  assert.deepEqual(free.mix.map((m) => [m.commodity, m.tonnes]), [["Titanium", 100]]);
  const [capped] = buildMixed(rows, 100, { Titanium: 30 });
  assert.deepEqual(capped.mix.map((m) => [m.commodity, m.tonnes]), [["Titanium", 30], ["Steel", 70]]);
  assert.equal(capped.total, 30 * 2000 + 70 * 1000);
});

test("caps hold single rows' load and re-rate them", () => {
  const [a, b] = capRows([row("Titanium", 500, 2000), row("Steel", 500, 1000)], { Titanium: 30 });
  assert.equal(a.load, 30);
  assert.equal(a.cr_per_min, 6000);
  assert.equal(a.t_per_min, 3);
  assert.equal(b.load, 100);
  assert.equal(capRows([a], null)[0], a);
});

test("a localised client's depot names map back to the English commodity", () => {
  const depots = {};
  takeLine(depots, JSON.stringify({ timestamp: "2026-10-21T03:50:54Z", event: "Docked", StationType: "PlanetaryConstructionDepot",
    StationName: "Planetary Construction Site: X", StarSystem: "Y", MarketID: 1 }));
  takeLine(depots, JSON.stringify({ timestamp: "2026-10-21T03:50:56Z", event: "ColonisationConstructionDepot", MarketID: 1,
    ConstructionProgress: 0, ResourcesRequired: [{ Name: "$steel_name;", Name_Localised: "Stahl", RequiredAmount: 10, ProvidedAmount: 0, Payment: 5 }] }));
  assert.equal(depots[1].resources[0].name, "Steel");
});

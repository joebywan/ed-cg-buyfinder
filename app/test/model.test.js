// Ported from test_cgbuy.py: TestTripMinutes, TestBuildMixed,
// TestMixedSortValue, TestPadForShip, plus Ardent's single pad-size field.
import test from "node:test";
import assert from "node:assert/strict";
import * as m from "../src/model.js";
import { Calibration, estScMinutes } from "../src/journal.js";

const near = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

const trip = ({ dist = 60, srcLs = 1000, cgLs = 500, empty = 30, laden = 25,
                cal = null } = {}) =>
  m.tripMinutes(dist, srcLs, cgLs, empty, laden, cal);

test("uncalibrated trip uses the shipped estimates", () => {
  // 60 ly: 2 out, 3 back, and the first jump of each leg is already inside
  // departure - so 1 + 2 jump cycles.
  const expected = 3 * m.EST_JUMP_MIN
    + (estScMinutes(1000) + estScMinutes(500)) * m.EST_SC_SCALE
    + (m.EST_DOCK_MIN + m.EST_DEPART_MIN) * 2;
  near(trip(), expected);
});

test("calibrated jump time is used when supplied", () => {
  const cal = new Calibration({ jump_secs: [120, 120, 120] });
  near(cal.jumpMinutes, 2.0);
  near(trip({ cal }), 3 * 2.0 + estScMinutes(1000) + estScMinutes(500)
    + (m.EST_DOCK_MIN + m.EST_DEPART_MIN) * 2);
});

test("departure is counted twice and calibrated", () => {
  const cal = new Calibration({ depart_secs: [300, 300, 300] });
  near(trip({ cal }) - trip(), (5.0 - m.EST_DEPART_MIN) * 2);
});

test("station time is fixed and never calibrated", () => {
  const cal = new Calibration({ dock_secs: [3600, 3600, 3600] });
  near(cal.dockMinutes, 60);
  near(trip({ cal }), trip());
  assert.equal(m.EST_DOCK_MIN, 2.0);
});

test("calibrated sc scale is applied to both arrival legs", () => {
  const model = estScMinutes(1000) * 60;
  const cal = new Calibration({ approach_samples: Array(3).fill([1000, model * 2]) });
  near(trip({ cal }) - trip(), estScMinutes(1000) + estScMinutes(500));
});

test("a measured arrival leg beats the curve", () => {
  const cal = new Calibration({
    approach_samples: [...Array(3).fill([350, 208]), ...Array(3).fill([5000, 245])],
  });
  const legs = cal.arrivalMinutes(1000) + cal.arrivalMinutes(500);
  near(trip({ cal }) - legs, trip() - estScMinutes(1000) - estScMinutes(500));
});

test("empty calibration behaves like none", () => {
  near(trip({ cal: new Calibration() }), trip());
});

test("more distance, more Ls and a shorter laden range all cost time", () => {
  assert.ok(trip({ dist: 10 }) < trip({ dist: 200 }));
  assert.ok(trip({ srcLs: 100 }) < trip({ srcLs: 50000 }));
  assert.ok(trip({ cgLs: 100 }) < trip({ cgLs: 50000 }));
  assert.ok(trip({ laden: 30 }) < trip({ laden: 10 }));
});

test("the first jump of a leg is already paid for in departure", () => {
  near(trip({ dist: 0 }), trip({ dist: 1 }));
  assert.ok(trip({ dist: 1 }) < trip({ dist: 31 }));
});

test("trip is never below half a minute", () => {
  const cal = new Calibration({ jump_secs: [0, 0, 0] });
  assert.ok(trip({ dist: 0, srcLs: 0, cgLs: 0 }) >= 0.5);
  assert.ok(trip({ dist: 0, srcLs: 0, cgLs: 0, cal }) > 0);
});

// -- buildMixed ------------------------------------------------------------

const row = (commodity, station, system, supply, profit,
             { buy = 1000, minutes = 20, ly = 30, ls = 500, carrier = false,
               updated = "2025-01-01" } = {}) =>
  ({ commodity, station, system, supply, profit_per_t: profit, buy,
     trip_minutes: minutes, ly, ls, carrier, updated });

test("greedy packing fills the hold best first", () => {
  const plans = m.buildMixed([
    row("Gold", "Alpha", "Sys A", 40, 1000),
    row("Silver", "Alpha", "Sys A", 500, 500),
    row("Water", "Alpha", "Sys A", 500, 100),
  ], 100);
  assert.equal(plans.length, 1);
  const p = plans[0];
  assert.deepEqual(p.mix.map((x) => x.commodity), ["Gold", "Silver"]);
  assert.deepEqual(p.mix.map((x) => x.tonnes), [40, 60]);
  assert.equal(p.tonnes, 100);
  assert.equal(p.short, 0);
  assert.equal(p.total, 40 * 1000 + 60 * 500);
  assert.equal(p.cr_per_min, Math.round(p.total / 20));
});

test("input order does not matter", () => {
  assert.deepEqual(
    m.buildMixed([row("Gold", "A", "S", 40, 1000), row("Silver", "A", "S", 500, 500)], 100),
    m.buildMixed([row("Silver", "A", "S", 500, 500), row("Gold", "A", "S", 40, 1000)], 100));
});

test("a short station reports the shortfall", () => {
  const [p] = m.buildMixed([row("Gold", "A", "S", 20, 1000),
                            row("Silver", "A", "S", 10, 500)], 100);
  assert.equal(p.tonnes, 30);
  assert.equal(p.short, 70);
  assert.equal(p.total, 25000);
});

test("stations rank by credits per minute", () => {
  const plans = m.buildMixed([
    row("Gold", "Slow", "S1", 500, 1000, { minutes: 100 }),
    row("Gold", "Fast", "S2", 500, 600, { minutes: 20 }),
    row("Gold", "Mid", "S3", 500, 800, { minutes: 40 }),
  ], 100);
  assert.deepEqual(plans.map((p) => p.station), ["Fast", "Mid", "Slow"]);
});

test("the same station name in two systems stays separate", () => {
  const plans = m.buildMixed([row("Gold", "Jameson Memorial", "Shinrarta", 500, 900),
                              row("Gold", "Jameson Memorial", "Elsewhere", 500, 800)], 100);
  assert.equal(plans.length, 2);
});

test("station metadata comes from the best commodity", () => {
  const [p] = m.buildMixed([
    row("Silver", "A", "S", 500, 500, { updated: "2024-12-30", minutes: 17, ly: 12, ls: 99, carrier: true }),
    row("Gold", "A", "S", 40, 1000, { updated: "2024-12-31", minutes: 17, ly: 12, ls: 99, carrier: true }),
  ], 100);
  assert.equal(p.updated, "2024-12-31");
  assert.equal(p.trip_minutes, 17);
  assert.equal(p.carrier, true);
});

test("zero supply rows are skipped and an empty station dropped", () => {
  const [p] = m.buildMixed([row("Gold", "A", "S", 0, 1000), row("Silver", "A", "S", 50, 500)], 100);
  assert.deepEqual(p.mix.map((x) => x.commodity), ["Silver"]);
  assert.deepEqual(m.buildMixed([row("Gold", "A", "S", 0, 1000)], 100), []);
  assert.deepEqual(m.buildMixed([], 100), []);
});

test("mixed sort: names case-insensitive, missing values do not throw", () => {
  const plans = m.buildMixed([
    row("Gold", "beta dock", "Zeta", 500, 600, { minutes: 50 }),
    row("Gold", "Alpha Hub", "Yankee", 500, 1000, { minutes: 20 }),
  ], 100);
  const by = (key) => [...plans].sort((a, b) =>
    m.compareValues(m.mixedSortValue(a, key), m.mixedSortValue(b, key)))
    .map((p) => p.station);
  assert.deepEqual(by("station"), ["Alpha Hub", "beta dock"]);
  const junk = [...plans, { station: null, system: null, updated: null, ls: null }];
  for (const key of ["station", "system", "updated", "ls", "cr_per_min"]) {
    junk.sort((a, b) => m.compareValues(m.mixedSortValue(a, key), m.mixedSortValue(b, key)));
  }
});

// -- pads -------------------------------------------------------------------

test("ships map to the pad they need, case-insensitively, unknown is large", () => {
  assert.equal(m.padForShip("sidewinder"), "S");
  assert.equal(m.padForShip("PYTHON"), "M");
  assert.equal(m.padForShip("CobraMkIII"), "S");
  assert.equal(m.padForShip("Anaconda"), "L");
  assert.equal(m.padForShip("corsair"), "L");
  assert.equal(m.padForShip(null), "L");
  assert.deepEqual(new Set(Object.values(m.SHIP_PADS)), new Set(Object.keys(m.PAD_ORDER)));
});

test("Ardent's largest pad size admits every ship up to it", () => {
  assert.equal(m.padFits(3, "L"), true);
  assert.equal(m.padFits(3, "S"), true);
  assert.equal(m.padFits(2, "L"), false);
  assert.equal(m.padFits(2, "M"), true);
  assert.equal(m.padFits(1, "M"), false);
  assert.equal(m.padFits(1, "S"), true);
  // unknown pad is not evidence of a pad
  assert.equal(m.padFits(null, "S"), false);
  assert.equal(m.padFits(undefined, "S"), false);
});

// -- ages -------------------------------------------------------------------

test("days old counts whole UTC days, and unknown is null", () => {
  const now = new Date("2026-09-15T10:00:00Z");
  assert.equal(m.daysOld("2026-09-15", now), 0);
  assert.equal(m.daysOld("2026-09-15T23:59:59.000Z", now), 0);
  assert.equal(m.daysOld("2026-09-08", now), 7);
  assert.equal(m.daysOld("", now), null);
  assert.equal(m.daysOld(null, now), null);
  assert.equal(m.daysOld("garbage", now), null);
});

test("age tags follow the fresh and stale thresholds", () => {
  const now = new Date("2026-09-15T10:00:00Z");
  assert.equal(m.ageTag("2026-09-13", now), "age-ok");
  assert.equal(m.ageTag("2026-09-10", now), "age-mid");
  assert.equal(m.ageTag("2026-09-01", now), "age-old");
  assert.equal(m.ageTag(null, now), "age-old");
});

// -- where a station actually is ----------------------------------------------

test("surface station types are the ones you land on", () => {
  for (const t of ["CraterOutpost", "CraterPort", "OnFootSettlement", "SurfaceStation"]) {
    assert.ok(m.isPlanetary(t), t);
  }
  for (const t of ["Coriolis", "Orbis", "Ocellus", "Outpost", "AsteroidBase",
                   "MegaShip", "FleetCarrier", "Dodec"]) {
    assert.ok(!m.isPlanetary(t), t);
  }
});

test("an unknown station type is treated as orbital", () => {
  // Hiding a station the commander could have flown to is the worse error:
  // they would never know it was there.
  assert.ok(!m.isPlanetary("OrbitalWhatsit"));
  assert.ok(!m.isPlanetary(undefined));
});

test("station types read as the game names them", () => {
  assert.equal(m.stationTypeLabel("CraterOutpost"), "Planetary Outpost");
  assert.equal(m.stationTypeLabel("OnFootSettlement"), "Odyssey Settlement");
  assert.equal(m.stationTypeLabel("Orbis"), "Orbis Starport");
  assert.equal(m.stationTypeLabel("OrbitalWhatsit"), "OrbitalWhatsit");
  assert.equal(m.stationTypeLabel(null), "Station");
});

test("an orbital station says what it orbits, a surface one what it is on", () => {
  assert.equal(
    m.whereItIs({ stype: "Orbis", body: "Shinrarta Dezhra AB 2 i", planetary: false }),
    "Orbis Starport — orbiting Shinrarta Dezhra AB 2 i");
  assert.equal(
    m.whereItIs({ stype: "CraterPort", body: "Mercury", planetary: true }),
    "Planetary Port — on Mercury");
});

test("a carrier orbits nothing", () => {
  const t = m.whereItIs({ stype: "FleetCarrier", carrier: true, body: "" });
  assert.match(t, /orbits nothing/);
});

test("a missing body says so rather than guessing", () => {
  assert.equal(m.whereItIs({ stype: "Outpost", body: "", planetary: false }),
    "Outpost — no body on record");
  assert.equal(m.whereItIs(null), "");
});

test("a mixed plan inherits the station's body from its rows", () => {
  const row = (commodity, over = {}) => ({
    commodity, station: "Walz Depot", system: "Sol", supply: 100, profit_per_t: 10,
    buy: 1, ly: 1, ls: 205, carrier: false, updated: "2026-09-15", trip_minutes: 10,
    planetary: true, stype: "CraterOutpost", body: "Mercury", ...over,
  });
  const [plan] = m.buildMixed([row("Gold"), row("Silver", { profit_per_t: 5 })], 720);
  assert.equal(plan.planetary, true);
  assert.equal(plan.body, "Mercury");
  assert.equal(m.whereItIs(plan), "Planetary Outpost — on Mercury");
});

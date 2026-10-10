// Ported from test_cgbuy.py: TestCalibration, TestParseTs, TestHandle*,
// TestShipIdentity, TestLadenJumpRange.
import test from "node:test";
import assert from "node:assert/strict";
import { Calibration, JournalState, estScMinutes, ladenJumpRange, parseTs }
  from "../src/journal.js";

const near = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const ts = (hh, mm, ss = 0) =>
  `2025-01-01T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}Z`;

function feed(w, ...events) {
  return events.map((e) => w.handle(JSON.stringify(e), false));
}

// -- Calibration ------------------------------------------------------------

test("empty calibration has no learned values", () => {
  const cal = new Calibration();
  assert.equal(cal.jumpMinutes, null);
  assert.equal(cal.dockMinutes, null);
  assert.equal(cal.scScale, null);
  assert.match(cal.summary(), /estimate/);
});

test("below three samples is null, at three it is the median", () => {
  assert.equal(new Calibration({ jump_secs: [60, 60] }).jumpMinutes, null);
  const cal = new Calibration({ jump_secs: [30, 60, 900], dock_secs: [120, 300, 600] });
  near(cal.jumpMinutes, 1.0);
  near(cal.dockMinutes, 5.0);
  assert.match(cal.summary(), /jump 1\.00 min \(n=3\)/);
  near(new Calibration({ jump_secs: [60, 60, 60, 60, 290] }).jumpMinutes, 1.0);
  near(new Calibration({ jump_secs: [60, 120, 180, 240] }).jumpMinutes, 2.5);
});

test("sc scale is the median ratio of approach samples to the curve", () => {
  const model = estScMinutes(1000) * 60;
  near(new Calibration({ approach_samples: Array(4).fill([1000, model * 1.5]) }).scScale, 1.5);
  assert.equal(new Calibration({ approach_samples: [[100, 60]] }).scScale, null);
});

test("samples are capped at the newest 200 and round-trip through JSON", () => {
  const big = new Calibration({ jump_secs: Array.from({ length: 500 }, (_, i) => i) });
  assert.equal(big.jump_secs.length, 200);
  assert.equal(big.jump_secs[0], 300);
  const src = new Calibration({ jump_secs: [40, 50, 60],
    approach_samples: [[500, 130], [1000, 160], [2000, 200]] });
  const again = new Calibration(JSON.parse(JSON.stringify(src.toDict())));
  assert.deepEqual(again.toDict(), src.toDict());
  assert.equal(again.scScale, src.scScale);
});

test("the arrival fit reproduces both ends where one ratio cannot", () => {
  const cal = new Calibration({
    approach_samples: [...Array(3).fill([350, 208]), ...Array(3).fill([5000, 245])],
  });
  assert.notEqual(cal.arrivalFit, null);
  for (const [ls, secs] of [[350, 208], [5000, 245]]) {
    assert.ok(Math.abs(cal.arrivalMinutes(ls) * 60 - secs) / secs < 0.02);
    assert.ok(Math.abs(estScMinutes(ls) * 60 * cal.scScale - secs) / secs > 0.15);
  }
});

test("one distance cannot support a fit, the ratio stands in", () => {
  const far = estScMinutes(5000) * 60;
  const cal = new Calibration({ approach_samples: Array(3).fill([5000, far * 2]) });
  assert.equal(cal.arrivalFit, null);
  near(cal.scScale, 2.0);
  assert.equal(new Calibration({
    approach_samples: [...Array(3).fill([350, 208]), ...Array(3).fill([360, 210])],
  }).arrivalFit, null);
});

test("outside the range flown the fit is not extrapolated", () => {
  const cal = new Calibration({
    approach_samples: [...Array(3).fill([350, 208]), ...Array(3).fill([5000, 245])],
  });
  const [a, b] = cal.arrivalFit;
  assert.ok(cal.arrivalMinutes(40000) > (a + b * 40000 ** 0.3) / 60);
  assert.ok(cal.arrivalMinutes(10) < cal.arrivalMinutes(350));
  assert.ok(cal.arrivalMinutes(5000) < cal.arrivalMinutes(40000));
});

test("a farmed station does not outvote a rare one, and further is never cheaper", () => {
  const cal = new Calibration({
    approach_samples: [...Array(100).fill([350, 208]), ...Array(3).fill([5000, 245])],
  });
  assert.ok(Math.abs(cal.arrivalMinutes(5000) - 245 / 60) < 0.005);
  const back = new Calibration({
    approach_samples: [...Array(3).fill([350, 300]), ...Array(3).fill([5000, 200])],
  });
  if (back.arrivalFit) {
    assert.ok(back.arrivalFit[1] >= 0);
    assert.ok(back.arrivalMinutes(350) <= back.arrivalMinutes(5000));
  }
});

test("parseTs reads Zulu timestamps as UTC seconds and rejects junk", () => {
  assert.equal(parseTs(ts(12, 1)) - parseTs(ts(12, 0)), 60);
  assert.equal(parseTs("2025-01-01T00:00:00Z"), Date.UTC(2025, 0, 1) / 1000);
  for (const bad of [null, "", "not a timestamp", 12345]) assert.equal(parseTs(bad), null);
});

// -- JournalState.handle ----------------------------------------------------

test("back-to-back jumps inside 15..300s make samples", () => {
  const w = new JournalState();
  assert.deepEqual(feed(w,
    { timestamp: ts(12, 0, 0), event: "FSDJump", StarSystem: "A" },
    { timestamp: ts(12, 0, 15), event: "FSDJump", StarSystem: "B" },
    { timestamp: ts(12, 5, 15), event: "FSDJump", StarSystem: "C" },
    { timestamp: ts(12, 5, 20), event: "FSDJump", StarSystem: "D" },
    { timestamp: ts(12, 35, 20), event: "FSDJump", StarSystem: "E" }),
  [false, true, true, false, false]);
  assert.deepEqual(w.cal.jump_secs, [15, 300]);
  assert.equal(w.system, "E");
  assert.equal(w.docked, false);
});

test("dock stops inside 20..1800s make samples and set position", () => {
  const w = new JournalState();
  assert.deepEqual(feed(w,
    { timestamp: ts(12, 0), event: "Docked", StationName: "Metz Enterprise", StarSystem: "Ega" },
    { timestamp: ts(12, 5), event: "Undocked" }), [false, true]);
  assert.deepEqual(w.cal.dock_secs, [300]);
  feed(w, { timestamp: ts(13, 0), event: "Docked", StationName: "X", StarSystem: "Ega" });
  assert.equal(w.docked, true);
  assert.equal(w.station, "X");
  feed(w, { timestamp: ts(14, 0), event: "Undocked" });
  assert.deepEqual(w.cal.dock_secs, [300]);
});

test("jump then dock makes an approach sample, consumed once", () => {
  const w = new JournalState();
  feed(w,
    { timestamp: ts(12, 0), event: "FSDJump", StarSystem: "Ega" },
    { timestamp: ts(12, 3), event: "Docked", StationName: "A", DistFromStarLS: 1200 },
    { timestamp: ts(12, 6), event: "Undocked" },
    { timestamp: ts(12, 20), event: "Docked", StationName: "B", DistFromStarLS: 90000 });
  assert.deepEqual(w.cal.approach_samples, [[1200, 180]]);
  const x = new JournalState();
  feed(x,
    { timestamp: ts(12, 0), event: "FSDJump", StarSystem: "Ega" },
    { timestamp: ts(12, 3), event: "Docked", StationName: "X" });
  assert.deepEqual(x.cal.approach_samples, []);
});

test("undocked to first jump makes a departure sample", () => {
  const w = new JournalState();
  feed(w,
    { timestamp: ts(12, 0), event: "Docked", StationName: "A" },
    { timestamp: ts(12, 2), event: "Undocked" },
    { timestamp: ts(12, 3, 30), event: "FSDJump", StarSystem: "B" });
  assert.deepEqual(w.cal.depart_secs, [90]);
});

test("blank, malformed and non-object lines learn nothing", () => {
  const w = new JournalState();
  for (const junk of ["", "  \n", "{not json", "[]", '"x"', "3", "null", '{"event":"FSDJump"}']) {
    assert.equal(w.handle(junk, true), false);
  }
  assert.deepEqual(w.cal.toDict(), new Calibration().toDict());
});

test("callbacks: docked only fires live, calibration only on learning", () => {
  const w = new JournalState();
  const docked = [];
  const cals = [];
  w.onDocked = (stn, sys) => docked.push([stn, sys]);
  w.onCalibration = (cal) => cals.push(cal);
  const ev = JSON.stringify({ timestamp: ts(12, 0), event: "Docked", StationName: "M", StarSystem: "Ega" });
  w.handle(ev, false);
  assert.deepEqual(docked, []);
  w.handle(ev, true);
  assert.deepEqual(docked, [["M", "Ega"]]);
  w.handle(JSON.stringify({ timestamp: ts(13, 0), event: "FSDJump", StarSystem: "A" }), true);
  w.handle(JSON.stringify({ timestamp: ts(13, 1), event: "FSDJump", StarSystem: "B" }), true);
  assert.equal(cals.length, 1);
  assert.equal(cals[0], w.cal);
});

test("location and loadgame set position and commander", () => {
  const w = new JournalState();
  feed(w,
    { timestamp: ts(12, 0), event: "Location", StarSystem: "Ega", StationName: "M", Docked: true },
    { timestamp: ts(12, 1), event: "LoadGame", Commander: "Jameson" });
  assert.equal(w.system, "Ega");
  assert.equal(w.docked, true);
  assert.equal(w.commander, "Jameson");
});

// -- ship identity ----------------------------------------------------------

const PANTHER = { timestamp: ts(12, 0), event: "Loadout", Ship: "PantherMkII", ShipID: 36,
  Ship_Localised: "Panther Clipper Mk II", CargoCapacity: 832, MaxJumpRange: 39.575737,
  UnladenMass: 1836.5, FuelCapacity: { Main: 128.0 } };
const COBRA = { timestamp: ts(12, 30), event: "Loadout", Ship: "CobraMkIII", ShipID: 7,
  CargoCapacity: 64, MaxJumpRange: 28.0, UnladenMass: 180.0, FuelCapacity: { Main: 16.0 } };
const SWAP = { timestamp: ts(12, 20), event: "ShipyardSwap", ShipType: "CobraMkIII", ShipID: 7 };

test("the ship and its figures come from the loadout", () => {
  const w = new JournalState();
  feed(w, PANTHER);
  assert.deepEqual([w.ship, w.shipId, w.cargoCapacity, w.maxJumpRange, w.shipName],
    ["panthermkii", 36, 832, 39.575737, "Panther Clipper Mk II"]);
});

test("swapping ship drops the old figures until the new loadout lands", () => {
  const w = new JournalState();
  feed(w, PANTHER, SWAP);
  assert.equal(w.ship, "cobramkiii");
  for (const k of ["cargoCapacity", "maxJumpRange", "unladenMass", "fuelCapacity", "bestLadenJump"]) {
    assert.equal(w[k], null, k);
  }
  feed(w, COBRA);
  assert.deepEqual([w.cargoCapacity, w.maxJumpRange], [64, 28.0]);
});

test("two of the same hull are different ships; a refit keeps what it omits", () => {
  const w = new JournalState();
  feed(w, PANTHER, { timestamp: ts(13, 0), event: "Loadout", Ship: "PantherMkII", ShipID: 36, CargoCapacity: 784 });
  assert.deepEqual([w.cargoCapacity, w.maxJumpRange], [784, 39.575737]);
  feed(w, { timestamp: ts(14, 0), event: "Loadout", Ship: "PantherMkII", ShipID: 99, CargoCapacity: 400 });
  assert.deepEqual([w.cargoCapacity, w.maxJumpRange], [400, null]);
});

test("a laden jump belongs to the ship that made it", () => {
  const w = new JournalState();
  feed(w, PANTHER,
    { timestamp: ts(12, 5), event: "Cargo", Count: 800 },
    { timestamp: ts(12, 10), event: "FSDJump", StarSystem: "Ega", JumpDist: 21.5 });
  assert.equal(w.bestLadenJump, 21.5);
  feed(w, SWAP);
  assert.equal(w.bestLadenJump, null);
});

test("loadgame in another ship is a swap, on foot keeps the ship", () => {
  const w = new JournalState();
  feed(w, PANTHER, { timestamp: ts(13, 0), event: "LoadGame", Commander: "J" });
  assert.deepEqual([w.ship, w.cargoCapacity], ["panthermkii", 832]);
  feed(w, { timestamp: ts(13, 1), event: "LoadGame", Ship: "PantherMkII", ShipID: 36 });
  assert.equal(w.cargoCapacity, 832);
  feed(w, { timestamp: ts(13, 2), event: "LoadGame", Ship: "CobraMkIII", ShipID: 7 });
  assert.deepEqual([w.ship, w.cargoCapacity], ["cobramkiii", null]);
});

test("laden jump range scales by mass ratio and is floored by what was flown", () => {
  const P = [39.575737, 1836.5, 128.0, 832];
  near(ladenJumpRange(...P), 39.575737 * 1964.5 / 2796.5, 1e-6);
  assert.equal(ladenJumpRange(39.575737, 1836.5, 128.0, 0), null);
  assert.equal(ladenJumpRange(...P, 31.0), 31.0);
  near(ladenJumpRange(...P, 21.555), ladenJumpRange(...P));
  assert.equal(ladenJumpRange(null, null, null, 832, 21.5), 21.5);
  assert.equal(ladenJumpRange(null, null, null, null), null);
});

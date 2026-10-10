// Discovery against a fake Ardent. Mirrors what TestBuildRows and
// TestBuildRowsAgeFilter pin down for the Spansh path.
import test from "node:test";
import assert from "node:assert/strict";
import { ageFilter, buildRows } from "../src/ardent.js";
import { padLetter, tripMinutes, viewRows } from "../src/model.js";

const NOW = new Date("2026-09-15T10:00:00Z");
const FRESH = "2026-09-15T01:00:00.000Z";

const rec = ({ station, system = "Src", x = 10, y = 0, z = 0, pad = 3, type = "Coriolis",
               stock = 1000, buy = 1000, sell = 0, updated = FRESH, ls = 100, id,
               body = "Src 3 a" }) => ({
  stationName: station, systemName: system, systemX: x, systemY: y, systemZ: z,
  maxLandingPadSize: pad, stationType: type, stock, buyPrice: buy, sellPrice: sell,
  updatedAt: updated, distanceToArrival: ls, marketId: id ?? station, bodyName: body,
  distance: Math.round(Math.hypot(x, y, z)),
});

const DEST_STATIONS = [
  { stationName: "Other", systemX: 0, systemY: 0, systemZ: 0, distanceToArrival: 10 },
  { stationName: "Metz Enterprise", systemX: 0, systemY: 0, systemZ: 0, distanceToArrival: 5394 },
];

const P = (over = {}) => ({
  dest: { system: "Ega", station: "Metz Enterprise", commodities: ["Palladium"] },
  range: 30, min_supply: 200, hold: 720, pad: "L", carriers: false,
  jump_empty: 25, jump_laden: 18, max_age_days: 7, ...over,
});

// routes: {"stations": [...], "palladium/in": [...], "palladium/nearby": [...]}
function fakeArdent(routes) {
  const seen = [];
  const fetchJson = async (url) => {
    seen.push(url);
    const u = new URL(url);
    const parts = decodeURIComponent(u.pathname).split("/");
    let key;
    if (u.pathname.endsWith("/stations")) key = "stations";
    else if (u.pathname.endsWith("/nearby/exports")) key = `${parts.at(-3)}/nearby`;
    else key = `${parts.at(-1)}/in`;
    if (!(key in routes)) throw new Error(`no route ${key}`);
    const v = routes[key];
    if (v instanceof Error) throw v;
    return v;
  };
  return { fetchJson, seen };
}

const routes = (over = {}) => ({
  stations: DEST_STATIONS,
  "palladium/in": [rec({ station: "Metz Enterprise", system: "Ega", x: 0, stock: 0, buy: 0, sell: 150000 })],
  "palladium/nearby": [rec({ station: "Near", x: 10 })],
  ...over,
});

test("destination price, exact distance and trip time come through", async () => {
  const { fetchJson } = fakeArdent(routes());
  const { rows, cg, cgLs } = await buildRows(P(), { fetchJson, now: NOW });
  assert.deepEqual(cg, { Palladium: { sell: 150000, demand: undefined } });
  assert.equal(cgLs, 5394);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.station, "Near");
  assert.equal(r.ly, 10);
  assert.equal(r.profit_per_t, 149000);
  assert.equal(r.load, 720);
  const mins = tripMinutes(10, 100, 5394, 25, 18, null);
  assert.equal(r.trip_minutes, Math.round(mins * 10) / 10);
  assert.equal(r.cr_per_min, Math.round(720 * 149000 / mins));
  assert.equal(r.updated, "2026-09-15");
});

test("rows carry the station's largest pad as a letter", async () => {
  assert.equal(padLetter(3), "L");
  assert.equal(padLetter(2), "M");
  assert.equal(padLetter(1), "S");
  assert.equal(padLetter(undefined), "");
  const { fetchJson } = fakeArdent(routes());
  assert.equal((await buildRows(P(), { fetchJson, now: NOW })).rows[0].pad, "L");
});

test("queries use the commodity symbol and the search parameters", async () => {
  const { fetchJson, seen } = fakeArdent(routes());
  await buildRows(P({ range: 29.5, min_supply: 300 }), { fetchJson, now: NOW });
  const nearby = new URL(seen.find((u) => u.includes("/nearby/exports")));
  assert.match(nearby.pathname, /\/system\/name\/Ega\/commodity\/name\/palladium\/nearby\/exports$/);
  assert.equal(nearby.searchParams.get("maxDistance"), "30");
  assert.equal(nearby.searchParams.get("minVolume"), "300");
  assert.equal(nearby.searchParams.has("fleetCarriers"), false);   // carriers are a view filter
  assert.ok(Number(nearby.searchParams.get("maxDaysAgo")) >= 7);
});

test("the destination system's own markets are sources too", async () => {
  const { fetchJson } = fakeArdent(routes({
    "palladium/in": [
      rec({ station: "Metz Enterprise", system: "Ega", x: 0, stock: 0, buy: 0, sell: 150000 }),
      rec({ station: "Same System", system: "Ega", x: 0, ls: 20 }),
      rec({ station: "Too Little", system: "Ega", x: 0, stock: 150 }),
      rec({ station: "A Carrier", system: "Ega", x: 0, type: "FleetCarrier" }),
    ],
  }));
  const { rows } = await buildRows(P(), { fetchJson, now: NOW });
  assert.deepEqual(rows.map((r) => r.station).sort(), ["A Carrier", "Near", "Same System"]);
  assert.equal(rows.find((r) => r.station === "Same System").ly, 0);
});

test("carriers, surface stations and every pad size are kept for the view to filter", async () => {
  const r = routes({ "palladium/nearby": [rec({ station: "Near" }), rec({ station: "FC", type: "FleetCarrier" }),
    rec({ station: "Surf", type: "CraterPort" }), rec({ station: "Small", pad: 1 })] });
  const a = fakeArdent(r);
  const res = await buildRows(P(), { fetchJson: a.fetchJson, now: NOW });
  assert.deepEqual(res.rows.map((x) => x.station).sort(), ["FC", "Near", "Small", "Surf"]);
  assert.equal(res.rows.find((x) => x.station === "FC").carrier, true);
  // Toggling the filters is viewRows' job: no request is made.
  const n = a.seen.length;
  for (const o of [{ odyssey: true }, { carriers: true, pad: "S" }, {}]) viewRows(res.rows, o);
  assert.equal(a.seen.length, n);
});

test("radius, supply and profit filters apply; pad is left to the view", async () => {
  const { fetchJson } = fakeArdent(routes({
    "palladium/nearby": [
      rec({ station: "Ok" }),
      rec({ station: "Medium Pad", pad: 2 }),
      rec({ station: "Unknown Pad", pad: null }),
      rec({ station: "Just Outside", x: 30.4 }),
      rec({ station: "Loss", buy: 150001 }),
      rec({ station: "Empty", stock: 0 }),
    ],
  }));
  const { rows } = await buildRows(P(), { fetchJson, now: NOW });
  assert.deepEqual(rows.map((r) => r.station), ["Ok", "Medium Pad", "Unknown Pad"]);
  assert.deepEqual(viewRows(rows, { pad: "L" }).map((r) => r.station), ["Ok"]);   // unknown pad never fits
});

test("a commodity the destination does not buy yields nothing", async () => {
  const { fetchJson } = fakeArdent(routes({
    "palladium/in": [rec({ station: "Metz Enterprise", system: "Ega", x: 0, sell: 0 })],
  }));
  await assert.rejects(buildRows(P(), { fetchJson, now: NOW }), /no prices/i);
});

test("one failing commodity does not sink the others", async () => {
  const { fetchJson } = fakeArdent({
    ...routes(),
    "gold/in": new Error("boom"),
    "gold/nearby": [],
  });
  const { rows, errors } = await buildRows(
    P({ dest: { system: "Ega", station: "Metz Enterprise", commodities: ["Gold", "Palladium"] } }),
    { fetchJson, now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Gold.*boom/);
});

test("an unknown destination station is an error, an empty destination is not", async () => {
  const { fetchJson } = fakeArdent(routes({ stations: [DEST_STATIONS[0]] }));
  await assert.rejects(buildRows(P(), { fetchJson, now: NOW }), /Metz Enterprise/);
  const none = await buildRows(P({ dest: { system: "", station: "", commodities: [] } }),
    { fetchJson: async () => { throw new Error("must not fetch"); }, now: NOW });
  assert.deepEqual(none.rows, []);
});

test("rows come back best credits per minute first", async () => {
  const { fetchJson } = fakeArdent(routes({
    "palladium/nearby": [rec({ station: "Far", x: 29 }), rec({ station: "Close", x: 5 })],
  }));
  const { rows } = await buildRows(P(), { fetchJson, now: NOW });
  assert.deepEqual(rows.map((r) => r.station), ["Close", "Far"]);
});

test("age filter hides stale rows, stands down when all are stale, 0 disables", async () => {
  const rows = [{ updated: "2026-09-14" }, { updated: "2026-09-01" }, { updated: "" }];
  assert.deepEqual(ageFilter(rows, 7, NOW), { rows: [rows[0]], hidden: 2, allStale: false });
  const old = [{ updated: "2026-09-01" }];
  assert.deepEqual(ageFilter(old, 7, NOW), { rows: old, hidden: 0, allStale: true });
  assert.deepEqual(ageFilter(rows, 0, NOW), { rows, hidden: 0, allStale: false });
  const { fetchJson } = fakeArdent(routes({
    "palladium/nearby": [rec({ station: "New" }), rec({ station: "Old", updated: "2026-08-01T00:00:00Z" })],
  }));
  const res = await buildRows(P(), { fetchJson, now: NOW });
  assert.deepEqual(res.rows.map((r) => r.station), ["New"]);
  assert.equal(res.hiddenStale, 1);
});


// -- the ODYSSEY filter, and what a station is ---------------------------------

test("stations on a surface are hidden unless ODYSSEY is on", async () => {
  const both = routes({ "palladium/nearby": [
    rec({ station: "Near", x: 10 }),
    rec({ station: "Berdo Drilling Hub", x: 11, type: "OnFootSettlement" }),
    rec({ station: "Walz Depot", x: 12, type: "CraterOutpost" }),
    rec({ station: "Ehrlich City", x: 13, type: "CraterPort" }),
  ] });
  const res = await buildRows(P(), { fetchJson: fakeArdent(both).fetchJson, now: NOW });
  assert.deepEqual(viewRows(res.rows, {}).map((r) => r.station), ["Near"]);
  assert.deepEqual(viewRows(res.rows, { odyssey: true }).map((r) => r.station).sort(),
    ["Berdo Drilling Hub", "Ehrlich City", "Near", "Walz Depot"]);
});

test("a station type nobody has heard of stays visible", async () => {
  // Getting it wrong this way leaves a station on screen that perhaps should
  // not be; the other way hides one the commander could have flown to.
  const { fetchJson } = fakeArdent(routes({ "palladium/nearby": [
    rec({ station: "Something New", x: 10, type: "OrbitalWhatsit" }),
  ] }));
  const { rows } = await buildRows(P(), { fetchJson, now: NOW });
  assert.deepEqual(rows.map((r) => r.station), ["Something New"]);
});

test("the body and the station type reach the row", async () => {
  const { fetchJson } = fakeArdent(routes({ "palladium/nearby": [
    rec({ station: "Jameson Memorial", x: 10, type: "Orbis", body: "Shinrarta Dezhra AB 2 i" }),
  ] }));
  const { rows } = await buildRows(P(), { fetchJson, now: NOW });
  assert.equal(rows[0].body, "Shinrarta Dezhra AB 2 i");
  assert.equal(rows[0].stype, "Orbis");
  assert.equal(rows[0].planetary, false);
});

test("a surface station is marked as one", async () => {
  const { fetchJson } = fakeArdent(routes({ "palladium/nearby": [
    rec({ station: "Walz Depot", x: 10, type: "CraterOutpost", body: "Mercury" }),
  ] }));
  const { rows } = await buildRows(P({ odyssey: true }), { fetchJson, now: NOW });
  assert.equal(rows[0].planetary, true);
  assert.equal(rows[0].body, "Mercury");
});

test("a record with no body still ranks", async () => {
  const { fetchJson } = fakeArdent(routes({ "palladium/nearby": [
    rec({ station: "Near", x: 10, body: null }),
  ] }));
  const { rows } = await buildRows(P(), { fetchJson, now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, "");
});

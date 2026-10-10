// Spansh discovery and EDSM verification against fakes; ports of
// TestFetchSources*, TestStationFits, TestBuildRows and TestVerifyRefresh.
import test from "node:test";
import assert from "node:assert/strict";
import { EdsmGate } from "../src/edsm.js";
import { buildRows, fetchSources, refresh, stationFits, stationPad, worthRetrying } from "../src/spansh.js";

const NOW = new Date("2026-09-15T10:00:00Z");
const nap = async () => {};
const httpErr = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

const stations = (n, first = 1, step = 1) => Array.from({ length: n }, (_, i) => ({
  name: `S${i}`, distance: first + i * step, market: [] }));

// -- fetchSources ---------------------------------------------------------------

test("payload carries commodity, radius, min supply and the reference system", async () => {
  const sent = [];
  const fetchJson = async (url, init) => { sent.push([url, JSON.parse(init.body)]); return { results: stations(1) }; };
  await fetchSources("Bertrandite", 55, 700, "Sol", { fetchJson, pageSize: 250 });
  const [url, b] = sent[0];
  assert.match(url, /stations\/search$/);
  assert.equal(b.reference_system, "Sol");
  assert.deepEqual(b.filters.distance.value, [0, 55]);
  assert.equal(b.filters.market[0].name, "Bertrandite");
  assert.equal(b.filters.market[0].supply.value[0], 700);
  assert.equal(b.size, 250);
  assert.equal(b.page, 0);
});

test("full pages are followed until one comes up short; missing results is empty", async () => {
  const pages = [stations(10, 1), stations(10, 11), stations(4, 21)];
  const seen = [];
  const fetchJson = async (_u, init) => { const b = JSON.parse(init.body); seen.push(b.page); return { results: pages[b.page] }; };
  assert.equal((await fetchSources("Gold", 40, 1, "Sol", { fetchJson, pageSize: 10 })).length, 24);
  assert.deepEqual(seen, [0, 1, 2]);
  assert.deepEqual(await fetchSources("Gold", 40, 1, "Sol", { fetchJson: async () => ({}) }), []);
});

test("a page ending beyond the radius stops the walk; maxPages caps it", async () => {
  let calls = 0;
  const far = async () => { calls++; return { results: stations(10, 35) }; };
  assert.equal((await fetchSources("Gold", 40, 1, "Sol", { fetchJson: far, pageSize: 10 })).length, 10);
  assert.equal(calls, 1);
  calls = 0;
  const near = async () => { calls++; return { results: stations(10, 1, 0.1) }; };
  assert.equal((await fetchSources("Gold", 40, 1, "Sol", { fetchJson: near, pageSize: 10, maxPages: 3 })).length, 30);
  assert.equal(calls, 3);
});

test("a dropped later page keeps what was fetched and is reported", async () => {
  const fetchJson = async (_u, init) => {
    if (JSON.parse(init.body).page > 0) throw new TypeError("connection reset");
    return { results: stations(10) };
  };
  const told = [];
  const out = await fetchSources("Gold", 40, 1, "Sol",
    { fetchJson, pageSize: 10, pause: 0, sleep: nap, onFail: (...a) => told.push(a) });
  assert.equal(out.length, 10);
  assert.equal(told[0][0], "Gold");
  assert.equal(told[0][1], 1);
});

test("a 502 is asked again, attempts are bounded, a 400 is not retried", async () => {
  let n = 0;
  const flaky = async () => { if (++n <= 2) throw httpErr(502); return { results: stations(3) }; };
  assert.equal((await fetchSources("Gold", 40, 1, "Sol", { fetchJson: flaky, pageSize: 10, sleep: nap })).length, 3);
  assert.equal(n, 3);

  n = 0;
  const told = [];
  const dead = async () => { n++; throw httpErr(502); };
  assert.deepEqual(await fetchSources("Silver", 40, 1, "Sol",
    { fetchJson: dead, sleep: nap, onFail: (...a) => told.push(a) }), []);
  assert.equal(n, 3);
  assert.deepEqual(told.map((t) => t.slice(0, 2)), [["Silver", 0]]);

  n = 0;
  await fetchSources("Gold", 40, 1, "Sol", { fetchJson: async () => { n++; throw httpErr(400); }, sleep: nap });
  assert.equal(n, 1);
  assert.deepEqual([429, 500, 502, 503, 504].map((c) => worthRetrying(httpErr(c))), Array(5).fill(true));
  assert.equal(worthRetrying(httpErr(404)), false);
});

test("stationPad reports the largest pad, and rows carry it", async () => {
  assert.equal(stationPad({ has_large_pad: true }), "L");
  assert.equal(stationPad({ large_pads: 2, medium_pads: 1 }), "L");
  assert.equal(stationPad({ medium_pads: 1, small_pads: 1 }), "M");
  assert.equal(stationPad({ small_pads: 3 }), "S");
  assert.equal(stationPad({}), "");
  const { fetchJson } = fake({ spansh: [src("Near", { large_pads: 0, medium_pads: 1 })], edsm: DEST });
  assert.equal((await buildRows(P({ pad: "M" }), { fetchJson, now: NOW, sleep: nap, gate: fakeGate() })).rows[0].pad, "M");
});

test("a large pad counts for every size", () => {
  assert.ok(stationFits({ has_large_pad: true }, "S"));
  assert.ok(stationFits({ large_pads: 1 }, "M"));
  assert.ok(stationFits({ medium_pads: 1 }, "M"));
  assert.ok(!stationFits({ medium_pads: 1 }, "L"));
  assert.ok(!stationFits({ small_pads: 2 }, "M"));
  assert.ok(stationFits({ small_pads: 2 }, "S"));
});

// -- buildRows + refresh --------------------------------------------------------

const src = (name, over = {}) => ({
  name, system_name: "Src", distance: 10, distance_to_arrival: 100, type: "Coriolis Starport",
  large_pads: 1, market_updated_at: "2026-09-14T01:00:00Z", body_name: "",
  market: [{ commodity: "Palladium", supply: 1000, buy_price: 1000 }], ...over,
});

// world: spansh results, edsm {sys: {station: {time, body, goods:{c:[buy,stock]}}}}
function fake({ spansh = [src("Near")], edsm = {}, hook } = {}) {
  const urls = [];
  const fetchJson = async (url) => {
    urls.push(url);
    if (hook) hook(url);
    if (url.startsWith("https://spansh")) return { results: spansh };
    const u = new URL(url);
    const sys = u.searchParams.get("systemName");
    const stn = u.searchParams.get("stationName");
    const s = edsm[sys] ?? {};
    if (!stn) return { stations: Object.entries(s).map(([name, v]) => ({
      name, distanceToArrival: v.ls, updateTime: { market: v.time }, ...(v.body && { body: { name: v.body } }) })) };
    return { commodities: Object.entries(s[stn]?.goods ?? {}).map(([name, [buy, stock, sell, demand]]) =>
      ({ name, buyPrice: buy, stock, sellPrice: sell ?? 0, demand: demand ?? 0 })) };
  };
  return { fetchJson, urls };
}
const DEST = { Ega: { "Metz Enterprise": { ls: 5394, time: "2026-09-15 01:00:00", goods: { Palladium: [0, 0, 150000, 99] } } } };
const P = (over = {}) => ({
  dest: { system: "Ega", station: "Metz Enterprise", commodities: ["Palladium"] },
  range: 30, min_supply: 200, hold: 720, pad: "L", carriers: false,
  jump_empty: 25, jump_laden: 18, max_age_days: 7, verify_edsm: false, ...over });
const fakeGate = () => { let t = 1e6; return new EdsmGate({ now: () => t, sleep: async (ms) => { t += ms; } }); };
// The final result, after background EDSM verification has finished.
const run = async (w, p = P(), extra = {}) => {
  let last;
  const first = await buildRows(p, { fetchJson: w.fetchJson, sleep: nap, now: NOW, gate: fakeGate(),
    onUpdate: (r) => { last = r; }, ...extra });
  await first.verifying;
  return last ?? first;
};

test("rows have the ardent shape; destination price and arrival come from EDSM", async () => {
  const { rows, cg, cgLs, errors } = await run(fake({ edsm: DEST }));
  assert.deepEqual(cg, { Palladium: { sell: 150000, demand: 99 } });
  assert.equal(cgLs, 5394);
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(rows[0]), ["commodity", "station", "system", "carrier", "planetary",
    "stype", "body", "pad", "ly", "ls", "supply", "buy", "sell", "profit_per_t", "load", "loads_available",
    "trip_minutes", "trip_profit", "cr_per_min", "t_per_min", "updated"]);
  assert.equal(rows[0].profit_per_t, 149000);
  assert.equal(rows[0].load, 720);
  assert.equal(rows[0].updated, "2026-09-14");
});

test("pad, carrier, surface and unprofitable rows are filtered", async () => {
  const spansh = [src("Small", { large_pads: 0, small_pads: 1 }), src("FC", { type: "Drake-Class Carrier" }),
    src("Surf", { is_planetary: true }), src("Cheap", { market: [{ commodity: "Palladium", supply: 5, buy_price: 200000 }] }),
    src("Empty", { market: [{ commodity: "Palladium", supply: 0, buy_price: 10 }] }), src("Far", { distance: 31 }), src("Ok")];
  assert.deepEqual((await run(fake({ spansh, edsm: DEST }))).rows.map((r) => r.station), ["Ok"]);
  const all = await run(fake({ spansh, edsm: DEST }), P({ pad: "S", carriers: true, odyssey: true }));
  assert.deepEqual(all.rows.map((r) => r.station).sort(), ["FC", "Ok", "Small", "Surf"]);
});

test("a destination EDSM has no market for is an error", async () => {
  await assert.rejects(run(fake()), /EDSM returned no market/);
});

test("a commodity Spansh could not answer for is reported, not silent", async () => {
  const w = fake({ edsm: DEST });
  const inner = w.fetchJson;
  const { rows, errors } = await run({ fetchJson: async (u, i) => { if (u.startsWith("https://spansh")) throw httpErr(400); return inner(u, i); } });
  assert.deepEqual(rows, []);
  assert.match(errors[0], /Palladium: Spansh failed/);
});

test("old rows are hidden unless that would hide everything", async () => {
  const spansh = [src("Old", { market_updated_at: "2026-08-01T00:00:00Z" }), src("New")];
  const r = await run(fake({ spansh, edsm: DEST }));
  assert.deepEqual(r.rows.map((x) => x.station), ["New"]);
  assert.equal(r.hiddenStale, 1);
  const stale = await run(fake({ spansh: [spansh[0]], edsm: DEST }));
  assert.equal(stale.rows.length, 1);
  assert.ok(stale.allStale);
});

test("EDSM corrects supply, rescoring and dropping emptied stations, and fills the body", async () => {
  const edsm = { ...DEST,
    Src: { Near: { time: "2026-09-15 02:00:00", body: "Src 3 a", goods: { Palladium: [1100, 18] } },
           Gone: { time: "2026-09-15 02:00:00", goods: { Palladium: [1000, 0] } } } };
  const spansh = [src("Near"), src("Gone")];
  const { rows } = await run(fake({ spansh, edsm }), P({ verify_edsm: true }));
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.deepEqual([r.supply, r.buy, r.profit_per_t, r.load, r.trip_profit], [18, 1100, 148900, 18, 18 * 148900]);
  assert.equal(r.updated, "2026-09-15");
  assert.equal(r.body, "Src 3 a");
  assert.equal(r.edsm, true);
});

const vrow = (o = {}) => ({ commodity: "Gold", station: "Alpha", system: "A", supply: 530, buy: 9000,
  sell: 45000, profit_per_t: 36000, cr_per_min: 1000, updated: "2025-01-01", ...o });
const client = (w) => ({ system: (s) => w.fetchJson(`https://www.edsm.net/api-system-v1/stations?systemName=${s}`),
  market: (s, n) => w.fetchJson(`https://www.edsm.net/api-system-v1/stations/market?systemName=${s}&stationName=${n}`) });
const gold = (time = "2025-06-01 09:00:00") => ({ time, goods: { Gold: [9100, 18] } });

test("refresh checks only the top stations, ranked by cr/min", async () => {
  const w = fake({ edsm: { A: { S0: gold(), S1: gold(), S2: gold() } } });
  const rows = [10, 90, 50].map((c, i) => vrow({ station: `S${i}`, cr_per_min: c }));
  const res = await refresh(rows, client(w), { top: 2 });
  assert.deepEqual([res.checked, res.corrected], [2, 2]);
  assert.deepEqual(rows.map((r) => r.edsm), [false, true, true]);
});

test("refresh leaves unknown stations and stale EDSM data alone", async () => {
  const w = fake({ edsm: { A: { Alpha: gold("2024-01-01 00:00:00") } } });
  const rows = [vrow(), vrow({ station: "Ghost" })];
  const res = await refresh(rows, client(w));
  assert.equal(res.checked, 0);       // EDSM older than Spansh: no market request spent
  assert.deepEqual(rows.map((r) => r.edsm), [false, false]);
  assert.equal(rows[0].supply, 530);
});

test("refresh honours the request budget and applies each station as it lands", async () => {
  const w = fake({ edsm: { A: { Alpha: gold() } } });
  assert.equal((await refresh([vrow()], client(w), { budget: 0 })).checked, 0);
  const seen = [];
  const rows = [vrow()];
  await refresh(rows, client(w), { onApply: () => seen.push([rows[0].edsm, rows[0].pending]) });
  assert.deepEqual(seen, [[true, false]]);
});

test("Spansh rows come back unconfirmed, then EDSM confirms them in the background", async () => {
  const edsm = { ...DEST, Src: { Near: { time: "2026-09-15 02:00:00", goods: { Palladium: [1100, 18] } } } };
  const updates = [];
  const first = await buildRows(P({ verify_edsm: true }), { fetchJson: fake({ spansh: [src("Near")], edsm }).fetchJson,
    sleep: nap, now: NOW, gate: fakeGate(), onUpdate: (r) => updates.push(r) });
  assert.deepEqual([first.rows[0].edsm, first.rows[0].pending, first.rows[0].supply], [false, true, 1000]);
  await first.verifying;
  assert.equal(updates.at(-1).rows[0].edsm, true);
  assert.equal(updates.at(-1).rows[0].supply, 18);
});

test("a station EDSM empties is reported as dropped, with the reason", async () => {
  const edsm = { ...DEST, Src: { Near: { time: "2026-09-15 02:00:00", goods: { Palladium: [1100, 0] } } } };
  const res = await run(fake({ spansh: [src("Near")], edsm }), P({ verify_edsm: true }));
  assert.equal(res.rows.length, 0);
  assert.deepEqual(Object.values(res.dropped), ["sold out"]);
});

test("a 429 pauses the queue and verification resumes with nothing skipped", async () => {
  const edsm = { ...DEST, Src: { Near: { time: "2026-09-15 02:00:00", goods: { Palladium: [1100, 18] } } } };
  const w = fake({ spansh: [src("Near")], edsm });
  let refused = false;
  const fetchJson = async (url, init) => {
    if (url.includes("/stations/market") && url.includes("Src") && !refused) { refused = true; throw httpErr(429); }
    return w.fetchJson(url, init);
  };
  const res = await run({ fetchJson }, P({ verify_edsm: true }));
  assert.equal(refused, true);
  assert.equal(res.rows[0].edsm, true);
  assert.deepEqual(res.errors, []);
});

test("a superseded search stops verifying and says nothing", async () => {
  const edsm = { ...DEST, Src: { Near: { time: "2026-09-15 02:00:00", goods: { Palladium: [1100, 18] } } } };
  const w = fake({ spansh: [src("Near")], edsm });
  let dead = false, n = 0;
  const first = await buildRows(P({ verify_edsm: true }), { fetchJson: w.fetchJson, sleep: nap, now: NOW,
    gate: fakeGate(), cancelled: () => dead, onUpdate: () => n++,
    onProgress: (ev) => { if (ev.provider === "spansh" && ev.stage === "done") dead = true; } });
  await first.verifying;
  assert.equal(n, 0);
  assert.equal(w.urls.filter((u) => u.includes("Src")).length, 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { completions, dockedDestination, marketGoods, premiumGoods, splitToken, stationList, systemNames, withAdded } from "../src/destination.js";
import { nameFor } from "../src/commodities.js";

test("system search keeps names, sorted", () => {
  assert.deepEqual(systemNames([{ systemName: "Sol" }, { systemName: "Alpha" }, {}]), ["Alpha", "Sol"]);
  assert.deepEqual(systemNames({ error: "x" }), []);
});

test("stations: markets only, nearest arrival first, typed", () => {
  const got = stationList([
    { stationName: "Far", marketId: 1, distanceToArrival: 2000, stationType: "Coriolis" },
    { stationName: "NoMarket", marketId: null, distanceToArrival: 1 },
    { stationName: "Near", marketId: 2, distanceToArrival: 12.4, stationType: "CraterPort" }]);
  assert.deepEqual(got.map((s) => s.name), ["Near", "Far"]);
  assert.equal(got[0].label, "Planetary port · 12 Ls");
  assert.equal(got[1].label, "Coriolis · 2,000 Ls");
});

test("token completion keeps the earlier tokens", () => {
  assert.deepEqual(splitToken("Gold,pal"), { head: "Gold, ", token: "pal" });
  assert.deepEqual(splitToken("pal"), { head: "", token: "pal" });
  const names = ["Gold", "Palladium", "Silver", "Opal"];
  assert.deepEqual(completions("Gold, pal", names), ["Gold, Palladium", "Gold, Opal"]);
  assert.deepEqual(completions("Gold, gol", names), []);          // already listed
  assert.deepEqual(completions("Gold, ", names), []);
});

test("premium: 2.5x mean or better, localised names, sorted", () => {
  const items = [
    { Name: "$gold_name;", Name_Localised: "Gold", MeanPrice: 10000, SellPrice: 26000 },
    { Name: "silver", MeanPrice: 4000, SellPrice: 10000 },
    { Name: "water", MeanPrice: 100, SellPrice: 200 },
    { Name: "none", MeanPrice: 0, SellPrice: 5 }];
  assert.deepEqual(premiumGoods(items), ["Gold", "silver"]);
  assert.deepEqual(premiumGoods(null), []);
});

test("docked destination needs the journal docked and Market.json from that station", () => {
  const j = { docked: true, system: "S", station: "T" };
  const m = { StationName: "T", StarSystem: "S", Items: [{ Name: "g", MeanPrice: 1, SellPrice: 3 }] };
  assert.deepEqual(dockedDestination(j, m), { system: "S", station: "T", commodities: ["g"] });
  assert.deepEqual(dockedDestination(j, { ...m, StationName: "Other" }).commodities, []);
  assert.equal(dockedDestination({ ...j, docked: false }, m), null);
});

test("market goods: what it buys, by display name", () => {
  assert.deepEqual(marketGoods([{ commodityName: "agriculturalmedicines", demand: 5 }, { commodityName: "gold", demand: 0 },
    { commodityName: "silver", demand: 1 }]), ["Agri-Medicines", "Silver"]);
  assert.equal(nameFor("unknownthing"), "unknownthing");
});

test("withAdded skips duplicates, any case", () => {
  assert.equal(withAdded("Gold, silver", ["Silver", "Tea"]), "Gold, silver, Tea");
});

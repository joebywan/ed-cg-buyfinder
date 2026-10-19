import { test } from "node:test";
import assert from "node:assert/strict";
import { allowance, onTheWay, wantsPanel } from "../src/corridor.js";

const row = (station, pos, profit, supply = 500) => ({ station, system: station, pos, commodity: "Gold",
  profit_per_t: profit, supply, buy: 1, ly: 0, ls: 0, trip_minutes: 1 });

test("panel shows only outside the radius", () => {
  assert.equal(wantsPanel([0, 0, 0], [100, 0, 0], 120), false);
  assert.equal(wantsPanel([0, 0, 0], [200, 0, 0], 120), true);
  assert.equal(wantsPanel(null, [200, 0, 0], 120), false);
});

test("allowance is 15% of the trip, floored at two laden jumps", () => {
  assert.equal(allowance(1000, 20), 150);
  assert.equal(allowance(100, 20), 40);
});

test("ranks by hold value within the detour, drops those off the route", () => {
  const you = [0, 0, 0], dest = [1000, 0, 0];
  const rows = [row("onroute", [300, 0, 0], 1000), row("cheap", [400, 5, 0], 100),
    row("wayoff", [300, 400, 0], 5000), row("behind", [-200, 0, 0], 5000), row("nocoords", undefined, 9999)];
  const plans = onTheWay(rows, { you, dest, hold: 100, jumpLaden: 20 });
  assert.deepEqual(plans.map((p) => p.station), ["onroute", "cheap"]);
  assert.equal(plans[0].total, 100000);
  assert.ok(plans[0].detour < 1e-9 && plans[1].detour < 1);
});

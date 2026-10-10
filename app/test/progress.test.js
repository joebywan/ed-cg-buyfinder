import test from "node:test";
import assert from "node:assert/strict";
import { Progress } from "../src/progress.js";
import { buildRows } from "../src/spansh.js";
import { clearLog, formatLog, getLog, log } from "../src/log.js";

test("overall is steps done over steps planned, across providers", () => {
  const p = new Progress();
  p.update({ provider: "spansh", stage: "discovery", done: 0, total: 8 });
  p.update({ provider: "edsm", stage: "destination", done: 0, total: 12 });
  assert.equal(p.overall(), 0);
  p.update({ provider: "spansh", stage: "discovery", done: 8, total: 8 });
  assert.equal(p.overall(), 8 / 20);          // not 100% while EDSM is still ahead
  p.update({ provider: "spansh", stage: "done" });
  p.update({ provider: "edsm", stage: "verify", done: 6, total: 12 });
  assert.equal(p.overall(), 14 / 20);
  p.update({ provider: "edsm", stage: "failed", detail: "boom" });
  assert.equal(p.overall(), 20 / 20);
  assert.equal(p.p.edsm.state, "failed");
});

test("spansh buildRows plans EDSM steps up front and is not at 100% while discovery runs", async () => {
  const fetchJson = async (url) => {
    if (url.includes("/market")) return { commodities: [{ name: "Gold", sellPrice: 9000, demand: 5 }] };
    if (url.includes("edsm.net")) return { stations: [] };
    return { results: [] };
  };
  const p = new Progress();
  const seen = [];
  const dest = { system: "Sol", station: "Abraham Lincoln", commodities: ["Gold"] };
  await buildRows({ dest, range: 50, min_supply: 1, hold: 100, jump_empty: 10, jump_laden: 8 },
    { fetchJson, sleep: async () => {}, onProgress: (e) => { p.update(e); seen.push(p.overall()); } });
  assert.ok(seen.slice(0, 4).every((x) => x < 1));
  assert.equal(p.overall(), 1);
});

test("log keeps the newest 1000 lines, in order, and clears", () => {
  clearLog();
  for (let i = 0; i < 1005; i++) log("t", `m${i}`, 0);
  assert.equal(getLog().length, 1000);
  assert.equal(getLog()[0].msg, "m5");
  assert.equal(getLog().at(-1).msg, "m1004");
  assert.match(formatLog().split("\n")[0], /^\d\d:\d\d:\d\d \[t\] m5$/);
  clearLog();
  assert.equal(getLog().length, 0);
});

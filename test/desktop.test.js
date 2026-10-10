import test from "node:test";
import assert from "node:assert/strict";
import { DesktopDir, loadStore, mapLegacy } from "../src/desktop.js";
import { JournalTail } from "../src/tail.js";

function fakeInvoke(files) {
  return async (name, args) => {
    if (name === "journal_list") {
      return Object.entries(files).map(([n, f]) => ({ name: n, size: f.length, mtime_ms: 5 }));
    }
    if (name === "journal_read") return new TextEncoder().encode(files[args.name].slice(args.offset)).buffer;
    throw new Error(name);
  };
}

test("JournalTail primes and polls through DesktopDir", async () => {
  const files = { "Journal.2026-09-15T100000.01.log": "a\nb\npart", "Market.json": '{"x":1}' };
  const got = [];
  const tail = new JournalTail(new DesktopDir(fakeInvoke(files)), (l, live) => got.push([l, live]));
  assert.equal(await tail.prime(), 2);
  files["Journal.2026-09-15T100000.01.log"] += "ial\nc\n";
  assert.equal(await tail.poll(), 2);
  assert.deepEqual(got, [["a", false], ["b", false], ["partial", true], ["c", true]]);
  assert.deepEqual(await tail.stationFile("Market"), { x: 1 });
  assert.equal(await tail.stationFile("Shipyard"), null);
});

test("getFileHandle throws when absent; file text and size", async () => {
  const dir = new DesktopDir(fakeInvoke({ "Market.json": "hi" }));
  await assert.rejects(dir.getFileHandle("Nope.json"));
  const f = await (await dir.getFileHandle("Market.json")).getFile();
  assert.equal(f.size, 2);
  assert.equal(await f.text(), "hi");
});

test("mapLegacy carries params, odyssey, eddn and a manual destination", () => {
  const dest = { system: "Sol", station: "Abraham Lincoln", commodities: ["Gold"] };
  const m = mapLegacy({ params: { hold: 128, range: "30", jump_empty: 0, min_supply: "" },
    odyssey: true, eddn_enabled: true, eddn_seen: [["a"]], pad_override: "M", dest, dest_manual: true });
  assert.deepEqual(m["cgbuy.settings"], { hold: 128, range: 30, jump_empty: 0, pad: "M", odyssey: true });
  assert.equal(m["cgbuy.eddn"], true);
  assert.equal(m["cgbuy.dest"].station, "Abraham Lincoln");
  assert.deepEqual(mapLegacy({ dest, params: {} }), {});
  assert.deepEqual(mapLegacy(null), {});
});

test("loadStore prefers store over legacy, migrates legacy, saves debounced", async () => {
  const calls = [];
  const mk = (cfg) => async (n, a) => { if (n === "config_load") return cfg; calls.push([n, a]); };
  const s = await loadStore(mk({ store: { k: 1 }, legacy: { odyssey: true } }), 5);
  assert.equal(s.get("k"), 1);
  assert.equal(s.get("cgbuy.settings", "fb"), "fb");
  s.set("k", 2); s.set("j", 3);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls, [["config_save", { store: { k: 2, j: 3 } }]]);
  const m = await loadStore(mk({ store: null, legacy: { odyssey: true } }), 5);
  assert.deepEqual(m.get("cgbuy.settings"), { odyssey: true });
});

// The EDSM fallback: which body an orbital station is parked above.
import test from "node:test";
import assert from "node:assert/strict";
import { BodyLookup } from "../src/bodies.js";
import { EdsmGate } from "../src/edsm.js";

const fast = () => { let t = 0; return new EdsmGate({ now: () => t, sleep: async (ms) => { t += ms; } }); };

const doc = (...pairs) => ({
  stations: pairs.map(([name, body, type]) =>
    ({ name, type: type ?? "Orbis Starport", ...(body ? { body: { id: 1, name: body } } : {}) })),
});

function fake(answers) {
  const asked = [];
  const fetchJson = async (url) => {
    const name = decodeURIComponent(new URL(url).searchParams.get("systemName"));
    asked.push(name);
    const v = answers[name];
    if (v instanceof Error) throw v;
    return v ?? { stations: [] };
  };
  return { fetchJson, asked };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("nothing is known until somebody asks", () => {
  const { fetchJson, asked } = fake({});
  const b = new BodyLookup({ gate: fast(), fetchJson });
  assert.equal(b.known("Ega", "Metz Enterprise"), undefined);
  assert.deepEqual(asked, []);
});

test("one request answers every station in the system", async () => {
  const { fetchJson, asked } = fake({
    Ega: doc(["Metz Enterprise", "Ega 4"], ["Fast Point", "Ega 2 a"]),
  });
  const b = new BodyLookup({ gate: fast(), fetchJson });
  b.want("Ega");
  await settle();
  assert.equal(b.known("Ega", "Metz Enterprise"), "Ega 4");
  assert.equal(b.known("Ega", "Fast Point"), "Ega 2 a");
  assert.deepEqual(asked, ["Ega"]);
});

test("a station EDSM cannot place reads as empty, not unknown", async () => {
  // The difference matters: unknown means ask, empty means stop asking.
  const { fetchJson } = fake({ Ega: doc(["Metz Enterprise", null]) });
  const b = new BodyLookup({ gate: fast(), fetchJson });
  b.want("Ega");
  await settle();
  assert.equal(b.known("Ega", "Metz Enterprise"), "");
  assert.notEqual(b.known("Ega", "Metz Enterprise"), undefined);
});

test("a system is only ever asked for once", async () => {
  const { fetchJson, asked } = fake({ Ega: doc(["Metz Enterprise", "Ega 4"]) });
  const b = new BodyLookup({ gate: fast(), fetchJson });
  b.want("Ega"); b.want("Ega");
  await settle();
  b.want("Ega");
  await settle();
  assert.deepEqual(asked, ["Ega"]);
});

test("a pointer run down forty rows is not forty requests", async () => {
  // Hovering queues by system, and the queue is drained one at a time.
  const { fetchJson, asked } = fake({});
  const b = new BodyLookup({ gate: fast(), fetchJson });
  for (let i = 0; i < 40; i++) b.want(`Sys ${i % 4}`);
  await settle();
  assert.deepEqual(asked.sort(), ["Sys 0", "Sys 1", "Sys 2", "Sys 3"]);
});

test("waiting says an answer is on its way", async () => {
  const { fetchJson } = fake({ Ega: doc(["Metz Enterprise", "Ega 4"]) });
  const b = new BodyLookup({ gate: fast(), fetchJson });
  b.want("Ega");
  assert.equal(b.waiting("Ega"), true);
  await settle();
  assert.equal(b.waiting("Ega"), false);
});

test("a failed lookup is not retried", async () => {
  const { fetchJson, asked } = fake({ Ega: new Error("EDSM is down") });
  const b = new BodyLookup({ gate: fast(), fetchJson });
  b.want("Ega");
  await settle();
  assert.equal(b.known("Ega", "Metz Enterprise"), "");
  b.want("Ega");
  await settle();
  assert.deepEqual(asked, ["Ega"]);
});

test("whatever is on screen is told when an answer lands", async () => {
  const told = [];
  const { fetchJson } = fake({ Ega: doc(["Metz Enterprise", "Ega 4"]) });
  const b = new BodyLookup({ gate: fast(), fetchJson, onResolved: (s) => told.push(s) });
  b.want("Ega");
  await settle();
  assert.deepEqual(told, ["Ega"]);
});

test("an empty system name is not a request", () => {
  const { fetchJson, asked } = fake({});
  const b = new BodyLookup({ gate: fast(), fetchJson });
  b.want("");
  b.want(null);
  assert.deepEqual(asked, []);
});

// The shared EDSM gate, against a fake clock and a fake fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { EdsmGate, retryAfterMs } from "../src/edsm.js";
import { BodyLookup } from "../src/bodies.js";

function rig() {
  let t = 1e6;
  const gate = new EdsmGate({ now: () => t, sleep: async (ms) => { t += ms; } });
  const sent = [];
  let plan = [];                        // statuses to refuse with, in order
  const fetchJson = async (url) => {
    sent.push([t, url]);
    const st = plan.shift();
    if (st) throw Object.assign(new Error(`HTTP ${st.status}`), st);
    return { url };
  };
  return { gate, sent, fetchJson, refuse: (...s) => { plan = s; }, clock: () => t };
}

test("requests are spaced 800ms apart, even across separate callers", async () => {
  const r = rig();
  await r.gate.request(r.fetchJson, "a");
  await r.gate.request(r.fetchJson, "b");
  await Promise.all([r.gate.request(r.fetchJson, "c"), r.gate.request(r.fetchJson, "d")]);
  const times = r.sent.map(([t]) => t);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 800);
});

test("a 429 pauses 5s, doubling per consecutive one, then the same request is retried", async () => {
  const r = rig();
  r.refuse({ status: 429 }, { status: 429 });
  const res = await r.gate.request(r.fetchJson, "a");
  assert.equal(res.url, "a");
  assert.equal(r.sent.length, 3);
  assert.ok(r.sent[1][0] - r.sent[0][0] >= 5000);
  assert.ok(r.sent[2][0] - r.sent[1][0] >= 10000);
});

test("nothing is sent during a pause; the pause resets after a success; it caps at 5 min", async () => {
  const r = rig();
  r.refuse({ status: 429 });
  await r.gate.request(r.fetchJson, "a");
  r.refuse({ status: 429 });
  const t0 = r.clock();
  await r.gate.request(r.fetchJson, "b");
  assert.ok(r.sent.at(-1)[0] - t0 < 8000);     // 5s again, not 10s
  r.refuse(...Array(12).fill({ status: 429 }));
  await r.gate.request(r.fetchJson, "c");
  const gap = r.sent.at(-1)[0] - r.sent.at(-2)[0];
  assert.ok(gap >= 300000 && gap < 301000);
});

test("Retry-After (seconds or date) overrides the pause", async () => {
  assert.equal(retryAfterMs("12", 0), 12000);
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:00:20 GMT", 0), 20000);
  assert.equal(retryAfterMs(null, 0), null);
  const r = rig();
  r.refuse({ status: 429, retryAfter: "60" });
  await r.gate.request(r.fetchJson, "a");
  assert.ok(r.sent[1][0] - r.sent[0][0] >= 60000);
});

test("onWait counts down; coolingUntil reports the pause", async () => {
  const r = rig();
  r.refuse({ status: 429 });
  const left = [];
  let until;
  await r.gate.request(r.fetchJson, "a", { onWait: (ms) => { left.push(ms); until = r.gate.coolingUntil(); } });
  assert.ok(left.length >= 5 && left[0] > left.at(-1));
  assert.ok(until > 0);
  assert.equal(r.gate.coolingUntil(), 0);
});

test("a cancelled request is dropped, other errors pass through", async () => {
  const r = rig();
  await assert.rejects(r.gate.request(r.fetchJson, "a", { cancelled: () => true }), { cancelled: true });
  r.refuse({ status: 500 });
  await assert.rejects(r.gate.request(r.fetchJson, "b"), /HTTP 500/);
  assert.equal(r.sent.length, 1);
});

test("hover lookups jump queued search requests, not the one in flight", async () => {
  const r = rig();
  const bodies = new BodyLookup({ fetchJson: r.fetchJson, gate: r.gate });
  const order = [];
  const x = r.gate.request(r.fetchJson, "blocker");
  const b = r.gate.request(r.fetchJson, "search").then(() => order.push("search"));
  const a = r.gate.request(r.fetchJson, "hover", { hover: true }).then(() => order.push("hover"));
  bodies.want("Ega");
  await x;
  await Promise.all([a, b]);
  assert.deepEqual(order, ["hover", "search"]);
  await new Promise((s) => setTimeout(s, 0));
  assert.ok(r.sent.some(([, u]) => u.includes("systemName=Ega")));
  assert.equal(bodies.known("Ega", "x"), "");
});

test("a hover lookup dropped before it is sent is skipped and can be asked again", async () => {
  const r = rig();
  const bodies = new BodyLookup({ fetchJson: r.fetchJson, gate: r.gate });
  const x = r.gate.request(r.fetchJson, "blocker");
  bodies.want("Ega");
  bodies.unwant("Ega");
  await x;
  await new Promise((s) => setTimeout(s, 20));
  assert.ok(!r.sent.some(([, u]) => u.includes("Ega")));
  assert.equal(bodies.known("Ega", "x"), undefined);
  assert.ok(!bodies.waiting("Ega"));
});

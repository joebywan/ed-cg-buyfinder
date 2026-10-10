import test from "node:test";
import assert from "node:assert/strict";
import { checkForUpdate, isNewer, parseVersion } from "../src/update.js";

test("parseVersion is strict", () => {
  assert.deepEqual(parseVersion("v1.10"), [1, 10]);
  assert.deepEqual(parseVersion(" 2.2.1 "), [2, 2, 1]);
  for (const bad of ["", "1a", "-1", "1.", "1.2.3.4.5", "latest", null, 1.5]) assert.equal(parseVersion(bad), null);
});

test("isNewer compares numbers, not strings", () => {
  assert.equal(isNewer("v1.10", "1.9"), true);      // the string-compare trap
  assert.equal(isNewer("1.9", "1.10"), false);
  assert.equal(isNewer("1.5.1", "1.5"), true);
  assert.equal(isNewer("1.5", "1.5.0"), false);     // ties
  assert.equal(isNewer("1.9", "1.9"), false);
  assert.equal(isNewer("nightly", "1.9"), false);   // never nag on what we do not understand
});

test("checkForUpdate returns the bare version, or null on any failure", async () => {
  assert.equal(await checkForUpdate("1.9", async () => ({ tag_name: "v1.10" })), "1.10");
  assert.equal(await checkForUpdate("1.9", async () => ({ tag_name: "v1.9" })), null);
  assert.equal(await checkForUpdate("1.9", async () => ({ tag_name: "snapshot" })), null);
  assert.equal(await checkForUpdate("1.9", async () => ({})), null);
  assert.equal(await checkForUpdate("1.9", async () => { throw new Error("offline"); }), null);
});

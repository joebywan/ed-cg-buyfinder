import test from "node:test";
import assert from "node:assert/strict";
import { drift } from "../stamp-version.mjs";

// Fails when someone edits one version by hand; fix with `node stamp-version.mjs`.
test("app version matches VERSION everywhere", () => {
  assert.deepEqual(drift(), []);
});

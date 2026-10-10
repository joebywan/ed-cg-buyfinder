import test from "node:test";
import assert from "node:assert/strict";
import { PREF_DEFAULTS, clampFont, loadPrefs } from "../src/prefs.js";
import { JournalState } from "../src/journal.js";

test("loadPrefs fills defaults and clamps junk", () => {
  assert.deepEqual(loadPrefs(null), PREF_DEFAULTS);
  const p = loadPrefs({ font_size: 99, cache_fresh_minutes: -3, verify_top: "x", verify_edsm: 0 });
  assert.equal(p.font_size, 22);
  assert.equal(p.cache_fresh_minutes, 10);
  assert.equal(p.verify_top, 18);
  assert.equal(p.verify_edsm, true);
  assert.equal(clampFont(1), 7);
});

test("RESET TIMINGS: events at or before calAfter teach nothing", () => {
  const jump = (s) => JSON.stringify({ timestamp: `2026-01-01T00:00:${s}Z`, event: "FSDJump", StarSystem: "A" });
  const run = (calAfter) => {
    const j = new JournalState();
    j.calAfter = calAfter;
    j.handle(jump("00"));
    j.handle(jump("30"));
    return j.cal.jump_secs.length;
  };
  assert.equal(run(0), 1);
  assert.equal(run(Date.UTC(2026, 0, 1, 0, 0, 30) / 1000), 0);
  assert.equal(run(Date.UTC(2026, 0, 1, 0, 0, 10) / 1000), 1);
});

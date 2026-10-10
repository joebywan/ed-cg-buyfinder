// Settings-tab preferences that are not search parameters. Defaults and
// ranges come from the old app (FONT_*, CACHE_FRESH_MINUTES, VERIFY_TOP_DEFAULT).

import { DEFAULT_MIXED, cleanCols } from "./columns.js";

export const FONT_MIN = 7, FONT_MAX = 22, FONT_DEFAULT = 9;   // tk points; zoom = size / 9

export const PREF_DEFAULTS = {
  font_size: FONT_DEFAULT,
  cache_fresh_minutes: 10,   // newer than this, show the cached result; older, search again
  verify_edsm: true,
  verify_top: 18,            // stations re-checked against EDSM per search
  notifications: false,      // desktop only; the old app had it on, a new app asks first
  cols_mixed: DEFAULT_MIXED,  // BEST MIXED LOADS columns, in order
  alert_sound: true,         // chime when the top 5 or your copied target changes
  calAfter: 0,               // epoch secs, set by RESET TIMINGS
};

export const clampFont = (n) => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));

/** Saved prefs over the defaults, each value coerced back into range. */
export function loadPrefs(saved) {
  const p = { ...PREF_DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
  p.font_size = clampFont(Number(p.font_size) || FONT_DEFAULT);
  for (const k of ["cache_fresh_minutes", "verify_top", "calAfter"]) {
    const n = Math.round(Number(p[k]));
    p[k] = Number.isFinite(n) && n >= 0 ? n : PREF_DEFAULTS[k];
  }
  p.verify_edsm = p.verify_edsm !== false;
  p.notifications = p.notifications === true;
  p.alert_sound = p.alert_sound !== false;
  p.cols_mixed = cleanCols(p.cols_mixed);
  return p;
}

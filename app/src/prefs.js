// Settings-tab preferences that are not search parameters. Defaults and
// ranges come from the old app (FONT_*, CACHE_FRESH_MINUTES, VERIFY_TOP_DEFAULT).

import { DEFAULT_MIXED, DEFAULT_SINGLE, cleanCols, cleanWidths } from "./columns.js";

export const FONT_MIN = 7, FONT_MAX = 22, FONT_DEFAULT = 9;   // tk points; zoom = size / 9

export const PREF_DEFAULTS = {
  font_size: FONT_DEFAULT,
  cache_fresh_minutes: 10,   // newer than this, show the cached result; older, search again
  verify_edsm: true,
  verify_top: 18,            // stations re-checked against EDSM per search
  notifications: false,      // desktop only; the old app had it on, a new app asks first
  cols_mixed: DEFAULT_MIXED,  // BEST MIXED LOADS columns, in order
  cols_single: DEFAULT_SINGLE, // ALL SOURCES columns, in order
  colw_mixed: {},            // dragged widths in px by column id; absent = default
  colw_single: {},
  controls_open: false,      // the search controls are unfolded (otherwise one summary line once results show)
  update_check: true,        // desktop only: say so in the header when a newer release exists
  alert_sound: true,         // chime when your copied target moves or drops, or EDSM stalls
  surface_penalty: 0,        // minutes added to a planetary station's round trip before cr/min
  widen: true,               // search further out until 5 stations are in range
  widen_max: 500,            // ly: the furthest widening goes
  hidden_stations: [],       // stationKeys the user hid from the tables
  calAfter: 0,               // epoch secs, set by RESET TIMINGS
};

export const clampFont = (n) => Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));

/** Saved prefs over the defaults, each value coerced back into range. */
export function loadPrefs(saved) {
  const p = { ...PREF_DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) };
  p.font_size = clampFont(Number(p.font_size) || FONT_DEFAULT);
  for (const k of ["cache_fresh_minutes", "verify_top", "surface_penalty", "calAfter", "widen_max"]) {
    const n = Math.round(Number(p[k]));
    p[k] = Number.isFinite(n) && n >= 0 ? n : PREF_DEFAULTS[k];
  }
  p.verify_edsm = p.verify_edsm !== false;
  p.notifications = p.notifications === true;
  p.controls_open = p.controls_open === true;
  p.widen = p.widen !== false;
  if (p.widen_max < 10) p.widen_max = PREF_DEFAULTS.widen_max;
  p.alert_sound = p.alert_sound !== false;
  p.update_check = p.update_check !== false;
  p.hidden_stations = Array.isArray(p.hidden_stations) ? [...new Set(p.hidden_stations.filter((k) => typeof k === "string"))] : [];
  for (const v of ["mixed", "single"]) {
    p[`cols_${v}`] = cleanCols(p[`cols_${v}`], v);
    p[`colw_${v}`] = cleanWidths(p[`colw_${v}`], v);
  }
  return p;
}

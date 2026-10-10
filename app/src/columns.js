// Column registry for BEST MIXED LOADS. Each column says how it renders on a
// station row (st) and on a commodity sub-row (ch); null means blank. Values
// are raw - the page formats numbers (except `raw` columns). `key` is the field
// the header sorts by (station rows only; sub-rows are not sorted). `w` is the
// default width in em, `max` (em) caps the auto-fit of a long text column.
export const MIXED_COLS = [
  { id: "system", label: "SYSTEM", title: "Star system the station is in.", key: "system",
    st: (p) => p.system, w: 14, max: 22 },
  { id: "ly", label: "DIST\n(LY)", num: true, key: "ly", raw: true, title: "Distance in light years from the goal system.",
    st: (p) => p.ly },
  { id: "station", label: "STATION", key: "station", title: "Station name; expand it to see what to buy there.",
    st: (p) => p.station, ch: (m) => m.commodity, w: 18, max: 30 },
  { id: "ls", label: "ARRIVAL\n(LS)", num: true, key: "ls", title: "Supercruise distance from the arrival star to the station, in light seconds.",
    st: (p) => p.ls },
  { id: "updated", label: "DATA\nAGE", num: true, key: "updated", title: "How old the market report is; green is fresh, red is stale.",
    st: (p) => p.updated },
  { id: "cr_per_min", label: "CR/MIN", num: true, key: "cr_per_min", title: "Profit per minute of round trip for the whole mixed load; the ranking figure.",
    st: (p) => p.cr_per_min },
  { id: "total", label: "LOAD\nVALUE", num: true, key: "total", title: "Total profit (cr) from selling the whole load. Sub-rows show each commodity's share.",
    st: (p) => p.total, ch: (m) => m.value },
  { id: "tonnes", label: "BUY\nAMOUNT (t)", num: true, key: "tonnes", w: 9, title: "Tonnes to buy to fill your hold: the station total, and per commodity on sub-rows.",
    st: (p) => p.tonnes, ch: (m) => m.tonnes },
  { id: "buy", label: "BUY\nPRICE", num: true, sortable: false, title: "Price per tonne you pay at this station.",
    ch: (m) => m.buy },
  { id: "profit_per_t", label: "PROFIT\nPER t", num: true, sortable: false, title: "Profit per tonne of this commodity at the goal.",
    ch: (m) => m.profit_per_t },
  { id: "supply", label: "SUPPLY\n(t)", num: true, key: "supply", title: "Stock for sale: per commodity on sub-rows; on the station row, the total stock of the commodities in the load.",
    st: (p) => p.supply, ch: (m) => m.supply },
  { id: "trip_minutes", label: "TRIP\n(MIN)", num: true, key: "trip_minutes", raw: true, title: "Estimated round-trip minutes, goal to station and back.",
    st: (p) => p.trip_minutes },
  { id: "body", label: "BODY", key: "body", title: "Planet or star the station orbits or sits on, when known.",
    st: (p) => p.body, w: 14, max: 22 },
  { id: "pad", label: "PAD", key: "pad", title: "Largest landing pad the station has (L, M or S); blank when the source did not say.",
    st: (p) => p.pad, w: 6 },
];

// ALL SOURCES: one row per station+commodity, so a column has one renderer.
export const SINGLE_COLS = [
  { id: "commodity", label: "COMMODITY", key: "commodity", title: "What to buy.", st: (x) => x.commodity, w: 14, max: 22 },
  { id: "system", label: "SYSTEM", key: "system", title: "Star system the station is in.", st: (x) => x.system, w: 14, max: 22 },
  { id: "station", label: "STATION", key: "station", title: "Station name.", st: (x) => x.station, w: 18, max: 30 },
  { id: "ly", label: "DIST\n(LY)", num: true, raw: true, key: "ly", title: "Distance in light years from the goal system.", st: (x) => x.ly },
  { id: "ls", label: "ARRIVAL\n(LS)", num: true, key: "ls", title: "Supercruise distance from the arrival star to the station, in light seconds.", st: (x) => x.ls },
  { id: "supply", label: "SUPPLY\n(t)", num: true, key: "supply", title: "Stock for sale, in tonnes.", st: (x) => x.supply },
  { id: "loads_available", label: "LOADS", num: true, raw: true, key: "loads_available", title: "How many full holds the stock would fill.", st: (x) => x.loads_available },
  { id: "buy", label: "BUY\nPRICE", num: true, key: "buy", title: "Price per tonne you pay at this station.", st: (x) => x.buy },
  { id: "profit_per_t", label: "PROFIT\nPER t", num: true, key: "profit_per_t", title: "Profit per tonne at the goal.", st: (x) => x.profit_per_t },
  { id: "trip_minutes", label: "TRIP\n(MIN)", num: true, raw: true, key: "trip_minutes", title: "Estimated round-trip minutes, goal to station and back.", st: (x) => x.trip_minutes },
  { id: "cr_per_min", label: "CR/MIN", num: true, key: "cr_per_min", title: "Profit per minute of round trip for one full hold.", st: (x) => x.cr_per_min },
  { id: "t_per_min", label: "T/MIN", num: true, raw: true, key: "t_per_min", title: "Tonnes moved per minute of round trip.", st: (x) => x.t_per_min },
  { id: "updated", label: "DATA\nAGE", num: true, key: "updated", title: "How old the market report is; green is fresh, red is stale.", st: (x) => x.updated, w: 8 },
  { id: "src", label: "SRC", key: "src", sortable: false, desktop: true, title: "Which service the row came from: Ardent or Spansh.", st: (x) => x.src, w: 5 },
  { id: "body", label: "BODY", key: "body", title: "Planet or star the station orbits or sits on, when known.", st: (x) => x.body, w: 14, max: 22 },
  { id: "pad", label: "PAD", key: "pad", title: "Largest landing pad the station has (L, M or S); blank when the source did not say.", st: (x) => x.pad, w: 6 },
];

export const DEFAULT_SINGLE = SINGLE_COLS.map((c) => c.id).filter((id) => id !== "body" && id !== "pad");

export const DEFAULT_MIXED = ["system", "ly", "station", "ls", "updated", "cr_per_min", "total", "tonnes", "buy", "profit_per_t"];

/** The two column sets: ids, defaults and the registry behind each tab. */
export const VIEWS = {
  mixed: { cols: MIXED_COLS, def: DEFAULT_MIXED },
  single: { cols: SINGLE_COLS, def: DEFAULT_SINGLE },
};
export const MIN_W = 30, MAX_W = 1200;   // px; a column can be narrow but never vanish

const ids = (view) => new Set(VIEWS[view].cols.map((c) => c.id));

/** Saved list -> known, unique ids in order; anything unusable gives the default. */
export function cleanCols(saved, view = "mixed") {
  const known = ids(view);
  const out = Array.isArray(saved) ? [...new Set(saved.filter((id) => known.has(id)))] : [];
  return out.length ? out : [...VIEWS[view].def];
}

/** Saved {id: px} -> only known ids with a sane width. */
export function cleanWidths(saved, view = "mixed") {
  const known = ids(view), out = {};
  for (const [id, w] of Object.entries(saved && typeof saved === "object" ? saved : {})) {
    if (known.has(id) && Number.isFinite(w)) out[id] = Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));
  }
  return out;
}

/** Pixel width of each id in `list`: the saved one, else the registry default (em). */
export function colWidths(list, saved, view, emPx) {
  return list.map((id) => saved[id] ?? Math.round((VIEWS[view].cols.find((c) => c.id === id).w ?? 7) * emPx));
}

/** Width of an unsaved column: fit its measured content (`need` px; 0 = could not
 *  measure, so the em default), but a long text column stops at its `max` em. */
export function fitWidth(need, col, emPx) {
  if (!(need > 0)) return Math.round((col.w ?? 7) * emPx);
  const cap = col.max ? col.max * emPx : MAX_W;
  return Math.min(MAX_W, Math.max(MIN_W, Math.min(Math.ceil(need), Math.round(cap))));
}

/** Show or hide `id`. STATION stays: it holds the expand arrow. */
export function toggleCol(list, id, view = "mixed") {
  if (!ids(view).has(id)) return list;
  if (!list.includes(id)) return [...list, id];
  return id === "station" ? list : list.filter((x) => x !== id);
}

/** Move `id` by `d` places (-1 up/left, +1 down/right), clamped at the ends. */
export function moveCol(list, id, d) {
  const i = list.indexOf(id), j = i + d;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Drop `id` just before (or, with `after`, just after) `target`. */
export function placeCol(list, id, target, after = false) {
  if (id === target || !list.includes(id) || !list.includes(target)) return list;
  const out = list.filter((x) => x !== id);
  out.splice(out.indexOf(target) + (after ? 1 : 0), 0, id);
  return out;
}

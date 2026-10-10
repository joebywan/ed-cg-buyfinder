// Column registry for BEST MIXED LOADS. Each column says how it renders on a
// station row (st) and on a commodity sub-row (ch); null means blank. Values
// are raw - the page formats numbers. `key` is the field the header sorts by
// (station rows only; sub-rows are not sorted).
export const MIXED_COLS = [
  { id: "system", label: "SYSTEM", title: "Star system the station is in.", key: "system",
    st: (p) => p.system },
  { id: "ly", label: "DIST\n(LY)", num: true, key: "ly", title: "Distance in light years from the goal system.",
    st: (p) => p.ly },
  { id: "station", label: "STATION", key: "station", title: "Station name; expand it to see what to buy there.",
    st: (p) => p.station, ch: (m) => m.commodity },
  { id: "ls", label: "ARRIVAL\n(LS)", num: true, key: "ls", title: "Supercruise distance from the arrival star to the station, in light seconds.",
    st: (p) => p.ls },
  { id: "updated", label: "DATA\nAGE", num: true, key: "updated", title: "How old the market report is; green is fresh, red is stale.",
    st: (p) => p.updated },
  { id: "cr_per_min", label: "CR/MIN", num: true, key: "cr_per_min", title: "Profit per minute of round trip for the whole mixed load; the ranking figure.",
    st: (p) => p.cr_per_min },
  { id: "total", label: "LOAD\nVALUE", num: true, key: "total", title: "Total profit (cr) from selling the whole load. Sub-rows show each commodity's share.",
    st: (p) => p.total, ch: (m) => m.value },
  { id: "tonnes", label: "BUY\nAMOUNT (t)", num: true, key: "tonnes", title: "Tonnes to buy to fill your hold: the station total, and per commodity on sub-rows.",
    st: (p) => p.tonnes, ch: (m) => m.tonnes },
  { id: "buy", label: "BUY\nPRICE", num: true, sortable: false, title: "Price per tonne you pay at this station.",
    ch: (m) => m.buy },
  { id: "profit_per_t", label: "PROFIT\nPER t", num: true, sortable: false, title: "Profit per tonne of this commodity at the goal.",
    ch: (m) => m.profit_per_t },
  { id: "supply", label: "SUPPLY\n(t)", num: true, key: "supply", title: "Stock for sale: per commodity on sub-rows; on the station row, the total stock of the commodities in the load.",
    st: (p) => p.supply, ch: (m) => m.supply },
  { id: "trip_minutes", label: "TRIP\n(MIN)", num: true, key: "trip_minutes", title: "Estimated round-trip minutes, goal to station and back.",
    st: (p) => p.trip_minutes },
  { id: "body", label: "BODY", key: "body", title: "Planet or star the station orbits or sits on, when known.",
    st: (p) => p.body },
];

export const DEFAULT_MIXED = ["system", "ly", "station", "ls", "updated", "cr_per_min", "total", "tonnes", "buy", "profit_per_t"];

const IDS = new Set(MIXED_COLS.map((c) => c.id));

/** Saved list -> known, unique ids in order; anything unusable gives the default. */
export function cleanCols(saved) {
  const out = Array.isArray(saved) ? [...new Set(saved.filter((id) => IDS.has(id)))] : [];
  return out.length ? out : [...DEFAULT_MIXED];
}

/** Show or hide `id`. STATION stays: it holds the expand arrow. */
export function toggleCol(list, id) {
  if (!IDS.has(id)) return list;
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

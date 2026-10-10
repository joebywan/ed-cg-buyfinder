// Market discovery through Ardent Insight, which follows EDDN live and,
// unlike Spansh, lets a web page read its answers.
import { MAX_AGE_DEFAULT, daysOld, isPlanetary, padLetter, tripMinutes } from "./model.js";
import { symbolFor } from "./commodities.js";
import { log, loggedFetch } from "./log.js";

export const ARDENT = "https://api.ardent-insight.com/v2";
const MIN_DAYS_QUERIED = 30;   // fetch past the age cutoff so the filter can stand down
const PARALLEL = 4;

const round1 = (x) => Math.round(x * 10) / 10;

async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Score Ardent export records for one commodity into cgbuy-shaped rows. */
function sourceRows(records, { commodity, sell, cgLs, origin, p, cal }) {
  const out = [];
  const seen = new Set();
  for (const e of records) {
    const carrier = e.stationType === "FleetCarrier";
    // Carriers, surface stations and pad sizes are all kept: the page filters them.
    const planetary = isPlanetary(e.stationType);
    const stock = e.stock || 0;
    const buy = e.buyPrice || 0;
    if (stock <= 0 || buy <= 0 || stock < p.min_supply) continue;
    // Ardent's own distance is whole light years; the coordinates are exact.
    const dist = [e.systemX, e.systemY, e.systemZ].every(Number.isFinite)
      ? Math.hypot(e.systemX - origin[0], e.systemY - origin[1], e.systemZ - origin[2])
      : (e.distance ?? Infinity);
    if (dist > p.range) continue;
    const profit = sell - buy;
    if (profit <= 0) continue;
    const key = `${e.marketId ?? `${e.systemName}/${e.stationName}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ls = e.distanceToArrival || 0;
    const mins = tripMinutes(dist, ls, cgLs, p.jump_empty, p.jump_laden, cal);
    const load = Math.min(stock, p.hold);
    out.push({
      commodity, station: e.stationName ?? "?", system: e.systemName ?? "?", carrier,
      // Ardent carries the body for orbital stations as well as surface
      // ones, which is the whole answer - the desktop app has to ask a
      // second service for half of it.
      planetary, stype: e.stationType ?? "", body: e.bodyName ?? "", pad: padLetter(e.maxLandingPadSize),
      ly: round1(dist), ls: Math.round(ls), supply: stock, buy, sell, profit_per_t: profit,
      load, loads_available: round1(stock / p.hold), trip_minutes: round1(mins),
      trip_profit: load * profit, cr_per_min: Math.round(load * profit / mins),
      t_per_min: round1(load / mins), updated: String(e.updatedAt || "").slice(0, 10),
    });
  }
  return out;
}

/** Drop rows older than maxAge days; if that would drop all of them, don't. */
export function ageFilter(rows, maxAge, now = new Date()) {
  if (!maxAge) return { rows, hidden: 0, allStale: false };
  const fresh = rows.filter((r) => {
    const n = daysOld(r.updated, now);
    return n !== null && n <= maxAge;
  });
  if (fresh.length) return { rows: fresh, hidden: rows.length - fresh.length, allStale: false };
  return { rows, hidden: 0, allStale: rows.length > 0 };
}

export async function defaultFetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

/**
 * Everything the tables need for one search. `p` carries dest, range,
 * min_supply, hold, pad, carriers, jump_empty, jump_laden, max_age_days.
 */
export async function buildRows(p, { fetchJson = defaultFetchJson, cal = null,
                                      now = new Date(), onProgress = null } = {}) {
  fetchJson = loggedFetch(fetchJson);
  const dest = p.dest;
  const empty = { rows: [], cg: {}, cgLs: 0, hiddenStale: 0, allStale: false, errors: [] };
  if (!dest?.system || !dest?.station || !dest?.commodities?.length) return empty;

  const total = dest.commodities.length + 1;     // the station lookup, then each commodity
  const emit = (stage, done, detail) => onProgress?.({ provider: "ardent", stage, done, total, detail });
  emit("destination", 0, `finding ${dest.station}`);
  const sys = encodeURIComponent(dest.system);
  const stations = await fetchJson(`${ARDENT}/system/name/${sys}/stations`);
  const st = (Array.isArray(stations) ? stations : []).find((s) => s.stationName === dest.station);
  if (!st) throw new Error(`Ardent has no station "${dest.station}" in ${dest.system}`);
  const cgLs = st.distanceToArrival || 0;
  const origin = [st.systemX, st.systemY, st.systemZ];

  emit("commodities", 1, "looking up markets");
  const maxAge = p.max_age_days ?? MAX_AGE_DEFAULT;
  const days = Math.max(MIN_DAYS_QUERIED, maxAge);
  const cg = {};
  const errors = [];
  let rows = [];
  let done = 0;

  await mapLimit(dest.commodities, PARALLEL, async (name) => {
    const path = `${ARDENT}/system/name/${sys}/commodity/name/${encodeURIComponent(symbolFor(name))}`;
    const q = new URLSearchParams({ maxDistance: String(Math.ceil(p.range)),
      minVolume: String(Math.max(1, p.min_supply)), maxDaysAgo: String(days) });
    try {
      // "nearby" leaves out the reference system itself, so ask for it separately.
      const [inSystem, nearby] = await Promise.all([
        fetchJson(`${path}?maxDaysAgo=${days}`),
        fetchJson(`${path}/nearby/exports?${q}`),
      ]);
      const here = (inSystem || []).find((o) => o.stationName === dest.station && o.sellPrice > 0);
      if (!here) return;                        // the destination doesn't buy it
      cg[name] = { sell: here.sellPrice, demand: here.demand };
      rows.push(...sourceRows([...(nearby || []), ...(inSystem || [])],
        { commodity: name, sell: here.sellPrice, cgLs, origin, p, cal }));
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    } finally {
      emit("commodities", ++done + 1,
        `${name} (${done}/${dest.commodities.length} commodities)`);
    }
  });

  for (const e of errors) log("ardent", e);
  if (!Object.keys(cg).length) {
    throw new Error(errors.length ? errors.join("; ")
      : `Ardent has no prices at ${dest.station} for ${dest.commodities.join(", ")}`);
  }
  rows.sort((a, b) => b.cr_per_min - a.cr_per_min);
  const aged = ageFilter(rows, maxAge, now);
  rows = aged.rows;
  emit("done", total, `${rows.length} sources`);
  return { rows, cg, cgLs, hiddenStale: aged.hidden, allStale: aged.allStale, errors };
}

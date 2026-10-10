// Scoring: trip time, mixed loads, pads and ages. A port of the pure parts
// of cgbuy - see that file for the reasoning behind each constant.
import { estScMinutes } from "./journal.js";

export const EST_JUMP_MIN = 0.85;     // align + charge + jump + scoop
export const EST_DOCK_MIN = 2.0;      // fixed: Docked -> Undocked can't tell trading from tea
export const EST_DEPART_MIN = 1.8;    // undocked -> first jump, until measured
export const EST_SC_SCALE = 1.0;

export const MAX_AGE_DEFAULT = 7;
export const AGE_FRESH_DAYS = 2;
export const AGE_STALE_DAYS = 7;

export const SHIP_PADS = {
  // small
  sidewinder: "S", eagle: "S", hauler: "S", adder: "S", empire_eagle: "S", viper: "S",
  cobramkiii: "S", viper_mkiv: "S", diamondback: "S", cobramkiv: "S", diamondbackxl: "S",
  empire_courier: "S", vulture: "S",
  // medium
  asp_scout: "M", independant_trader: "M", asp: "M", type6: "M", dolphin: "M",
  federation_dropship: "M", federation_dropship_mkii: "M", federation_gunship: "M",
  krait_mkii: "M", krait_light: "M", mamba: "M", python: "M", ferdelance: "M", typex: "M",
  typex_2: "M", typex_3: "M", mandalay: "M", python_nx: "M",
  // large
  type7: "L", empire_trader: "L", orca: "L", federation_corvette: "L", cutter: "L",
  type9: "L", type9_military: "L", belugaliner: "L", anaconda: "L", panthermkii: "L",
  lakonminer: "L", explorer_nx: "L",
};
export const PAD_ORDER = { S: 0, M: 1, L: 2 };
const PAD_SIZE = { S: 1, M: 2, L: 3 };     // Ardent's maxLandingPadSize

// Ardent reports FDev's own station types. These are the ones you land ON
// rather than dock AT, which is a different trip: a glide down, a pad on a
// rock, and a client that owns the expansion.
export const PLANETARY_TYPES = new Set([
  "CraterOutpost", "CraterPort", "OnFootSettlement", "SurfaceStation",
]);

// FDev's symbols read like internals. These are what the game calls them.
const TYPE_LABELS = {
  Coriolis: "Coriolis Starport", Orbis: "Orbis Starport",
  Ocellus: "Ocellus Starport", Dodec: "Ocellus Starport",
  Outpost: "Outpost", AsteroidBase: "Asteroid Base", MegaShip: "Mega Ship",
  FleetCarrier: "Fleet Carrier", CraterOutpost: "Planetary Outpost",
  CraterPort: "Planetary Port", OnFootSettlement: "Odyssey Settlement",
  SurfaceStation: "Surface Station",
};

/** Is this a station on a surface?

 An unrecognised type is treated as orbital on purpose. Getting it wrong
 that way leaves a station visible that perhaps should not be; the other way
 hides one the commander could have flown to, and they would never know. */
export function isPlanetary(stationType) {
  return PLANETARY_TYPES.has(stationType);
}

/** What the game calls this station type, or the raw symbol if it is new. */
export function stationTypeLabel(stationType) {
  return TYPE_LABELS[stationType] || stationType || "Station";
}

/** One line saying where a station actually is.

 LS cannot answer this. 500 Ls says how long the approach is, not whether it
 ends at a starport you dock at or a pad you have to glide down to - and if
 it is a surface, which rock you set course for.

 `body` overrides the row's own, for the orbital stations Ardent does not
 record one for and EDSM does; `waiting` is while that answer is in flight. */
export function whereItIs(x, { body = null, waiting = false } = {}) {
  if (!x) return "";
  const kind = stationTypeLabel(x.stype);
  if (x.carrier) return `${kind} — orbits nothing; it sits where its owner parked it, and can leave`;
  const named = x.body || body || "";
  if (named) return x.planetary ? `${kind} — on ${named}` : `${kind} — orbiting ${named}`;
  if (waiting) return `${kind} — orbiting … (asking EDSM)`;
  return `${kind} — no body on record`;
}

/** Smallest pad this ship needs. Unknown -> L: over-restrictive is safe. */
export function padForShip(ship) {
  return SHIP_PADS[(ship || "").toLowerCase()] || "L";
}

/** Can a ship needing `pad` land where the largest pad is `maxPadSize`? */
export function padFits(maxPadSize, pad) {
  return typeof maxPadSize === "number" && maxPadSize >= PAD_SIZE[pad];
}

/** Round trip in minutes: destination -> source empty, back laden. */
export function tripMinutes(distLy, srcLs, cgLs, jumpEmpty, jumpLaden, cal = null) {
  const jumpMin = cal?.jumpMinutes || EST_JUMP_MIN;
  const departMin = cal?.departMinutes || EST_DEPART_MIN;
  const scScale = cal?.scScale || EST_SC_SCALE;
  const arrival = (ls) => {
    const measured = cal ? cal.arrivalMinutes(ls) : null;
    return measured ?? estScMinutes(ls) * scScale;
  };
  const outJ = distLy > 0 ? Math.ceil(distLy / jumpEmpty) : 0;
  const backJ = distLy > 0 ? Math.ceil(distLy / jumpLaden) : 0;
  // The first jump of each leg is already inside departure and the arrival leg.
  const jumps = (Math.max(outJ - 1, 0) + Math.max(backJ - 1, 0)) * jumpMin;
  const legs = arrival(srcLs) + arrival(cgLs);
  return Math.max(jumps + legs + (EST_DOCK_MIN + departMin) * 2, 0.5);
}

/** Rank stations by the best hold they can fill, topping up greedily. */
export function buildMixed(rows, hold) {
  const stations = new Map();
  for (const r of rows) {
    const key = `${r.station}\0${r.system}`;
    if (!stations.has(key)) stations.set(key, []);
    stations.get(key).push(r);
  }
  const plans = [];
  for (const items of stations.values()) {
    items.sort((a, b) => b.profit_per_t - a.profit_per_t);
    let remaining = hold;
    let total = 0;
    const mix = [];
    for (const it of items) {
      if (remaining <= 0) break;
      const take = Math.min(it.supply, remaining);
      if (take <= 0) continue;
      mix.push({ commodity: it.commodity, tonnes: take, profit_per_t: it.profit_per_t,
                 buy: it.buy, supply: it.supply, value: take * it.profit_per_t });
      total += take * it.profit_per_t;
      remaining -= take;
    }
    if (!mix.length) continue;
    const top = items[0];
    plans.push({
      station: top.station, system: top.system, ly: top.ly, ls: top.ls, carrier: top.carrier,
      // Properties of the station, so any of its rows can supply them.
      planetary: top.planetary, stype: top.stype, body: top.body,
      updated: top.updated, tonnes: hold - remaining, short: remaining,
      src: top.src, edsm: items.some((i) => i.edsm),   // which reading it is, for the watcher's "why"
      supply: mix.reduce((n, m) => n + m.supply, 0),   // stock of the commodities in the load, summed
      trip_minutes: top.trip_minutes, total, cr_per_min: Math.round(total / top.trip_minutes), mix,
    });
  }
  plans.sort((a, b) => b.cr_per_min - a.cr_per_min);
  return plans;
}

/** Sort key for a plan or row column: names ignore case, gaps sort last. */
export function mixedSortValue(item, key) {
  const v = item?.[key];
  if (key === "station" || key === "system" || key === "commodity" || key === "body") return (v || "").toLowerCase();
  if (key === "updated") return v || "";
  return v || 0;
}

export function compareValues(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whole UTC days since an ISO date (or timestamp), or null. */
export function daysOld(dateStr, now = new Date()) {
  const m = typeof dateStr === "string" && /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  const then = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - then) / 86400000);
}

export function ageTag(dateStr, now = new Date()) {
  const n = daysOld(dateStr, now);
  if (n === null) return "age-old";
  return n <= AGE_FRESH_DAYS ? "age-ok" : n <= AGE_STALE_DAYS ? "age-mid" : "age-old";
}

export function ageText(dateStr, now = new Date()) {
  const n = daysOld(dateStr, now);
  if (n === null) return "?";
  return n < 1 ? "today" : `${n}d ago`;
}

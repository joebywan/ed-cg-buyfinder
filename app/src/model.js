// Scoring: trip time, mixed loads, pads and ages. A port of the pure parts
// of cgbuy - see that file for the reasoning behind each constant.
import { estScMinutes } from "./journal.js";
import { symbolFor } from "./commodities.js";
import { normName } from "./eddn.js";

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

/** Largest pad as "S"|"M"|"L" from Ardent's 1/2/3, or "" when unknown. */
export function padLetter(maxPadSize) {
  return ({ 1: "S", 2: "M", 3: "L" })[maxPadSize] || "";
}

/** Can a ship needing `pad` land where the largest pad is `maxPadSize`? */
export function padFits(maxPadSize, pad) {
  return typeof maxPadSize === "number" && maxPadSize >= PAD_SIZE[pad];
}

/** Where a round trip's minutes go: {jumps, depart, arrive, dock}; tripMinutes sums them. */
export function tripParts(distLy, srcLs, cgLs, jumpEmpty, jumpLaden, cal = null) {
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
  return { jumps: (Math.max(outJ - 1, 0) + Math.max(backJ - 1, 0)) * jumpMin,
    depart: departMin * 2, arrive: arrival(srcLs) + arrival(cgLs), dock: EST_DOCK_MIN * 2 };
}

/** Round trip in minutes: destination -> source empty, back laden. */
export function tripMinutes(distLy, srcLs, cgLs, jumpEmpty, jumpLaden, cal = null) {
  const t = tripParts(distLy, srcLs, cgLs, jumpEmpty, jumpLaden, cal);
  return Math.max(t.jumps + t.arrive + (t.dock + t.depart), 0.5);
}

/** The view filters and the surface penalty, applied to cached rows.

 Searches keep every station; ODYSSEY, CARRIERS and PAD only decide what is
 shown, so toggling them needs no network. A planetary row gets `penalty`
 extra minutes on its (unpenalised, stored) round trip and its rates are
 re-derived from that, so changing the penalty re-scores from the cache too.
 A blank pad (unknown) never fits, as before. */
export function viewRows(rows, { carriers = false, odyssey = false, pad = "L", penalty = 0, hide = [] } = {}) {
  return rows.flatMap((r) => {
    if (hiddenBy(r, { carriers, odyssey, pad, hide })) return [];
    if (!r.planetary || !(penalty > 0)) return [r];
    const mins = r.trip_minutes + penalty;
    return [{ ...r, trip_minutes: Math.round(mins * 10) / 10, penalty,
      cr_per_min: Math.round(r.load * r.profit_per_t / mins), t_per_min: Math.round(r.load / mins * 10) / 10 }];
  }).sort((a, b) => b.cr_per_min - a.cr_per_min);
}

/** A station's identity in the hidden list. Rows carry no market id, so system and name. */
export const stationKey = (x) => `${x.station}\0${x.system}`;

/** Which view filter hides this row: "hidden" (stations the user hid, `hide` is
 *  their stationKeys), "carriers", "odyssey" or "pad", else "". */
export function hiddenBy(r, { carriers = false, odyssey = false, pad = "L", hide = [] } = {}) {
  if (hide.includes(stationKey(r))) return "hidden";
  if (r.carrier && !carriers) return "carriers";
  if (r.planetary && !odyssey) return "odyssey";
  return PAD_ORDER[r.pad] >= PAD_ORDER[pad] ? "" : "pad";
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
    const mix = [], used = [];
    for (const it of items) {
      if (remaining <= 0) break;
      const take = Math.min(it.supply, remaining);
      if (take <= 0) continue;
      mix.push({ commodity: it.commodity, tonnes: take, profit_per_t: it.profit_per_t,
                 buy: it.buy, supply: it.supply, value: take * it.profit_per_t });
      used.push(it);
      total += take * it.profit_per_t;
      remaining -= take;
    }
    if (!mix.length) continue;
    const top = items[0];
    plans.push({
      station: top.station, system: top.system, ly: top.ly, ls: top.ls, carrier: top.carrier,
      // Properties of the station, so any of its rows can supply them.
      planetary: top.planetary, stype: top.stype, body: top.body, pad: top.pad, penalty: top.penalty || 0,
      // DATA AGE mark (`edsm` below is the watcher's "any"): confirmed only if every row in the load is.
      confirmed: used.every((r) => r.edsm), pending: used.some((r) => r.pending),
      updated: top.updated, tonnes: hold - remaining, short: remaining,
      src: top.src, own: top.own, edsm: items.some((i) => i.edsm),   // which reading it is, for the watcher's "why"
      supply: mix.reduce((n, m) => n + m.supply, 0),   // stock of the commodities in the load, summed
      trip_minutes: top.trip_minutes, total, cr_per_min: Math.round(total / top.trip_minutes), mix,
      t_per_min: Math.round((hold - remaining) / top.trip_minutes * 10) / 10,
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
  if (key === "pad") return PAD_ORDER[v] ?? -1;
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

/** Lay the commander's own station data over cached rows.
 *
 *  `own` is {market, buys}: the last Market.json the game wrote (or null) and
 *  the MarketBuy events seen since, as {system, station, symbol, count}.
 *  That station's rows take the file's stock and price, marked `own` and
 *  dated by the file; a commodity it no longer stocks drops out. Buys then
 *  come off the stock, file or no file. Only rows already in the results are
 *  touched (a new commodity has no sell price to score), and a file older
 *  than the station's newest row is ignored. */
export function applyOwn(rows, own, hold) {
  const m = own?.market;
  const buys = own?.buys ?? [];
  if (!m && !buys.length) return rows;
  const date = String(m?.timestamp ?? "").slice(0, 10);
  const goods = new Map((m?.Items ?? []).filter((i) => i.Stock > 0 && i.BuyPrice > 0)
    .map((i) => [normName(i.Name), i]));
  const mine = (r) => m && r.system === m.StarSystem && r.station === m.StationName;
  const newest = rows.filter(mine).map((r) => r.updated || "").sort().pop() || "";
  const fresh = !!date && date >= newest;
  return rows.flatMap((r) => {
    let x = r;
    if (fresh && mine(r)) {
      const it = goods.get(symbolFor(r.commodity));
      if (!it) return [];
      const { edsm, pending, other, ...rest } = r;
      x = { ...rest, supply: it.Stock, buy: it.BuyPrice, updated: date, src: "M", own: true };
    }
    const bought = buys.filter((b) => b.system === r.system && b.station === r.station
      && b.symbol === symbolFor(r.commodity)).reduce((n, b) => n + b.count, 0);
    if (!bought && x === r) return [r];
    const supply = x.supply - bought, profit = x.sell - x.buy;
    if (supply <= 0 || profit <= 0) return [];
    const load = Math.min(supply, hold);
    return [{ ...x, supply, profit_per_t: profit, load, loads_available: Math.round(supply / hold * 10) / 10,
      trip_profit: load * profit, cr_per_min: Math.round(load * profit / x.trip_minutes),
      t_per_min: Math.round(load / x.trip_minutes * 10) / 10 }];
  });
}

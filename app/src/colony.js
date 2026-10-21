// Colonisation construction sites as a destination. A depot is goal-shaped: a
// fixed station, a shopping list and a per-tonne payment. Its remaining demand
// exists only in the journal, so what we know is the last state we saw per
// depot, kept by MarketID. Pure; app.js does the storage and the DOM.
import { parseTs } from "./journal.js";
import { nameFor, symbolFor } from "./commodities.js";
import { normName } from "./eddn.js";

const SITE = /^(?:Planetary|Orbital) Construction Site: /;
const n0 = (n) => Math.round(n).toLocaleString("en-US");

/** The depot's name without the "Planetary Construction Site: " prefix. */
export const depotName = (d) => d.station.replace(SITE, "");

/** Tonnes still needed per resource, as [{name, left, payment}], nothing for finished ones. */
export function remaining(d) {
  return (d?.resources || []).map((r) => ({ name: r.name, left: r.required - r.provided, payment: r.payment }))
    .filter((r) => r.left > 0);
}

/** Is this a depot still being built, with a known shopping list? */
export const open = (d) => !!d?.resources && !d.complete && !d.failed && remaining(d).length > 0;

/**
 * Fold one journal line into `depots` ({marketId: state}), in place. Returns true when something changed.
 * Docked at a depot names it (the depot event has no station or system, only a MarketID);
 * the depot event, which the game repeats every 15 s while the screen is open, sets its state.
 */
export function takeLine(depots, line) {
  if (typeof line !== "string" || !line.includes("Construction")) return false;
  let e;
  try { e = JSON.parse(line); } catch { return false; }
  const at = parseTs(e?.timestamp);
  if (e?.event === "Docked" && /ConstructionDepot$/.test(e.StationType || "")) {
    const d = depots[e.MarketID] ??= { marketId: e.MarketID };
    Object.assign(d, { station: e.StationName, system: e.StarSystem, dockedAt: at });
    return true;
  }
  const d = e?.event === "ColonisationConstructionDepot" && depots[e.MarketID];
  if (!d) return false;
  const resources = (e.ResourcesRequired || []).map((r) => ({ name: commodityName(r),
    required: r.RequiredAmount, provided: r.ProvidedAmount, payment: r.Payment }));
  const next = { progress: e.ConstructionProgress, complete: !!e.ConstructionComplete, failed: !!e.ConstructionFailed, resources };
  if (JSON.stringify(next) === JSON.stringify({ progress: d.progress, complete: d.complete, failed: d.failed, resources: d.resources })) return false;
  Object.assign(d, next, { at });
  return true;
}

/** The English name the market sources use. Name_Localised is in the client's language
 *  ("Stahl" on a German client), so it is kept only when it is the same commodity. */
function commodityName(r) {
  const sym = normName(r.Name || "");
  return r.Name_Localised && symbolFor(r.Name_Localised) === sym ? r.Name_Localised : nameFor(sym);
}

/** An open depot as a destination: what is needed, what it pays, how much of each. */
export function depotDest(d) {
  const left = remaining(d);
  return { station: d.station, system: d.system, commodities: left.map((r) => r.name), title: "", expiry: null,
    prices: Object.fromEntries(left.map((r) => [r.name, r.payment])),
    needs: Object.fromEntries(left.map((r) => [r.name, r.left])), depot: true, source: "construction site" };
}

/** For a station the commander typed in: its prices and needs when it is a known depot, for the goods chosen. */
export function depotExtras(depots, dest) {
  const d = Object.values(depots || {}).find((x) => open(x) && x.station === dest.station && x.system === dest.system);
  if (!d) return {};
  const { prices, needs } = depotDest(d);
  const pick = (o) => Object.fromEntries(dest.commodities.filter((c) => c in o).map((c) => [c, o[c]]));
  return { prices: pick(prices), needs: pick(needs), depot: true };
}

/**
 * The automatic destination: the joined CG or the depot you docked at most recently.
 * `cgDockedAt` is when you last docked at the CG's station (epoch secs, 0 for never).
 */
export function chooseAuto(cg, depots, cgDockedAt = 0) {
  const d = Object.values(depots || {}).filter(open).sort((a, b) => (b.dockedAt || 0) - (a.dockedAt || 0))[0];
  return d && (!cg || (d.dockedAt || 0) > cgDockedAt) ? depotDest(d) : cg;
}

/** The progress line: "Bray Venture: 23.2% built · 28,296 t to go · ~26 loads of your hold · ~5 h at your pace". */
export function progressLine(d, hold = 0, mins = null) {
  const left = remaining(d).reduce((n, r) => n + r.left, 0);
  const bits = [`${depotName(d)}: ${(d.progress * 100).toFixed(1)}% built`, `${n0(left)} t to go`];
  if (hold > 0) {
    const loads = Math.ceil(left / hold);
    bits.push(`~${n0(loads)} load${loads === 1 ? "" : "s"} of your hold`);
    if (mins) {
      const m = loads * mins;
      bits.push(`~${m < 90 ? `${Math.round(m)} min` : `${Math.round(m / 6) / 10} h`} at your pace`);
    }
  }
  return bits.join(" · ");
}

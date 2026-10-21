// What the DESTINATION panel offers to fill in: names to complete, stations to
// pick, goods to tick. Pure; app.js does the fetching and the DOM.
import { ARDENT } from "./ardent.js";
import { commodityNames, nameFor } from "./commodities.js";

/** A CG sells at a fixed multiple of the galactic mean price, far above any ordinary spread. */
export const PREMIUM_RATIO = 2.5;

export const systemSearchUrl = (q) => `${ARDENT}/search/system/name/${encodeURIComponent(q)}`;
export const stationsUrl = (system) => `${ARDENT}/system/name/${encodeURIComponent(system)}/stations`;
export const marketUrl = (marketId) => `${ARDENT}/market/${marketId}/commodities`;

/** Ardent's system search answer as sorted names. */
export function systemNames(json) {
  return (Array.isArray(json) ? json : []).map((s) => s.systemName).filter(Boolean).sort();
}

const TYPES = { Coriolis: "Coriolis", Orbis: "Orbis", Ocellus: "Ocellus", Outpost: "Outpost", Dodec: "Dodec",
  Bernal: "Ocellus", AsteroidBase: "Asteroid base", CraterPort: "Planetary port", CraterOutpost: "Planetary outpost",
  OnFootSettlement: "Settlement", FleetCarrier: "Fleet carrier", MegaShip: "Megaship",
  PlanetaryConstructionDepot: "Construction site", SpaceConstructionDepot: "Construction site" };

/** Stations with a market, nearest arrival first: [{name, marketId, label}]. */
export function stationList(json) {
  return (Array.isArray(json) ? json : []).filter((s) => s.marketId != null && s.stationName)
    .sort((a, b) => (a.distanceToArrival ?? Infinity) - (b.distanceToArrival ?? Infinity))
    .map((s) => ({ name: s.stationName, marketId: s.marketId,
      label: `${TYPES[s.stationType] || s.stationType || "?"} · ${Math.round(s.distanceToArrival ?? 0).toLocaleString("en-US")} Ls` }));
}

/** The text up to and including the last comma (as `head`, ready to prefix) and the token being typed. */
export function splitToken(text) {
  const i = text.lastIndexOf(",");
  return { head: i < 0 ? "" : text.slice(0, i + 1) + " ", token: text.slice(i + 1).trim() };
}

/** Datalist values for the commodity field: the whole text with the last token completed.
 *  Names already in the list are left out. */
export function completions(text, names = commodityNames(), limit = 12) {
  const { head, token } = splitToken(text);
  if (!token) return [];
  const have = new Set(head.split(",").map((t) => t.trim().toLowerCase()));
  const t = token.toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(t));
  const inside = names.filter((n) => !n.toLowerCase().startsWith(t) && n.toLowerCase().includes(t));
  return [...starts, ...inside].filter((n) => !have.has(n.toLowerCase())).slice(0, limit).map((n) => head + n);
}

/** What a market pays a premium for: Market.json Items sold at 2.5x mean price or more. [] when nothing does. */
export function premiumGoods(items) {
  return (items || []).filter((it) => it.MeanPrice && it.SellPrice && it.SellPrice / it.MeanPrice >= PREMIUM_RATIO)
    .map((it) => it.Name_Localised || it.Name || "").filter(Boolean).sort();
}

/** Where the commander is docked, as a destination: the market's premium goods, or none to fill in. */
export function dockedDestination(journal, market) {
  if (!journal?.docked || !journal.station) return null;
  const mine = market && market.StationName === journal.station && market.StarSystem === journal.system;
  return { system: journal.system, station: journal.station, commodities: mine ? premiumGoods(market.Items) : [] };
}

/** The goods a destination's Ardent market buys, by display name. */
export function marketGoods(json) {
  return (Array.isArray(json) ? json : []).filter((c) => c.demand > 0).map((c) => nameFor(c.commodityName)).sort();
}

/** The comma list as tokens, and back with names added. */
export const tokens = (text) => text.split(",").map((t) => t.trim()).filter(Boolean);
export function withAdded(text, names) {
  const have = tokens(text);
  const seen = new Set(have.map((t) => t.toLowerCase()));
  return [...have, ...names.filter((n) => !seen.has(n.toLowerCase()))].join(", ");
}

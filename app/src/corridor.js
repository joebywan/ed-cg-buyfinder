// "On the way in": stations a commander far from the goal can load at on the
// route, so the first hold is bought before the trip rather than after it.
import { buildMixed } from "./model.js";

export const PANEL_TOP = 5;
export const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Only when you are outside the search radius; inside it the main table is the answer. */
export const wantsPanel = (you, dest, range) => !!you && !!dest && dist3(you, dest) > range;

/** Longest detour worth taking: 15% of the trip, but never under two laden jumps. */
export const allowance = (direct, jumpLaden) => Math.max(0.15 * direct, 2 * (jumpLaden || 0));

/**
 * Best full holds within the detour allowance, by value of the hold.
 * `rows` carry `pos` (Ardent's); returns plans with `detour` in ly.
 */
export function onTheWay(rows, { you, dest, hold, jumpLaden }, top = PANEL_TOP) {
  const direct = dist3(you, dest), max = allowance(direct, jumpLaden);
  const detour = new Map();
  const near = rows.filter((r) => {
    if (!r.pos) return false;
    const d = dist3(you, r.pos) + dist3(r.pos, dest) - direct;
    detour.set(`${r.station}\0${r.system}`, d);
    return d <= max;
  });
  return buildMixed(near, hold)
    .map((x) => ({ ...x, detour: detour.get(`${x.station}\0${x.system}`) }))
    .sort((a, b) => b.total - a.total).slice(0, top);
}

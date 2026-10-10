// Auto-widen: when fewer than WANT stations are in range, search again further
// out (x1.5, whole 10 ly) until there are enough, the cap is reached, or two
// steps in a row add nothing. Each step re-queries the larger radius and
// replaces the rows - the bigger query is a superset, so nothing needs merging.
import { log } from "./log.js";

export const WANT = 5;
export const MAX_RADIUS_DEFAULT = 500;
export const nextRange = (r, cap) => Math.min(cap, Math.max(r + 10, Math.round(r * 1.5 / 10) * 10));

/** Hops from `from` up to `cap`: the radius bar's length. */
export function stepsTo(from, cap) {
  let n = 0;
  for (let r = from; r < cap; r = nextRange(r, cap)) n++;
  return n;
}

const stations = (n) => `${n} station${n === 1 ? "" : "s"}`;

/** `run(range)` -> result; `count(result)` -> stations passing the view filters;
 *  `rows(result)` -> its row count (for the no-progress check).
 *  Start fresh with `user` (searches at it), or continue with `range`, `n` and
 *  `baseRows` from a result already on screen. Returns {res, range, n, note, steps}:
 *  `res` is null when nothing needed fetching; `note` is the sentence to show. */
export async function widen({ user, cap, run, count, rows, range = null, n = 0, baseRows = 0,
                              say = () => {}, onStep = () => {}, cancelled = () => false }) {
  let res = null, steps = 0, stalls = 0, last = baseRows;
  const total = stepsTo(user, cap);
  const done = () => stepsTo(user, range);
  if (range == null) {
    range = user;
    res = await run(range);
    n = count(res);
    last = rows(res);
  }
  while (n < WANT && range < cap && stalls < 2 && !cancelled()) {
    const next = nextRange(range, cap);
    const text = `${range} ly found ${stations(n)} - not enough for a top ${WANT}, widening to ${next} ly…`;
    say(text); log("widen", text);
    onStep({ done: done(), total, range: next, text });
    const r = await run(next);
    if (cancelled()) return { res: null, range, n, note: "", steps, cancelled: true };
    res = r; range = next; steps++;
    n = count(res);
    stalls = rows(res) === last ? stalls + 1 : 0;
    last = rows(res);
  }
  let note = "";
  if (n >= WANT) {
    if (range > user) note = `Widened to ${range} ly to find ${WANT} stations (your radius: ${user} ly)`;
  } else if (range >= cap) note = `Widening stopped: reached the ${cap} ly limit - only ${stations(n)} exist within it`;
  else if (stalls >= 2) note = `Widening stopped: ${range} ly added nothing new - only ${stations(n)} found`;
  if (note) log("widen", note);
  if (steps) onStep({ done: total, total, range, text: note, end: true });
  return { res, range, n, note, steps };
}

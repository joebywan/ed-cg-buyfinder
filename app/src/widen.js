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

/** `run(range)` -> result for the user's chosen source(s); `count(result)` ->
 *  stations passing the view filters; `rows(result)` -> its row count.
 *  `probe(range)` (optional) is a fast Ardent-only run: when given, the radius is
 *  decided with probes (each shown through `onProbe(res, range)`), then `run`
 *  goes ONCE at the final radius, plus at most one more step if it still finds
 *  fewer than WANT. Without `probe`, every step is a `run`.
 *  Start fresh with `user`, or continue with `range` and `n` from a result
 *  already on screen. Returns {res, range, n, note, steps}; `res` is null when
 *  nothing needed fetching. */
export async function widen({ user, cap, run, probe = null, count, rows, range = null, n = 0, baseRows = 0,
                              label = "the full search", say = () => {}, onStep = () => {}, onProbe = () => {},
                              cancelled = () => false }) {
  let res = null, steps = 0, stalls = 0, last = probe && range != null ? -1 : baseRows;
  const total = stepsTo(user, cap);
  const done = () => Math.min(total, stepsTo(user, range));
  const step = async (go, text, tail) => {
    const next = nextRange(range, cap);
    say(text(next)); log("widen", text(next));
    onStep({ done: done(), total, range: next, text: text(next) });
    const r = await go(next);
    if (cancelled()) return null;
    range = next; steps++; tail?.(r);
    return r;
  };
  let probing = !!probe;
  if (range == null) {
    range = user;
    res = await (probe ?? run)(range);
    n = count(res); last = rows(res);
    if (probe) { onProbe(res, range); probing = n < WANT && cap > user; }
  }
  const msg = (r, next) => `${r} ly found ${stations(n)} - not enough for a top ${WANT}, widening to ${next} ly…`;
  if (probing || !probe) {
    while (n < WANT && range < cap && stalls < 2 && !cancelled()) {
      const from = range;
      const r = await step(probe ?? run, (next) => msg(from, next), (r) => {
        n = count(r); stalls = rows(r) === last ? stalls + 1 : 0; last = rows(r);
        if (probe) onProbe(r, range);
        res = r;
      });
      if (!r) return { res: null, range, n, note: "", steps, cancelled: true };
    }
  }
  let picked = "";
  if (probe) {
    const t = `${n >= WANT ? `${range} ly picked from Ardent's quick count` : `Ardent found only ${stations(n)} by ${range} ly`}`
      + ` - searching ${label} at ${range} ly…`;
    if (range > user || n < WANT) { say(t); log("widen", t); }
    onStep({ done: done(), total, range, text: t, final: true });
    res = await run(range);
    if (cancelled()) return { res: null, range, n, note: "", steps, cancelled: true };
    n = count(res);
    picked = range > user ? " (radius picked from Ardent's quick count)" : "";
    if (n < WANT && range < cap) {
      const from = range;
      const r = await step(run, (next) => msg(from, next), (r) => { n = count(r); res = r; });
      if (!r) return { res: null, range, n, note: "", steps, cancelled: true };
    }
  }
  let note = "";
  if (n >= WANT) {
    if (range > user) note = `Widened to ${range} ly to find ${WANT} stations (your radius: ${user} ly)${picked}`;
  } else if (range >= cap) note = `Widening stopped: reached the ${cap} ly limit - only ${stations(n)} exist within it`;
  else if (stalls >= 2) note = `Widening stopped: ${range} ly added nothing new - only ${stations(n)} found`;
  else if (range > user) note = `Widened to ${range} ly - only ${stations(n)} found`;
  if (note) log("widen", note);
  if (steps || probe) onStep({ done: total, total, range, text: note, end: true });
  return { res, range, n, note, steps };
}

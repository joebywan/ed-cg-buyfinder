// Auto-widen: when fewer than WANT stations pass the view filters, search again
// at radius x1.5 (whole 10 ly) until there are enough, the cap is reached, or
// two steps in a row add nothing. Every step queries all selected sources and
// waits for them before deciding. The callers keep the requests small: Spansh
// is asked only for the new ring, Ardent (max distance only) re-queried.
import { log } from "./log.js";

export const WANT = 5;
export const MAX_RADIUS_DEFAULT = 500;
export const nextRange = (r, cap) => Math.min(cap, Math.max(r + 10, Math.round(r * 1.5 / 10) * 10));

/** Steps from `from` out to `cap`, counting `from`: the Radius bar's length. */
export function stepsTo(from, cap) {
  let n = 1;
  for (let r = from; r < cap; r = nextRange(r, cap)) n++;
  return n;
}

const stations = (n) => `${n} station${n === 1 ? "" : "s"}`;

/** `run(range, prev)` -> result for the radius `range` (prev is the radius already
 *  held, 0 on the first step); `count(result)` -> stations passing the view
 *  filters; `rows(result)` -> its row count. `onStep(info)` fires before each
 *  step and once at the end; `onResult(res, range)` after each step finishes.
 *  Start fresh with `user`, or continue with `range` and `n` from a result
 *  already on screen. Returns {res, range, n, note, steps}. */
export async function widen({ user, cap, run, count, rows, range = null, n = 0, baseRows = 0, label = "",
                              say = () => {}, onStep = () => {}, onResult = () => {}, cancelled = () => false }) {
  let res = null, steps = 0, stalls = 0, last = baseRows, stopped = "";
  const total = stepsTo(user, cap);
  const step = async (next, prev) => {
    onStep({ done: stepsTo(user, next) - 1, total, range: next, prev });
    const r = await run(next, prev);
    if (cancelled()) return false;
    range = next; res = r; n = count(r);
    stalls = rows(r) === last ? stalls + 1 : 0; last = rows(r);
    onResult(r, range);
    return true;
  };
  const gone = { res: null, range, n, note: "", steps, cancelled: true };
  if (range == null) {
    if (!(await step(user, 0))) return gone;
    stalls = 0;     // nothing to compare the first step with
  }
  while (n < WANT && range < cap && stalls < 2) {
    const next = nextRange(range, cap);
    const text = `${range} ly: ${stations(n)}${label ? ` from ${label}` : ""} - not enough for a top ${WANT}, widening to ${next} ly…`;
    say(text); log("widen", text);
    steps++;
    const prev = range;
    try {
      if (!(await step(next, prev))) return { ...gone, range, steps };
    } catch (e) {            // keep what the earlier steps found
      log("widen", `step to ${next} ly failed: ${e.message}`);
      stopped = `Widening stopped: ${next} ly failed (${e.message})`;
      break;
    }
  }
  let note = stopped;
  if (!note && n >= WANT) note = range > user ? `${range} ly: ${stations(n)} - done (your radius: ${user} ly)` : "";
  else if (!note && range >= cap) note = `Reached the ${cap} ly limit - only ${stations(n)} within it`;
  else if (!note && stalls >= 2) note = `${range} ly added nothing new - stopping`;
  if (note) log("widen", note);
  onStep({ done: total, total, range, text: note, end: true });
  return { res, range, n, note, steps };
}

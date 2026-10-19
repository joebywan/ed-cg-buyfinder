// Supply readings over time, so a station that is emptying can say so.
// A history is {"system\0station\0commodity": [[market time ms, supply], ...]},
// oldest first. The key is the market's own update time, not when we fetched
// it, so two fetches of one unchanged market are one reading.

export const KEEP = 6;                      // readings kept per commodity
export const MAX_AGE_MS = 14 * 86400e3;     // a key not read for this long is dropped
const HOUR = 3600e3;

export const trendKey = (r) => `${r.system}\0${r.station}\0${r.commodity}`;

/** Fold rows (anything with `at`, the market's ISO timestamp, and `supply`) into the history. */
export function record(hist, rows, now = Date.now()) {
  const next = { ...hist };
  for (const r of rows) {
    const ms = Date.parse(r.at);
    if (!Number.isFinite(ms) || !Number.isFinite(r.supply)) continue;
    const k = trendKey(r);
    const list = (next[k] || []).filter(([t]) => t !== ms);
    list.push([ms, r.supply]);
    next[k] = list.sort((a, b) => a[0] - b[0]).slice(-KEEP);
  }
  for (const k of Object.keys(next)) if (next[k].at(-1)[0] < now - MAX_AGE_MS) delete next[k];
  return next;
}

/** How fast a commodity is draining, or null when it is not.
 *
 *  Rate is tonnes per hour from the oldest kept reading to the newest; `left`
 *  is the newest supply minus that rate over the time since it was read. */
export function drain(entries, now = Date.now()) {
  if (!entries || entries.length < 2) return null;
  const [t0, s0] = entries[0], [t1, s1] = entries.at(-1);
  if (t1 <= t0 || s1 >= s0) return null;
  const hours = (t1 - t0) / HOUR, rate = (s0 - s1) / hours;
  const left = Math.max(0, Math.round(s1 - rate * Math.max(0, now - t1) / HOUR));
  return { from: s0, to: s1, hours, rate, left };
}

/** The tooltip sentence for a drain. */
export function drainText(d, fmt = String) {
  const h = d.hours < 10 ? d.hours.toFixed(1) : Math.round(d.hours);
  return `fell from ${fmt(d.from)} t to ${fmt(d.to)} t over ${h} h; `
    + (d.left > 0 ? `at that rate about ${fmt(d.left)} t left now` : "likely empty");
}

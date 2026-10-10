// Desktop only: run Ardent and Spansh(+EDSM) side by side and keep the better
// reading of each market.
import { MAX_AGE_DEFAULT } from "./model.js";
import { ageFilter } from "./ardent.js";

export const SOURCES = { ardent: "Ardent", spansh: "Spansh", both: "Ardent + Spansh" };

const rowKey = (r) => `${r.system}\0${r.station}\0${r.commodity}`;

/** Merge two buildRows results (null for a source that failed or wasn't run).
 *
 *  THE MERGE RULE: the same station+commodity from both sources keeps the row
 *  with the later `updated` date; a tie goes to Ardent, which also knows the
 *  body. Each row gets `src` ("A", "S" or "AS"), and when both had it `other`
 *  holds the losing source's {src, updated} for the tooltip. */
export function mergeResults(ardent, spansh, p, now = new Date()) {
  const byKey = new Map();
  for (const [src, res] of [["A", ardent], ["S", spansh]]) {
    for (const r of res?.rows ?? []) {
      const have = byKey.get(rowKey(r));
      if (!have) { byKey.set(rowKey(r), { ...r, src }); continue; }
      const win = (r.updated || "") > (have.updated || "") ? { ...r } : have;
      const lose = win === have ? r : have;
      byKey.set(rowKey(r), { ...win, src: "AS", other: { src: lose === r ? src : have.src, updated: lose.updated } });
    }
  }
  const rows = [...byKey.values()].sort((a, b) => b.cr_per_min - a.cr_per_min);
  // Each side already filtered by age; filter the union again so the counts
  // describe what is shown. hiddenStale is the larger of the two, not a sum,
  // since the same stale station is usually hidden by both.
  const aged = ageFilter(rows, p.max_age_days ?? MAX_AGE_DEFAULT, now);
  return {
    rows: aged.rows,
    cg: { ...spansh?.cg, ...ardent?.cg },
    cgLs: ardent?.cgLs || spansh?.cgLs || 0,
    hiddenStale: Math.max(aged.hidden, ardent?.hiddenStale ?? 0, spansh?.hiddenStale ?? 0),
    allStale: aged.allStale,
    errors: [...(ardent?.errors ?? []), ...(spansh?.errors ?? [])],
  };
}

/** Run the chosen source(s). `builders` is {ardent, spansh}: buildRows
 *  functions already bound to their fetchJson. One source throwing becomes an
 *  error line, not a failed search, unless nothing else answered. */
export async function searchSources(source, p, builders, opts) {
  const names = source === "both" ? ["ardent", "spansh"] : [source];
  const tagged = names.length > 1;
  const out = await Promise.allSettled(names.map((n) => builders[n](p, opts)));
  const res = {}, fails = [];
  out.forEach((o, i) => {
    const label = SOURCES[names[i]];
    if (o.status === "fulfilled") {
      res[names[i]] = o.value;
      if (tagged) o.value.errors = o.value.errors.map((e) => `${label}: ${e}`);
    } else fails.push(`${label}: ${o.reason.message}`);
  });
  if (!Object.keys(res).length) throw new Error(fails.join("; "));
  const used = names.filter((n) => res[n]);
  if (!tagged) {
    const r = res[names[0]];
    r.rows.forEach((x) => { x.src = names[0] === "ardent" ? "A" : "S"; });
    return { ...r, sources: used };
  }
  const m = mergeResults(res.ardent, res.spansh, p);
  m.errors.push(...fails);
  return { ...m, sources: used };
}

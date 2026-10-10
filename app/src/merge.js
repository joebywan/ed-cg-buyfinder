// Desktop only: run Ardent and Spansh(+EDSM) side by side and keep the better
// reading of each market.
import { MAX_AGE_DEFAULT } from "./model.js";
import { ageFilter } from "./ardent.js";
import { log } from "./log.js";

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
  // EDSM is the freshest word: what it removed from Spansh stays removed even
  // if Ardent still lists it on an older reading.
  const gone = new Set(spansh?.gone);
  for (const [src, res] of [["A", ardent], ["S", spansh]]) {
    for (const r of res?.rows ?? []) {
      if (gone.has(rowKey(r))) continue;
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
    dropped: spansh?.dropped ?? {},
    gone: spansh?.gone ?? [],
    errors: [...(ardent?.errors ?? []), ...(spansh?.errors ?? [])],
  };
}

/** The result for whatever sources have answered so far. */
function assemble(res, names, p, fails) {
  const used = names.filter((n) => res[n]);
  if (names.length < 2) {
    const r = res[names[0]];
    r.rows.forEach((x) => { x.src = names[0] === "ardent" ? "A" : "S"; });
    return { ...r, sources: used };
  }
  const tag = (n) => res[n] && { ...res[n], errors: res[n].errors.map((e) => `${SOURCES[n]}: ${e}`) };
  const m = mergeResults(tag("ardent"), tag("spansh"), p);
  m.errors.push(...fails);
  return { ...m, sources: used };
}

/** Run the chosen source(s). `builders` is {ardent, spansh}: buildRows
 *  functions already bound to their fetchJson. One source throwing becomes an
 *  error line, not a failed search, unless nothing else answered. Spansh
 *  keeps confirming against EDSM after it returns: each step reaches
 *  `opts.onUpdate(result)` as a full, re-merged result, and the returned
 *  result's `verifying` promise ends when that is over. */
export async function searchSources(source, p, builders, opts) {
  const names = source === "both" ? ["ardent", "spansh"] : [source];
  const tagged = names.length > 1;
  const res = {}, fails = [];
  const runs = names.map((n) => builders[n](p, n === "spansh" && opts?.onUpdate
    ? { ...opts, onUpdate: (r) => { res.spansh = r; opts.onUpdate(assemble(res, names, p, fails)); } }
    : opts));
  // A builder that throws never reports its own end; say so, and take its
  // EDSM leg down with it.
  runs.forEach((run, i) => run.catch((e) => {
    log(names[i], `failed: ${e.message}`);
    for (const provider of names[i] === "spansh" ? ["spansh", "edsm"] : [names[i]]) {
      opts?.onProgress?.({ provider, stage: "failed", detail: e.message });
    }
  }));
  // Spansh can take a minute or more; whichever source lands first is shown
  // on its own while the other is still out, then replaced by the merge.
  if (tagged && opts?.onPartial) {
    let first = true;
    runs.forEach((run, i) => run.then((r) => {
      if (!first) return;
      first = false;
      const src = names[i] === "ardent" ? "A" : "S";
      opts.onPartial({ ...r, rows: r.rows.map((x) => ({ ...x, src })), sources: [names[i]] },
                     SOURCES[names[1 - i]]);
    }, () => {}));
  }
  const out = await Promise.allSettled(runs);
  let verifying, verifyMore, startVerify;
  out.forEach((o, i) => {
    if (o.status === "fulfilled") {
      verifying = o.value.verifying ?? verifying;
      verifyMore = o.value.verifyMore ?? verifyMore;
      startVerify = o.value.startVerify ?? startVerify;
      res[names[i]] ??= o.value;      // a newer update may already be in
    } else fails.push(`${SOURCES[names[i]]}: ${o.reason.message}`);
  });
  if (!Object.keys(res).length) throw new Error(fails.join("; "));
  // `held` is what the next widening step builds on (Spansh's rows so far).
  return { ...assemble(res, names, p, fails), verifying, verifyMore, startVerify, held: res.spansh?.held };
}

// Noticing when later results for the same search move the one station the
// user last copied (their "target"), and when EDSM has been rate-limiting long
// enough that the unconfirmed rows are not going to firm up soon.
// Pure bookkeeping over buildMixed's plans (ranked by cr/min); app.js shows it.
//
// Changes are always measured against what the user last acknowledged, so a
// burst of EDSM confirmations updates one alert instead of stacking, and an
// alert clears itself if the ranking drifts back.
export const STALL_MS = 5 * 60_000;      // EDSM rate-limited this long = worth saying so
export const keyOf = (x) => `${x.station}\0${x.system}`;
const slot = (x) => ({ key: keyOf(x), station: x.station, system: x.system });
const nth = (n) => `#${n}`;
const num = (n) => Math.round(n).toLocaleString("en-US");

/** The numbers a plan is judged by, kept so a later change can be explained. */
const snapshot = (x) => ({
  cr: x.cr_per_min, tonnes: x.tonnes, updated: x.updated, src: x.src, edsm: !!x.edsm,
  mix: new Map((x.mix || []).map((m) => [m.commodity, { supply: m.supply, buy: m.buy }])),
});

/** A few words on the biggest relative change between two snapshots. */
export function why(old, now) {
  if (!old) return "newly listed";
  let best = { r: 0.05, text: "" };         // under 5% is noise
  const see = (a, b, label) => {
    if (!a || a === b) return;
    const r = Math.abs(b - a) / a;
    if (r > best.r) best = { r, text: `${label} ${num(a)} -> ${num(b)}` };
  };
  for (const [c, o] of old.mix) {
    const m = now.mix.get(c);
    if (!m) continue;
    see(o.supply, m.supply, "supply");
    see(o.buy, m.buy, "buy price");
  }
  see(old.tonnes, now.tonnes, "load t");
  const fresher = (now.updated || "") > (old.updated || "");
  if (best.text) return now.edsm && !old.edsm ? `EDSM: ${best.text}` : best.text;
  if (fresher) return now.edsm && !old.edsm ? "EDSM confirmed it" : `fresher ${now.src === "A" ? "Ardent" : "Spansh"} reading`;
  return old.cr && old.cr !== now.cr ? `cr/min ${(old.cr / 1e6).toFixed(2)}M -> ${(now.cr / 1e6).toFixed(2)}M` : "";
}
const tag = (r) => (r ? ` (${r})` : "");

export class Watcher {
  constructor({ now = Date.now, quiet = 10_000, shown = Infinity } = {}) {
    this.now = now;
    this.shown = shown;          // rows on screen: a rank past this is off the list
    this.quiet = quiet;          // min ms between sounds
    this.snap = new Map();       // key -> snapshot of every plan the user has seen
    this.target = null;          // {key, station, system, rank}: the station last copied
    this.sig = "";               // the alert last shown, to beep once per change
    this.lastSound = -Infinity;
  }

  #see(plans) {
    this.snap = new Map(plans.map((x) => [keyOf(x), snapshot(x)]));
  }

  #rank(plans, key) { const i = plans.findIndex((x) => keyOf(x) === key); return i < 0 || i >= this.shown ? 0 : i + 1; }

  /** First render of a search: what is on screen now is the baseline. A
   *  copied target is still compared, since the new results may disagree. */
  begin(plans, dropped = {}) {
    this.#see(plans);
    this.sig = "";
    const a = this.#target(plans, dropped);
    return a && this.#beep(a);
  }

  /** The user copied (or selected) a station: it becomes the target. */
  setTarget(x, plans) {
    this.target = { ...slot(x), rank: this.#rank(plans, keyOf(x)) };
    this.sig = "";
  }
  clearTarget() { this.target = null; this.sig = ""; }

  /** GOT IT / KEEP: accept the current ranking as the baseline. */
  acknowledge(plans) {
    this.#see(plans);
    if (this.target) {
      const rank = this.#rank(plans, this.target.key);
      if (rank) this.target.rank = rank; else this.target = null;
    }
    this.sig = "";
  }

  /** The user changed a view filter: the new ranking is the baseline (no
   *  alert), but a target the filter hides is reported, naming the filter
   *  (`hidden` is its reason, or "" when it still shows). */
  rebase(plans, hidden = "", dropped = {}) {
    this.#see(plans);
    this.sig = "";
    const t = this.target;
    if (!t) return null;
    t.rank = this.#rank(plans, t.key);
    t.hiddenBy = t.rank ? "" : hidden;
    return t.hiddenBy ? this.#beep(this.#hidden(plans)) : null;
  }

  #hidden(plans) {
    const t = this.target, best = plans[0];
    const lead = best ? `${best.station} (${best.system}) is now #1` : "nothing is shown";
    return { kind: "target", text: `Your target ${t.station} is hidden by the ${t.hiddenBy} - ${lead}. New destination?`,
      keys: new Set([t.key]),
      copy: best ? { label: "COPY NEW #1", plan: best } : null, ok: "KEEP" };
  }

  #target(plans, dropped) {
    const t = this.target;
    if (!t) return null;
    const rank = this.#rank(plans, t.key);
    if (t.hiddenBy) {                          // hidden by a filter: say so until it shows again
      if (!rank) return this.#hidden(plans);
      t.hiddenBy = "";
      t.rank = rank;
      return null;
    }
    if (rank === t.rank) return null;
    const best = plans[0];
    const lead = best ? `${best.station} (${best.system}) is now #1` : "nothing is ranked";
    const now = plans.find((x) => keyOf(x) === t.key);
    const r = now ? why(this.snap.get(t.key), snapshot(now)) : "";
    const text = rank
      ? `Your target ${t.station} moved ${nth(t.rank)} -> ${nth(rank)}${tag(r)} - ${lead}. New destination?`
      : `Your target ${t.station} is gone from the results (${dropped[t.key] ? `EDSM: ${dropped[t.key]}` : "sold out or no profit"}) - ${lead}. New destination?`;
    return { kind: "target", text, keys: new Set([t.key]),
             copy: best ? { label: "COPY NEW #1", plan: best } : null, ok: "KEEP" };
  }

  /** A later update to the same search. Returns the alert to show, or null.
   *  `beep` is true once per change and at most once per `quiet` ms. */
  check(plans, dropped = {}) {
    const a = this.#target(plans, dropped);
    if (!a) { this.sig = ""; return null; }
    return this.#beep(a);
  }

  #beep(a) {
    const t = this.now();
    this.kind = a.kind;
    a.beep = a.text !== this.sig && t - this.lastSound >= this.quiet;
    if (a.beep) this.lastSound = t;
    this.sig = a.text;
    return a;
  }
}

/** The banner for an EDSM that has been rate-limiting for STALL_MS or more
 *  (`stalledMs` from EdsmGate) while `pending` stations still wait on it. */
export function stallAlert(stalledMs, pending) {
  if (stalledMs < STALL_MS || !pending) return null;
  return { kind: "edsm", title: "EDSM is rate-limiting", keys: new Set(), copy: null, ok: "GOT IT", beep: true,
    text: `EDSM has been rate-limiting for 5+ min - ${pending} stations still unconfirmed (shown with ?). Results are Spansh/Ardent data until it recovers.` };
}

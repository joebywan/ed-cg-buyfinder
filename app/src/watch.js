// Noticing when later results for the same search reshuffle BEST MIXED LOADS:
// the top five, and the one station the user last copied (their "target").
// Pure bookkeeping over buildMixed's plans (ranked by cr/min); app.js shows it.
//
// Changes are always measured against what the user last acknowledged, so a
// burst of EDSM confirmations updates one alert instead of stacking, and an
// alert clears itself if the ranking drifts back.
export const TOP_N = 5;
export const keyOf = (x) => `${x.station}\0${x.system}`;
const slot = (x) => ({ key: keyOf(x), station: x.station, system: x.system });
const nth = (n) => `#${n}`;
const MAX_BANNER = 170;       // longer alerts are cut for the banner; the tooltip and log keep it all
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
    this.ack = [];               // top N the user has seen
    this.snap = new Map();       // key -> snapshot of every plan the user has seen
    this.target = null;          // {key, station, system, rank}: the station last copied
    this.sig = "";               // the alert last shown, to beep once per change
    this.lastSound = -Infinity;
  }

  #see(plans) {
    this.ack = plans.slice(0, TOP_N).map(slot);
    this.snap = new Map(plans.map((x) => [keyOf(x), snapshot(x)]));
  }

  #rank(plans, key) { const i = plans.findIndex((x) => keyOf(x) === key); return i < 0 || i >= this.shown ? 0 : i + 1; }

  /** First render of a search: what is on screen now is the baseline. A
   *  copied target is still compared, since the new results may disagree. */
  begin(plans) {
    this.#see(plans);
    this.sig = "";
    const a = this.#target(plans);
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

  #target(plans) {
    const t = this.target;
    if (!t) return null;
    const rank = this.#rank(plans, t.key);
    if (rank === t.rank) return null;
    const best = plans[0];
    const lead = best ? `${best.station} (${best.system}) is now #1` : "nothing is ranked";
    const now = plans.find((x) => keyOf(x) === t.key);
    const r = now ? why(this.snap.get(t.key), snapshot(now)) : "";
    const text = rank
      ? `Your target ${t.station} moved ${nth(t.rank)} -> ${nth(rank)}${tag(r)} - ${lead}. New destination?`
      : `Your target ${t.station} is gone from the results (sold out or no profit) - ${lead}. New destination?`;
    return { kind: "target", text, keys: new Set([t.key, ...(best ? [keyOf(best)] : [])]),
             copy: best ? { label: "COPY NEW #1", plan: best } : null, ok: "KEEP" };
  }

  #top5(plans) {
    const now = plans.slice(0, TOP_N);
    if (now.length === this.ack.length && now.every((x, i) => keyOf(x) === this.ack[i].key)) return null;
    const bits = [];
    const reason = (key) => { const p = plans.find((x) => keyOf(x) === key); return p ? tag(why(this.snap.get(key), snapshot(p))) : ""; };
    this.ack.forEach((a, i) => {
      const r = this.#rank(plans, a.key);
      if (r === i + 1) return;
      bits.push(r ? `${a.station} ${nth(i + 1)} -> ${nth(r)}${reason(a.key)}` : `${a.station} ${nth(i + 1)} dropped off the list`);
    });
    const was = new Set(this.ack.map((a) => a.key));
    now.forEach((x, i) => { if (i && !was.has(keyOf(x))) bits.push(`${x.station} up to ${nth(i + 1)}${reason(keyOf(x))}`); });
    const best = plans[0];
    if (best && best.station !== this.ack[0]?.station) bits.push(`${best.station} is now #1${was.has(keyOf(best)) ? "" : reason(keyOf(best))}`);
    const keys = new Set(now.map(keyOf).filter((k, i) => k !== this.ack[i]?.key));
    const detail = `Top ${TOP_N} changed: ${bits.join("; ")}`;
    return { kind: "top5", text: detail.length > MAX_BANNER ? `${detail.slice(0, MAX_BANNER - 1)}…` : detail, detail, keys,
             copy: best ? { label: "COPY SYSTEM", plan: best } : null, ok: "GOT IT" };
  }

  /** A later update to the same search. Returns the alert to show, or null.
   *  `beep` is true once per change and at most once per `quiet` ms. */
  check(plans) {
    const a = this.#target(plans) ?? this.#top5(plans);
    if (!a) { this.sig = ""; return null; }
    return this.#beep(a);
  }

  #beep(a) {
    const t = this.now();
    a.beep = a.text !== this.sig && t - this.lastSound >= this.quiet;
    if (a.beep) this.lastSound = t;
    this.sig = a.text;
    return a;
  }
}

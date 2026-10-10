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

export class Watcher {
  constructor({ now = Date.now, quiet = 10_000 } = {}) {
    this.now = now;
    this.quiet = quiet;          // min ms between sounds
    this.ack = [];               // top N the user has seen
    this.target = null;          // {key, station, system, rank}: the station last copied
    this.sig = "";               // the alert last shown, to beep once per change
    this.lastSound = -Infinity;
  }

  #rank(plans, key) { const i = plans.findIndex((x) => keyOf(x) === key); return i < 0 ? 0 : i + 1; }

  /** First render of a search: what is on screen now is the baseline. A
   *  copied target is still compared, since the new results may disagree. */
  begin(plans) {
    this.ack = plans.slice(0, TOP_N).map(slot);
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
    this.ack = plans.slice(0, TOP_N).map(slot);
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
    const text = rank
      ? `Your target ${t.station} moved ${nth(t.rank)} -> ${nth(rank)} - ${lead}. New destination?`
      : `Your target ${t.station} is gone from the results (sold out or no profit) - ${lead}. New destination?`;
    return { kind: "target", text, keys: new Set([t.key, ...(best ? [keyOf(best)] : [])]),
             copy: best ? { label: "COPY NEW #1", plan: best } : null, ok: "KEEP" };
  }

  #top5(plans) {
    const now = plans.slice(0, TOP_N);
    if (now.length === this.ack.length && now.every((x, i) => keyOf(x) === this.ack[i].key)) return null;
    const bits = [];
    this.ack.forEach((a, i) => {
      const r = this.#rank(plans, a.key);
      if (r === i + 1) return;
      bits.push(r ? `${a.station} ${nth(i + 1)} -> ${nth(r)}` : `${a.station} ${nth(i + 1)} dropped out`);
    });
    const best = plans[0];
    if (best && best.station !== this.ack[0]?.station) bits.push(`${best.station} is now #1`);
    const keys = new Set(now.map(keyOf).filter((k, i) => k !== this.ack[i]?.key));
    return { kind: "top5", text: `Top ${TOP_N} changed: ${bits.join("; ")}`, keys,
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

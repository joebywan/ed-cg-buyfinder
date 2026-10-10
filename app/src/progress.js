// Per-provider progress for one search. Providers emit
// {provider: "ardent"|"spansh"|"edsm", stage, done, total, detail}; stage
// "done", "failed" or "skipped" ends a provider. Totals are estimates that
// providers refine as they learn more (e.g. Spansh pages).
const END = ["done", "failed", "skipped"];

export class Progress {
  constructor(now = Date.now) { this.now = now; this.p = {}; }

  update({ provider, stage, done, total, detail = "" }) {
    const s = (this.p[provider] ??= { t0: this.now(), done: 0, total: 0, state: "run" });
    if (s.state !== "run") return;
    if (total !== undefined) s.total = total;
    if (done !== undefined) s.done = done;
    s.stage = stage;
    s.detail = detail;
    if (END.includes(stage)) {
      s.state = stage;
      s.ms = this.now() - s.t0;
      if (stage !== "failed") s.done = s.total;
    }
  }

  /** Fraction 0..1: finished providers count as complete, others by steps done. */
  overall() {
    let d = 0, t = 0;
    for (const s of Object.values(this.p)) {
      t += s.total;
      d += s.state === "run" ? Math.min(s.done, s.total) : s.total;
    }
    return t ? d / t : 0;
  }
}

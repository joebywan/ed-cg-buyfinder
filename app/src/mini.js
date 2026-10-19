// The mini card: what to show, from state the main window has already worked
// out. No DOM here; app.js draws it.

import { ageTag, ageText } from "./model.js";
import { keyOf } from "./watch.js";

const n0 = (n) => Number(n).toLocaleString("en-US");

/** The copied station if it is still in the results, else the best cr/min one. */
export function miniTarget(plans, target) {
  return (target && plans.find((x) => keyOf(x) === target.key)) || plans[0] || null;
}

/** The standing line's tier, percent-to-next and runs; the rest is for the full window. */
export function miniStanding(text) {
  return (text || "").split(" · ").filter((b) => /^tier |of the way|clear/.test(b)).join(" · ");
}

/** Plain fields for the card, or null when there is nothing to show.
 *  A target alert shows its text and the new best station instead. */
export function miniCard({ plans, target, alert, standing }) {
  const hit = alert?.kind === "target";
  const plan = hit ? alert.copy?.plan ?? plans[0] : miniTarget(plans, target);
  return {
    alert: hit ? alert.text : null,
    standing: miniStanding(standing),
    plan: plan && {
      station: plan.station, ls: `${n0(plan.ls ?? 0)} ls`,
      system: plan.system, ly: `${plan.ly} ly`,
      load: plan.mix.map((m) => `${m.commodity} ${n0(m.tonnes)}t`).join(" + "),
      crpm: `${n0(plan.cr_per_min)} cr/min`,
      age: ageText(plan.updated), ageClass: ageTag(plan.updated),
      mark: plan.confirmed ? "✓" : plan.pending ? "?" : "",
      copied: !hit && !!target && keyOf(plan) === target.key,
    },
  };
}

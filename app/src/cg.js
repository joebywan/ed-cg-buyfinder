// Community goal discovery: Frontier's feed plus the journal's
// CommunityGoal events. A port of the destination half of cg.py.

export const FRONTIER_URL = "https://api.orerve.net/2.0/website/initiatives/list?lang=en";

/** Frontier's initiatives feed -> goal dicts. Undocumented, so tolerant. */
export function parseLive(d) {
  const list = Array.isArray(d?.activeInitiatives) ? d.activeInitiatives : [];
  return list.map((it) => {
    const commodities = String(it.target_commodity_list || "")
      .split(",").map((c) => c.trim()).filter(Boolean);
    const num = (k) => {
      const n = Number(it[k] ?? 0);
      return Number.isInteger(n) ? n : 0;
    };
    return {
      id: it.id ?? null, title: it.title ?? null,
      station: it.market_name ?? null, system: it.starsystem_name ?? null,
      expiry: it.expiry ?? null, activity: it.activityType ?? null, commodities,
      target_qty: num("target_qty"), qty: num("qty"),
      // A trade goal names commodities and is typed "tradelist".
      is_trade: commodities.length > 0 && it.activityType === "tradelist",
    };
  });
}

/** Every CommunityGoal sample in the given journal lines, oldest first. */
export function historyFromLines(lines) {
  const out = [];
  for (const line of lines) {
    if (!line.includes('"CommunityGoal"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.event !== "CommunityGoal") continue;
    for (const g of e.CurrentGoals || []) {
      out.push({
        ts: e.timestamp ?? null, cgid: g.CGID ?? null, title: g.Title ?? null,
        station: g.MarketName ?? null, system: g.SystemName ?? null, expiry: g.Expiry ?? null,
        contribution: g.PlayerContribution ?? null, band: g.PlayerPercentileBand ?? null,
        total: g.CurrentTotal ?? null, contributors: g.NumContributors ?? null,
        tier: g.TierReached ?? null, top_tier: g.TopTier?.Name ?? null, bonus: g.Bonus ?? null,
        in_top_rank: g.PlayerInTopRank ?? null, top_rank_size: g.TopRankSize ?? null,
      });
    }
  }
  return out;
}

/** The goal this commander joined, with commodities from the live feed. */
export function joinedGoal(history, live = []) {
  const cur = history?.at(-1);
  if (!cur?.station || !cur?.system) return null;
  const match = (live || []).find((g) => g.is_trade
    && g.station === cur.station && g.system === cur.system);
  const commodities = match ? [...match.commodities] : [];
  return {
    station: cur.station, system: cur.system, commodities, title: cur.title, expiry: cur.expiry,
    source: commodities.length ? "joined CG" : "joined CG (no commodity list)",
  };
}

/**
 * [destination or null, other live trade goals]: the joined goal, else the
 * first live trade goal flagged as not joined, else nothing.
 */
export function suggestDestination(history, live = []) {
  const trade = (live || []).filter((g) => g.is_trade);
  const joined = joinedGoal(history, live);
  if (joined?.commodities.length) {
    return [joined, trade.filter((g) => g.station !== joined.station || g.system !== joined.system)];
  }
  if (trade.length) {
    const g = trade[0];
    return [{ station: g.station, system: g.system, commodities: [...g.commodities],
              title: g.title, expiry: g.expiry, source: "live CG (not joined)" }, trade.slice(1)];
  }
  return [null, []];
}

// -- standing -------------------------------------------------------------------
// Where you are in the goal. Frontier publishes no tonnage thresholds, so band
// boundaries are BRACKETED from the commander's own crossings (a measured
// range, not a prediction). Above the best band the reward is a top-N rank:
// the journal says only whether you are in it, so it is a yes or a no.

// Percentile bands, best first. PlayerPercentileBand tops out at 25; the rung
// above is the top-N rank in TopRankSize.
export const BANDS = [25, 50, 75, 100];

/** {band: [last_seen_below, first_seen_at]} from observed crossings; anything never crossed is absent. */
export function bandBrackets(history) {
  const samples = (history || []).filter((h) => h.contribution != null && h.band != null)
    .map((h) => [h.contribution, h.band]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = {};
  let prev = null;
  for (const [c, b] of samples) {
    if (prev && b < prev[1]) out[b] = [prev[0], c];      // smaller band = better
    prev = [c, b];
  }
  return out;
}

/** Your tonnage over the average contributor's (both exact, from one event), or null. */
export function timesAverage(contribution, total, contributors) {
  if (!contribution || !total || !contributors) return null;
  const mean = total / contributors;
  return mean > 0 ? contribution / mean : null;
}

/** Tonnes per hour over the most recent samples. */
export function ratePerHour(history, window = 6) {
  const pts = (history || []).filter((h) => h.contribution).slice(-window);
  if (pts.length < 2) return null;
  const t0 = Date.parse(pts[0].ts), t1 = Date.parse(pts.at(-1).ts);
  const c0 = pts[0].contribution, c1 = pts.at(-1).contribution;
  if (!(t1 > t0) || c1 <= c0) return null;
  return (c1 - c0) / ((t1 - t0) / 3.6e6);
}

/** Hours until an expiry stamp (Frontier's is naive UTC), or null. */
export function hoursLeft(expiry, now = Date.now()) {
  const m = typeof expiry === "string" && /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})Z?$/.exec(expiry);
  const t = m && Date.parse(`${m[1]}T${m[2]}Z`);
  return t ? (t - now) / 3.6e6 : null;
}

/** Everything the display needs about where you stand, or null with no history. */
export function standing(history, live = null, now = Date.now()) {
  const cur = history?.at(-1);
  if (!cur) return null;
  const br = bandBrackets(history);
  const band = cur.band;
  const next = band ? [...BANDS].reverse().find((b) => b < band) ?? null : null;
  const hold_margin = band in br ? cur.contribution - br[band][1] : null;
  const next_known = next != null && next in br;
  const to_next = next_known ? Math.max(0, br[next][1] - cur.contribution) : null;
  // Extrapolate an unobserved next threshold from the gaps between crossed ones;
  // labelled as an estimate, since thresholds also drift up as others deliver.
  let est_next = null;
  if (next != null && !next_known) {
    const known = Object.keys(br).map(Number).sort((a, b) => a - b);
    if (known.length >= 2) {
      const mid = (b) => (br[b][0] + br[b][1]) / 2;
      const ratio = mid(known[0]) / mid(known[1]);
      if (ratio > 1) est_next = Math.trunc(mid(known[0]) * ratio);
    }
  }
  const exp = live?.expiry || cur.expiry;
  return {
    cgid: cur.cgid, title: cur.title, station: cur.station, system: cur.system, tier: cur.tier, top_tier: cur.top_tier,
    contribution: cur.contribution, band, next_band: next, contributors: cur.contributors,
    total: live?.qty || cur.total, target: live?.target_qty || null,
    brackets: br, rate_per_hour: ratePerHour(history), hold_margin, to_next, next_known, est_next,
    top_rank_size: cur.top_rank_size, in_top_rank: cur.in_top_rank,
    mean_contribution: cur.total && cur.contributors ? cur.total / cur.contributors : null,
    times_average: timesAverage(cur.contribution, cur.total, cur.contributors),
    hours_left: exp ? hoursLeft(exp, now) : null, as_of: cur.ts,
  };
}

// -- finish forecast ------------------------------------------------------------
// Popular goals end early when the top tier is reached. Both pieces below are
// extrapolations of the goal's recent growth, labelled as estimates.

const H = 3.6e6;

/** Goal-total points {t, total, contributors, contribution, band}, oldest first: journal samples of `cgid` plus feed snapshots [[ms, qty], ...]. */
export function totalPoints(history, cgid, snaps = []) {
  const j = (history || []).filter((h) => String(h.cgid) === String(cgid) && h.total && Date.parse(h.ts))
    .map((h) => ({ t: Date.parse(h.ts), total: h.total, contributors: h.contributors, contribution: h.contribution, band: h.band }));
  const f = (snaps || []).map(([t, total]) => ({ t, total, contributors: null }));
  return [...j, ...f].sort((a, b) => a.t - b.t);
}

/** Least-squares slope of y(x) in units per hour over the points the fit uses, or null. */
function slope(pts, key) {
  const p = pts.filter((q) => q[key] != null);
  if (p.length < 2) return null;
  const mx = p.reduce((a, q) => a + q.t, 0) / p.length, my = p.reduce((a, q) => a + q[key], 0) / p.length;
  const sxx = p.reduce((a, q) => a + (q.t - mx) ** 2, 0);
  return sxx ? p.reduce((a, q) => a + (q.t - mx) * (q[key] - my), 0) / sxx * H : null;
}

/** Last 24 h of points when they span >= 6 h, else all of them; [] when under 1 h of data. */
function fitWindow(points) {
  const span = (p) => (p.at(-1).t - p[0].t) / H;
  if (!points || points.length < 2 || span(points) < 1) return [];
  const w = points.filter((q) => q.t >= points.at(-1).t - 24 * H);
  return span(points) >= 6 && w.length >= 2 && span(w) >= 1 ? w : points;
}

/**
 * When the goal will end: {rate t/h, hours_to_target, finishes_early, end_hours, reached, basis}, or null
 * with too little data. end_hours is whichever of target and expiry comes first.
 */
export function finishEstimate(points, target, expiryHours, now = Date.now()) {
  const w = fitWindow(points);
  if (!w.length) return null;
  const last = points.at(-1);
  const rate = Math.max(0, slope(w, "total") ?? 0);
  const basis = `${w.length} readings over ${((w.at(-1).t - w[0].t) / H).toFixed(1)} h`;
  if (target && last.total >= target) {
    return { rate, hours_to_target: 0, finishes_early: true, end_hours: 0, reached: true, basis };
  }
  const toTarget = target && rate > 0 ? Math.max(0, (target - last.total) / rate - (now - last.t) / H) : null;
  const early = toTarget != null && (expiryHours == null || toTarget < expiryHours);
  const end = [toTarget, expiryHours].filter((x) => x != null && x >= 0);
  return { rate, hours_to_target: toTarget, finishes_early: early, reached: false,
    end_hours: end.length ? Math.min(...end) : null, basis };
}

/**
 * Will your band survive to the end? A band's cut-off is modelled as a fixed multiple k of the mean
 * contribution (total / contributors), k measured where you crossed into the band. Projects that mean to
 * the end and compares. -> {kind: safe|tight|haul|unknown|rank, margin, cutoff, text, tip}, or null.
 */
export function bandOutlook(st, points, finish, run = {}, now = Date.now()) {
  if (!st || st.band == null) return null;
  const hold = Math.max(1, run.hold ?? 1);
  if (st.next_band == null && st.top_rank_size) {
    return { kind: "rank", text: "", tip: `Top ${st.band}% is the best percentile band; the top-${st.top_rank_size} rank above it is reported only as in or out, so no projection is possible.` };
  }
  const cross = st.brackets?.[st.band]?.[1];
  const at = cross == null ? null : points.filter((p) => p.contributors && p.contribution)
    .reduce((b, p) => (!b || Math.abs(p.contribution - cross) < Math.abs(b.contribution - cross) ? p : b), null);
  if (!at || !finish || finish.end_hours == null) {
    return { kind: "unknown", text: "", tip: !at ? "Can't project whether you keep your band: no crossing into it was seen, so its size relative to the average contributor is unknown." : "Can't project whether you keep your band: too little data on how fast the goal is growing." };
  }
  const k = cross / (at.total / at.contributors);
  const last = points.at(-1), ahead = (now - last.t) / H + finish.end_hours;
  let total = last.total + finish.rate * ahead;
  if (st.target) total = Math.min(total, st.target);
  const cp = points.filter((p) => p.contributors);
  const w = fitWindow(cp), cs = w.length ? slope(w, "contributors") : null;
  const cNow = cp.at(-1)?.contributors ?? st.contributors;
  const contributors = Math.max(cNow, cNow + (cs ?? 0) * ((now - cp.at(-1).t) / H + finish.end_hours));
  const mean = total / contributors, cutoff = k * mean, margin = st.contribution - cutoff;
  const kind = margin >= hold ? "safe" : margin >= 0 ? "tight" : "haul";
  const need = Math.ceil(-margin + hold);
  const eff = effort(need, hold, run.mins);
  const text = kind === "safe" ? `SAFE TO STOP (~${n0(margin)} t over projected top-${st.band}% cut-off)`
    : kind === "tight" ? `TIGHT: ~${n0(margin)} t over`
    : `KEEP HAULING: ~${n0(need)} t (${eff})`;
  const tip = `Estimate. Model: a band's cut-off is a fixed multiple of the mean contribution (total / contributors). `
    + `You crossed into top ${st.band}% at ${n0(cross)} t when the mean was ${n0(at.total / at.contributors)} t, so k = ${k.toFixed(2)}. `
    + `Projected at the end: goal total ${n0(total)} t, ${n0(contributors)} contributors, mean ${n0(mean)} t, so a top-${st.band}% cut-off near ${n0(cutoff)} t `
    + `against your ${n0(st.contribution)} t (margin ${n0(margin)} t). `
    + `Safe needs a full hold (${n0(hold)} t) of cushion; keep-hauling figures include that cushion. Based on ${points.length} goal readings.`;
  return { kind, margin, cutoff, mean, k, need, text, tip };
}

/** [countdown text, tooltip] for the goal's end, or null with nothing known. */
export function countdown(finish, expiryHours, now = Date.now()) {
  const dh = (h) => h < 1 ? `${Math.max(0, Math.round(h * 60))}m` : `${Math.floor(h / 24)}d ${Math.floor(h % 24)}h`.replace(/^0d /, "");
  if (finish?.reached) return ["goal target reached - ending", "The goal total has reached its target, so it should close at the next tick."];
  if (finish?.finishes_early) {
    const when = new Date(now + finish.end_hours * H).toLocaleString();
    return [`ends in ~${dh(finish.end_hours)} (est., expiry ${expiryHours != null ? dh(expiryHours) : "unknown"})`,
      `Estimate: the goal is growing at ${n0(finish.rate)} t/h (${finish.basis}) and should hit its target around ${when}, before its expiry.`];
  }
  if (expiryHours > 0) return [`ends in ${dh(expiryHours)}`, finish?.rate ? `At ${n0(finish.rate)} t/h (${finish.basis}) the goal will not reach its target before expiry.` : ""];
  return null;
}

const n0 = (n) => Math.round(n).toLocaleString("en-US");
const tierNo = (t) => String(t ?? "").replace(/\D+/g, "");

/** "N runs, ~X min" to move `tonnes`, from the hold and minutes per run (null: unknown). */
export function effort(tonnes, hold, mins) {
  const runs = tonnes > 0 ? Math.ceil(tonnes / Math.max(1, hold)) : 0;
  if (!runs) return "you're there";
  const word = `${runs} run${runs === 1 ? "" : "s"}`;
  if (!mins) return word;
  const total = runs * mins;
  return `${word}, ~${total < 90 ? `${Math.round(total)} min` : `${Math.floor(Math.round(total) / 60)}h ${String(Math.round(total) % 60).padStart(2, "0")}m`}`;
}

/**
 * Band moves between the last standing seen ({cgid, band, inTop}) and this one:
 * {next, notes: [{title, text, up}]}. The first sight of a goal only seeds.
 */
export function standingChanges(last, st) {
  const notes = [];
  const next = last?.cgid === st.cgid ? { ...last } : { cgid: st.cgid };
  const c = n0(st.contribution ?? 0);
  if (st.band != null) {
    const was = next.band;
    if (was != null && st.band !== was) {
      notes.push(st.band < was
        ? { up: true, title: `Moved up to the top ${st.band}%`, text: `Was top ${was}%. ${c} t delivered.` }
        : { up: false, title: `Dropped to the top ${st.band}%`, text: `Was top ${was}%. Others have overtaken you - ${c} t delivered so far.` });
    }
    next.band = st.band;
  }
  const n = st.top_rank_size;
  if (n && st.in_top_rank != null) {
    if (next.inTop != null && st.in_top_rank !== next.inTop) {
      notes.push(st.in_top_rank
        ? { up: true, title: `Into the top ${n}`, text: `${c} t delivered.` }
        : { up: false, title: `Out of the top ${n}`, text: `Others have overtaken you - ${c} t delivered so far.` });
    }
    next.inTop = st.in_top_rank;
  }
  return { next, notes };
}

/** [one line, tooltip] in plain words. `run` = {hold, mins, basis} turns tonnes into runs and time. */
export function standingText(st, run = {}, fx = {}) {
  if (!st) return ["", ""];
  const bits = [`Your contribution ${n0(st.contribution ?? 0)} t`];
  const tip = [];
  const cd = fx.finish || st.hours_left > 0 ? countdown(fx.finish, st.hours_left, fx.now) : null;
  if (cd) { bits.push(cd[0]); if (cd[1]) tip.push(cd[1]); }
  const mark = fx.outlook?.text || "";
  if (mark) bits.push(mark);
  if (fx.outlook?.tip) tip.push(fx.outlook.tip);
  if (st.band != null) {
    const entered = st.hold_margin != null ? st.contribution - st.hold_margin : null;
    bits.push(`top ${st.band}% band${entered != null ? ` (reached when you passed ~${n0(entered)} t)` : ""}`);
  }
  if (st.tier != null) {
    const top = tierNo(st.top_tier);
    bits.push(`tier ${tierNo(st.tier) || st.tier}${top ? `/${top}` : ""} globally`);
  }
  if (st.times_average) {
    bits.push(`${st.times_average.toFixed(1)}x the average contributor`);
    tip.push(`The average contributor is on ${n0(st.mean_contribution)} t and you are on ${n0(st.contribution)} t, `
      + `${st.times_average.toFixed(1)} times that. A ratio, not a placing: the field is lopsided, so the average sits well above the middle.`);
  }
  if (st.next_band == null && st.top_rank_size) {
    bits.push(st.in_top_rank ? `in the top ${st.top_rank_size}` : `not in the top ${st.top_rank_size}`);
    tip.push(`Top ${st.band}% is the best percentile band; above it the reward goes to the top ${st.top_rank_size} commanders by tonnage. `
      + "The journal says only whether you are in it, never what the cut-off costs.");
  } else if (st.next_known || st.est_next) {
    const approx = !st.next_known;
    const target = st.next_known ? st.contribution + st.to_next : st.est_next;
    const gap = Math.max(0, target - st.contribution);
    // Percent of the way from where this band started to where the next does.
    const entered = st.contribution - (st.hold_margin ?? 0);
    const pct = Math.max(0, Math.min(100, 100 * (st.contribution - entered) / Math.max(1, target - entered)));
    const eff = effort(gap, run.hold ?? 1, run.mins);
    bits.push(`${approx ? "about " : ""}${n0(gap)} t to top ${st.next_band}% (${approx ? "~" : ""}${pct.toFixed(0)}% of the way, ${eff})`);
    tip.push(`${approx ? "About " : ""}${n0(gap)} t still needed to reach top ${st.next_band}%: ${eff}.`
      + (run.mins ? ` Based on ${Math.round(run.mins)} min a run${run.basis ? `: ${run.basis}` : ""}.` : ""));
    if (approx) tip.push("That threshold is extrapolated from the bands you have crossed; real ones drift up as others deliver.");
  } else if (st.next_band != null) bits.push(`top ${st.next_band}% threshold not yet seen`);
  if (st.hold_margin != null) {
    // A cushion in runs: a bad day of others delivering can erase it.
    const runs = Math.floor(st.hold_margin / Math.max(1, run.hold ?? 1));
    bits.push(`${n0(st.hold_margin)} t clear${runs ? ` (${runs} run${runs === 1 ? "" : "s"})` : ""}`);
    tip.push(`You are ${n0(st.hold_margin)} t clear of where you entered top ${st.band}%.`);
  }
  if (st.rate_per_hour && (st.to_next || st.est_next)) {
    const gap = st.to_next ?? Math.max(0, st.est_next - st.contribution);
    tip.push(`About ${(gap / st.rate_per_hour).toFixed(1)} h of flying at your recent ${n0(st.rate_per_hour)} t/h.`);
  }
  if (!cd && st.hours_left > 0) bits.push(`${Math.floor(st.hours_left / 24)}d ${Math.floor(st.hours_left % 24)}h left`);
  tip.push("Frontier publishes no band thresholds: the ones quoted are measured from your own crossings and only ever floors.");
  return [bits.join(" · "), tip.join("\n\n"), mark, fx.outlook?.kind];
}

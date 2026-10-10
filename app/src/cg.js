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
export function standingText(st, run = {}) {
  if (!st) return ["", ""];
  const bits = [`Your contribution ${n0(st.contribution ?? 0)} t`];
  const tip = [];
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
  if (st.hours_left > 0) bits.push(`${Math.floor(st.hours_left / 24)}d ${Math.floor(st.hours_left % 24)}h left`);
  tip.push("Frontier publishes no band thresholds: the ones quoted are measured from your own crossings and only ever floors.");
  return [bits.join(" · "), tip.join("\n\n")];
}

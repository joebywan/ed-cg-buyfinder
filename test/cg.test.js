// Ported from cg.py's fetch_live parsing, read_history, joined_goal and
// suggest_destination.
import test from "node:test";
import assert from "node:assert/strict";
import { bandBrackets, hoursLeft, historyFromLines, joinedGoal, parseLive, ratePerHour, standing, standingText,
  suggestDestination, timesAverage } from "../src/cg.js";

const FEED = {
  activeInitiatives: [
    { id: "859", title: "Wreaken Calls", market_name: "Metz Enterprise",
      starsystem_name: "Ega", expiry: "2026-09-17 11:00:00", activityType: "tradelist",
      target_commodity_list: "Palladium, Gold ,Silver,", target_qty: "1000", qty: "250" },
    { id: "860", title: "Bounty hunt", market_name: "Somewhere", starsystem_name: "Sol",
      activityType: "bounty", target_commodity_list: "" },
    { id: "861", title: "Second trade goal", market_name: "Other Port",
      starsystem_name: "Lave", activityType: "tradelist", target_commodity_list: "Water",
      target_qty: "nope" },
  ],
};

test("the live feed is parsed and trade goals are flagged", () => {
  const live = parseLive(FEED);
  assert.equal(live.length, 3);
  assert.deepEqual(live[0].commodities, ["Palladium", "Gold", "Silver"]);
  assert.equal(live[0].is_trade, true);
  assert.equal(live[0].station, "Metz Enterprise");
  assert.equal(live[0].system, "Ega");
  assert.equal(live[0].target_qty, 1000);
  assert.equal(live[1].is_trade, false);
  assert.equal(live[2].target_qty, 0);
  assert.deepEqual(parseLive(null), []);
  assert.deepEqual(parseLive({}), []);
});

const cgLine = (goal, when = "2026-09-14T12:00:00Z") =>
  JSON.stringify({ timestamp: when, event: "CommunityGoal", CurrentGoals: [goal] });

test("history reads CommunityGoal events and skips everything else", () => {
  const h = historyFromLines([
    '{"timestamp":"2026-09-14T11:00:00Z","event":"FSDJump","StarSystem":"Ega"}',
    "{broken",
    cgLine({ CGID: 859, Title: "Wreaken", SystemName: "Ega", MarketName: "Metz Enterprise",
             Expiry: "2026-09-17T11:00:00Z", PlayerContribution: 100 }),
  ]);
  assert.equal(h.length, 1);
  assert.deepEqual([h[0].cgid, h[0].station, h[0].system, h[0].contribution],
    [859, "Metz Enterprise", "Ega", 100]);
});

test("the joined goal takes its commodity list from the feed", () => {
  const live = parseLive(FEED);
  const h = historyFromLines([cgLine({ CGID: 859, Title: "Wreaken", SystemName: "Ega",
                                       MarketName: "Metz Enterprise" })]);
  const d = joinedGoal(h, live);
  assert.deepEqual(d.commodities, ["Palladium", "Gold", "Silver"]);
  assert.equal(d.source, "joined CG");
  assert.equal(joinedGoal([], live), null);
});

test("suggest: joined goal first, else a live trade goal flagged not joined, else none", () => {
  const live = parseLive(FEED);
  const joined = historyFromLines([cgLine({ SystemName: "Lave", MarketName: "Other Port" })]);
  const [d1, others1] = suggestDestination(joined, live);
  assert.equal(d1.station, "Other Port");
  assert.deepEqual(others1.map((g) => g.station), ["Metz Enterprise"]);

  const [d2, others2] = suggestDestination([], live);
  assert.equal(d2.station, "Metz Enterprise");
  assert.equal(d2.source, "live CG (not joined)");
  assert.deepEqual(others2.map((g) => g.station), ["Other Port"]);

  // joined a goal that is no longer in the feed: no commodity list, fall back
  const gone = historyFromLines([cgLine({ SystemName: "Nowhere", MarketName: "Gone" })]);
  assert.equal(suggestDestination(gone, live)[0].station, "Metz Enterprise");

  assert.deepEqual(suggestDestination([], []), [null, []]);
});

// -- standing (ported from test_cgbuy.py: band_brackets, standing, times_average) --

const smp = (contribution, band, kw = {}) => ({ ts: "2025-01-01T12:00:00Z", cgid: 727, title: "Ega Mining Initiative",
  station: "Metz Enterprise", system: "Ega", expiry: null, contribution, band, total: 1000000, contributors: 5000,
  tier: 4, top_tier: "Tier 8", bonus: 0, in_top_rank: false, top_rank_size: 10, ...kw });
const hist = (...pairs) => pairs.map(([c, b]) => smp(c, b));

test("a crossing brackets the threshold; order and gaps do not matter", () => {
  const want = { 75: [100, 500], 50: [900, 1200] };
  assert.deepEqual(bandBrackets(hist([100, 100], [500, 75], [900, 75], [1200, 50])), want);
  assert.deepEqual(bandBrackets(hist([1200, 50], [100, 100], [900, 75], [500, 75])), want);
  assert.deepEqual(Object.keys(bandBrackets(hist([100, 100], [500, 75]))), ["75"]);   // never crossed = absent
  assert.deepEqual(bandBrackets(hist([500, 75])), {});
  assert.deepEqual(bandBrackets([]), {});
  assert.deepEqual(bandBrackets([smp(100, 100), smp(null, 75), smp(500, null), smp(900, 75)]), { 75: [100, 900] });
  assert.deepEqual(bandBrackets(hist([100, 50], [500, 75], [900, 75])), {});          // worse is not a crossing
  assert.deepEqual(bandBrackets(hist([100, 100], [500, 75], [600, 100], [900, 75]))[75], [600, 900]);
  assert.deepEqual(bandBrackets(hist([0, 100], [500, 75])), { 75: [0, 500] });
});

test("the multiple is your tonnage over the mean; missing figures give none", () => {
  assert.equal(timesAverage(600, 1000000, 5000), 3);
  assert.equal(timesAverage(50, 1000000, 5000), 0.25);
  for (const a of [[0, 1, 1], [1, 0, 1], [1, 1, 0], [null, 1, 1]]) assert.equal(timesAverage(...a), null);
  assert.equal(standing([smp(600, 25)]).times_average, 3);
  assert.equal(standing([smp(600, 25)], { qty: 4000000 }).times_average, 3);     // never mixes live total with head count
});

test("standing: current sample, next band, hold margin, to-next", () => {
  assert.equal(standing([]), null);
  const s = standing(hist([100, 100], [1800, 50]));
  assert.deepEqual([s.contribution, s.band, s.station, s.system], [1800, 50, "Metz Enterprise", "Ega"]);
  for (const [b, n] of [[100, 75], [75, 50], [50, 25]]) assert.equal(standing([smp(100, b)]).next_band, n);
  const best = standing([smp(100, 25)]);
  assert.equal(best.next_band, null);
  assert.equal(best.est_next, null);
  assert.equal(standing([smp(100, 25, { in_top_rank: true })]).in_top_rank, true);
  assert.equal(standing(hist([100, 100], [500, 75], [900, 75], [1200, 50], [2000, 50])).hold_margin, 800);
  assert.equal(standing([smp(2000, 50)]).hold_margin, null);
  const back = standing(hist([100, 100], [500, 75], [900, 75], [1200, 50], [2500, 25], [1800, 50]));
  assert.deepEqual([back.next_band, back.next_known, back.to_next], [25, true, 700]);
  assert.equal(standing(hist([100, 100], [500, 75], [900, 75], [1200, 50], [2500, 25], [9000, 50])).to_next, 0);
});

test("an unobserved threshold is extrapolated, but not from one bracket, and never above the best band", () => {
  const s = standing(hist([100, 100], [500, 75], [900, 75], [1200, 50]));
  assert.deepEqual([s.next_known, s.to_next], [false, null]);
  assert.equal(s.est_next, Math.trunc(1050 * (1050 / 300)));
  assert.equal(standing(hist([100, 100], [500, 75])).est_next, null);
  assert.equal(standing(hist([100, 100], [500, 75], [900, 75], [1200, 50], [2500, 25])).est_next, null);
});

test("rate, live figures and expiry", () => {
  assert.equal(ratePerHour([smp(1000, 50), smp(2000, 50, { ts: "2025-01-01T14:00:00Z" })]), 500);
  assert.equal(ratePerHour([smp(1000, 50)]), null);
  const s = standing([smp(1000, 50, { total: 800000 })], { qty: 950000, target_qty: 2000000, expiry: "2099-01-01 00:00:00" });
  assert.deepEqual([s.total, s.target], [950000, 2000000]);
  assert.ok(s.hours_left > 0);
  const j = standing([smp(1000, 50, { total: 800000 })]);
  assert.deepEqual([j.total, j.target, j.hours_left], [800000, null, null]);
  assert.ok(standing([smp(1000, 50, { expiry: "2099-01-01T00:00:00Z" })]).hours_left > 0);
  assert.equal(hoursLeft("2025-01-01 12:00:00", Date.parse("2025-01-01T10:00:00Z")), 2);
  assert.equal(hoursLeft("garbage"), null);
});

test("the top-rank and tier fields are read from the journal", () => {
  const line = JSON.stringify({ timestamp: "2025-01-01T12:00:00Z", event: "CommunityGoal", CurrentGoals: [
    { CGID: 859, Title: "W", PlayerContribution: 19363, PlayerPercentileBand: 25, TopRankSize: 10, PlayerInTopRank: false,
      TierReached: "Tier 4", TopTier: { Name: "Tier 8" } }] });
  const [h] = historyFromLines([line]);
  assert.deepEqual([h.top_rank_size, h.in_top_rank, h.tier, h.top_tier], [10, false, "Tier 4", "Tier 8"]);
});

test("the plain-words line", () => {
  const [text] = standingText(standing(hist([100, 100], [500, 75], [9800, 75], [10000, 50], [12480, 50])));
  assert.match(text, /Your contribution 12,480 t · top 50% band \(reached when you passed ~10,000 t\) · tier 4\/8 globally/);
  assert.match(text, /3\.0x|\dx the average/);
  const [top] = standingText(standing([smp(100, 25)]));
  assert.match(top, /not in the top 10/);
  assert.deepEqual(standingText(null), ["", ""]);
});

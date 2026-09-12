#!/usr/bin/env python3
"""
Community goal standing: where you are, and what it takes to move.

Two sources, both free:

  * your journal's CommunityGoal events - your contribution, percentile band,
    tier, and the global total as of your last visit to the board;
  * Frontier's own initiatives feed - live global progress and the expiry,
    which the journal only refreshes when you dock at the CG station.

Reward bands are percentile-based and Frontier publishes no tonnage
thresholds, so boundaries are BRACKETED from your own crossings: the last
contribution recorded in the lower band and the first in the higher one.
That is a measured range, not a prediction, and it is labelled as such.

Standalone:  python3 cg.py
"""

import glob
import json
import os
import time
import urllib.error
import urllib.request

FRONTIER_URL = "https://api.orerve.net/2.0/website/initiatives/list?lang=en"
AGENT = "cgbuy/2.0 (personal ED trade helper)"

# Percentile bands, best first. 100 means "top 100%", i.e. everyone.
BANDS = [10, 25, 50, 75, 100]


def read_history(journal_dir, files=12):
    """Every CommunityGoal sample in recent journals, oldest first."""
    out = []
    logs = sorted(glob.glob(os.path.join(journal_dir, "Journal.*.log")),
                  key=os.path.getmtime)[-files:]
    for f in logs:
        try:
            fh = open(f, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"CommunityGoal"' not in line:
                    continue
                try:
                    e = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                if e.get("event") != "CommunityGoal":
                    continue
                for g in e.get("CurrentGoals", []):
                    out.append({
                        "ts": e.get("timestamp"),
                        "cgid": g.get("CGID"),
                        "title": g.get("Title"),
                        "station": g.get("MarketName"),
                        "system": g.get("SystemName"),
                        "expiry": g.get("Expiry"),
                        "contribution": g.get("PlayerContribution"),
                        "band": g.get("PlayerPercentileBand"),
                        "total": g.get("CurrentTotal"),
                        "contributors": g.get("NumContributors"),
                        "tier": g.get("TierReached"),
                        "top_tier": (g.get("TopTier") or {}).get("Name"),
                        "bonus": g.get("Bonus"),
                        "in_top_rank": g.get("PlayerInTopRank"),
                    })
    return out


def band_brackets(history):
    """{band: (last_seen_below, first_seen_at)} from observed crossings.

    The true threshold lies between those two numbers. Anything we never
    crossed is absent rather than invented.
    """
    samples = [(h["contribution"], h["band"]) for h in history
               if h.get("contribution") is not None and h.get("band") is not None]
    samples.sort()
    brackets = {}
    prev_c, prev_b = None, None
    for c, b in samples:
        if prev_b is not None and b < prev_b:      # smaller band = better
            brackets[b] = (prev_c, c)
        prev_c, prev_b = c, b
    return brackets


def rate_per_hour(history, window=6):
    """Tonnes per hour from the most recent samples."""
    pts = [(h["ts"], h["contribution"]) for h in history
           if h.get("contribution")][-window:]
    if len(pts) < 2:
        return None
    def parse(s):
        try:
            return time.mktime(time.strptime(s, "%Y-%m-%dT%H:%M:%SZ"))
        except (ValueError, TypeError):
            return None
    t0, c0 = parse(pts[0][0]), pts[0][1]
    t1, c1 = parse(pts[-1][0]), pts[-1][1]
    if None in (t0, t1) or t1 <= t0 or c1 <= c0:
        return None
    return (c1 - c0) / ((t1 - t0) / 3600.0)


def fetch_live(timeout=20):
    """Frontier's initiatives feed. Returns [] on any failure - it is
    undocumented and unsupported, so a bad day there must not break us."""
    try:
        req = urllib.request.Request(FRONTIER_URL, headers={"User-Agent": AGENT})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.load(r)
    except (urllib.error.URLError, ValueError, OSError, TimeoutError):
        return []
    out = []
    for it in d.get("activeInitiatives", []) or []:
        commodities = [c.strip() for c in
                       (it.get("target_commodity_list") or "").split(",") if c.strip()]
        def num(k):
            try:
                return int(it.get(k) or 0)
            except (TypeError, ValueError):
                return 0
        out.append({
            "id": it.get("id"), "title": it.get("title"),
            "station": it.get("market_name"), "system": it.get("starsystem_name"),
            "expiry": it.get("expiry"), "activity": it.get("activityType"),
            "commodities": commodities,
            "target_qty": num("target_qty"), "qty": num("qty"),
            # A trade goal names commodities and is typed "tradelist";
            # combat and exploration goals carry neither.
            "is_trade": bool(commodities) and it.get("activityType") == "tradelist",
        })
    return out


def joined_goal(history, live=None):
    """The community goal this commander has actually signed up to.

    The journal records the goals you have joined, including the station and
    system. Pairing that with Frontier's feed (matched on station+system)
    fills in the commodity list, which the journal does not carry.

    Returns a destination dict the app can use directly, or None.
    """
    if not history:
        return None
    cur = history[-1]
    station, system = cur.get("station"), cur.get("system")
    if not station or not system:
        return None

    commodities = []
    for g in (live or []):
        if not g.get("is_trade"):
            continue
        if (g.get("station"), g.get("system")) == (station, system):
            commodities = list(g.get("commodities") or [])
            break

    return {
        "station": station,
        "system": system,
        "commodities": commodities,
        "title": cur.get("title"),
        "expiry": cur.get("expiry"),
        "source": "joined CG" if commodities else "joined CG (no commodity list)",
    }


def suggest_destination(history, live=None):
    """Best destination we can work out without asking.

    1. the goal this commander joined - they are already contributing to it;
    2. failing that, a live trade goal from Frontier's feed, flagged as not
       joined, because a player who has never opened the CG board still wants
       to know where the hauling is;
    3. failing that, nothing, and the user is asked.

    Returns (dest_or_None, alternatives) - alternatives being the other live
    trade goals, so the UI can offer a choice rather than silently picking.
    """
    live = live or []
    trade = [g for g in live if g.get("is_trade")]

    joined = joined_goal(history, live)
    if joined and joined.get("commodities"):
        others = [g for g in trade
                  if (g["station"], g["system"]) != (joined["station"],
                                                     joined["system"])]
        return joined, others

    if trade:
        g = trade[0]
        return {
            "station": g["station"], "system": g["system"],
            "commodities": list(g.get("commodities") or []),
            "title": g.get("title"), "expiry": g.get("expiry"),
            "source": "live CG (not joined)",
        }, trade[1:]

    return None, []


def hours_left(expiry):
    """Hours until an expiry stamp, or None. Frontier uses naive UTC."""
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            t = time.mktime(time.strptime(expiry, fmt)) - time.timezone
            return (t - time.time()) / 3600.0
        except (ValueError, TypeError):
            continue
    return None


def standing(history, live=None):
    """Everything the UI needs about where you stand."""
    if not history:
        return None
    cur = history[-1]
    br = band_brackets(history)
    rate = rate_per_hour(history)

    band = cur.get("band")
    nxt = next((b for b in reversed(BANDS) if band and b < band), None)

    # How far clear of losing the current band: we know the upper end of the
    # bracket we crossed at, so the margin is at least this.
    hold_margin = None
    if band in br:
        hold_margin = cur["contribution"] - br[band][1]

    # Distance to the next band, only if we have evidence for where it starts.
    to_next, next_known = None, False
    if nxt and nxt in br:
        to_next = max(0, br[nxt][1] - cur["contribution"])
        next_known = True

    exp = (live or {}).get("expiry") or cur.get("expiry")
    hrs = hours_left(exp) if exp else None

    # Extrapolate the unobserved next threshold from the gaps between the
    # ones actually crossed. Clearly separate from measured brackets - band
    # boundaries also drift upward as other commanders contribute.
    est_next = None
    if nxt and not next_known and len(br) >= 2:
        mids = {b: (lo + hi) / 2.0 for b, (lo, hi) in br.items()}
        known = sorted(mids)                       # e.g. [50, 75]
        if len(known) >= 2:
            ratio = mids[known[0]] / mids[known[1]]
            if ratio > 1:
                est_next = int(mids[known[0]] * ratio)

    return {
        "est_next": est_next,
        "title": cur.get("title"), "station": cur.get("station"),
        "system": cur.get("system"), "tier": cur.get("tier"),
        "top_tier": cur.get("top_tier"), "bonus": cur.get("bonus"),
        "contribution": cur.get("contribution"), "band": band, "next_band": nxt,
        "contributors": cur.get("contributors"),
        "total": (live or {}).get("qty") or cur.get("total"),
        "target": (live or {}).get("target_qty"),
        "brackets": br, "rate_per_hour": rate,
        "hold_margin": hold_margin, "to_next": to_next, "next_known": next_known,
        "hours_left": hrs, "as_of": cur.get("ts"),
    }


if __name__ == "__main__":
    import journal
    h = read_history(journal.find_journal_dir())
    live = next((g for g in fetch_live() if g["is_trade"]), None)
    s = standing(h, live)
    if not s:
        raise SystemExit("no CommunityGoal events found")
    print("%s" % s["title"])
    print("  %s, %s   tier %s of %s" % (s["station"], s["system"], s["tier"], s["top_tier"]))
    print("  you: %s t   band: top %s%%   of %s contributors"
          % (f"{s['contribution']:,}", s["band"], f"{s['contributors']:,}"))
    if s["total"] and s["target"]:
        print("  goal: %s / %s  (%.1f%%)" % (f"{s['total']:,}", f"{s['target']:,}",
                                             100.0 * s["total"] / s["target"]))
    print("  observed band crossings:")
    for b in sorted(s["brackets"]):
        lo, hi = s["brackets"][b]
        print("     top %-4s between %s and %s t" % ("%d%%" % b, f"{lo:,}", f"{hi:,}"))
    if s["rate_per_hour"]:
        print("  rate while flying: %.0f t/hr" % s["rate_per_hour"])
    if s["hours_left"]:
        d, h = divmod(s["hours_left"], 24)
        print("  time left: %dd %dh" % (d, h))
    if s["hold_margin"] is not None:
        print("  safely inside top %s%%: %s t above where you entered it"
              % (s["band"], f"{s['hold_margin']:,}"))
    if s["next_known"]:
        print("  to reach top %s%%: %s t" % (s["next_band"], f"{s['to_next']:,}"))
    elif s["est_next"]:
        gap = max(0, s["est_next"] - s["contribution"])
        line = ("  top %s%% not yet crossed - extrapolated at ~%s t, so roughly "
                "%s t to go" % (s["next_band"], f"{s['est_next']:,}", f"{gap:,}"))
        print(line)
        if s["rate_per_hour"]:
            print("     ~%.1f h of flying at your current rate"
                  % (gap / s["rate_per_hour"]))
        print("     (extrapolated from your own crossings; real thresholds "
              "drift up as others deliver)")
    else:
        print("  top %s%% threshold: not yet observed" % s["next_band"])

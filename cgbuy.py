#!/usr/bin/env python3
"""
cgbuy.py - find the best places to BUY for the Ega / Metz Enterprise community goal.

Pulls live sell prices from the CG station (EDSM) and live buy prices + supply
from every market near it (Spansh), then ranks sources by what actually matters
for a big hauler: credits per minute and tonnes per minute of round trip.

Usage:
    python3 cgbuy.py                      # default: 784t hold, 30 ly radius
    python3 cgbuy.py --sort tonnes        # optimise for CG rank, not profit
    python3 cgbuy.py --range 15 --top 25
    python3 cgbuy.py --carriers           # include fleet carriers (risky)
"""

import argparse
import json
import math
import sys
import urllib.error
import urllib.request

CG_STATION = "Metz Enterprise"
CG_SYSTEM = "Ega"

# The 12 commodities this CG accepts.
COMMODITIES = [
    "Palladium", "Gold", "Silver", "Bertrandite", "Indite", "Gallite",
    "Coltan", "Uraninite", "Lepidolite", "Cobalt", "Rutile", "Water",
]

SPANSH_SEARCH = "https://spansh.co.uk/api/stations/search"
EDSM_MARKET = ("https://www.edsm.net/api-system-v1/stations/market"
               "?systemName={sys}&stationName={stn}")

UA = {"User-Agent": "cgbuy/1.0 (personal ED trade helper)",
      "Content-Type": "application/json"}


def post_json(url, payload, timeout=45):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers=UA, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def get_json(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": UA["User-Agent"]})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def fetch_cg_prices():
    """Sell prices at the CG station. The CG's 3x multiplier is already
    baked into these numbers, so no need to apply it ourselves."""
    url = EDSM_MARKET.format(sys=CG_SYSTEM.replace(" ", "%20"),
                             stn=CG_STATION.replace(" ", "%20"))
    data = get_json(url)
    prices = {}
    for c in data.get("commodities", []):
        if c["name"] in COMMODITIES:
            prices[c["name"]] = {"sell": c["sellPrice"], "demand": c["demand"]}
    return prices


def fetch_sources(commodity, max_ly, min_supply, page_size=500, max_pages=10):
    """Every market within max_ly of the CG system that stocks `commodity`.

    Spansh caps results per request, so page through until we run past the
    radius. A single fixed page silently drops most candidates - at size=75
    this found 37 Uraninite sources inside 30 ly when there were 105.
    """
    out = []
    for page in range(max_pages):
        payload = {
            "filters": {
                "distance": {"comparison": "<=>", "value": [0, max_ly]},
                "market": [{
                    "name": commodity,
                    "supply": {"comparison": "<=>", "value": [min_supply, 100000000]},
                }],
            },
            "sort": [{"distance": {"direction": "asc"}}],
            "size": page_size,
            "page": page,
            "reference_system": CG_SYSTEM,
        }
        try:
            res = post_json(SPANSH_SEARCH, payload).get("results", [])
        except (urllib.error.URLError, json.JSONDecodeError) as e:
            print(f"  ! lookup failed for {commodity} p{page}: {e}", file=sys.stderr)
            break
        out.extend(res)
        # Sorted by distance, so once the page ends past the radius we are done.
        if len(res) < page_size or res[-1].get("distance", 0) > max_ly:
            break
    return out


def sc_minutes(ls):
    """Rough supercruise time from arrival star, in minutes.
    Calibrated loosely: 100 Ls ~1min, 10k Ls ~4min, 100k Ls ~8min."""
    return 0.25 * max(ls, 1) ** 0.3


def trip_minutes(dist_ly, src_ls, cg_ls, jump_empty, jump_laden):
    """Round trip: CG -> source empty, source -> CG full."""
    out_jumps = math.ceil(dist_ly / jump_empty) if dist_ly > 0 else 0
    back_jumps = math.ceil(dist_ly / jump_laden) if dist_ly > 0 else 0
    jump_time = (out_jumps + back_jumps) * 0.85       # align + charge + scoop
    cruise = sc_minutes(src_ls) * 2 + sc_minutes(cg_ls) * 2
    handling = 6.0                                    # dock, trade, undock, x2
    return jump_time + cruise + handling


def render_mixed(rows, args):
    """Rank stations by the best hold they can actually fill.

    A station's top commodity is often supply-capped well below your hold
    (530t of Gold when you can carry 784t). Topping the rest up with that
    same station's next-best commodity costs no extra travel at all.
    """
    stations = {}
    for r in rows:
        stations.setdefault((r["station"], r["system"]), []).append(r)

    plans = []
    for (stn, sysn), items in stations.items():
        items.sort(key=lambda r: -r["profit_per_t"])
        remaining, total, mix = args.hold, 0, []
        for it in items:
            if remaining <= 0:
                break
            take = min(it["supply"], remaining)
            if take <= 0:
                continue
            mix.append((it["commodity"], take, it["profit_per_t"]))
            total += take * it["profit_per_t"]
            remaining -= take
        if not mix:
            continue
        mins = items[0]["trip_minutes"]
        plans.append({
            "station": stn, "system": sysn, "ly": items[0]["ly"],
            "ls": items[0]["ls"], "carrier": items[0]["carrier"],
            "updated": items[0]["updated"], "tonnes": args.hold - remaining,
            "trip_minutes": mins, "total": total, "cr_per_min": round(total / mins),
            "mix": mix,
        })

    plans.sort(key=lambda p: -p["cr_per_min"])
    plans = plans[:args.top]

    if args.json:
        print(json.dumps(plans, indent=2))
        return

    print(f"\n  Best MIXED loads - one stop, hold topped up with that station's next best")
    print(f"  Hold {args.hold}t | radius {args.max_ly:g} ly\n")
    for i, p in enumerate(plans, 1):
        tag = " [FC]" if p["carrier"] else ""
        print(f"{i:>3}. {p['station']}{tag} - {p['system']}  "
              f"({p['ly']:.1f} ly, {p['ls']:,} Ls, data {p['updated'] or '?'})")
        for c, t, pr in p["mix"]:
            print(f"       {t:>4,}t {c:<12} @ {pr:>8,} cr/t = {t * pr:>13,}")
        short = "" if p["tonnes"] >= args.hold else f"  ({args.hold - p['tonnes']}t short)"
        print(f"       {p['total']:>13,} cr per ~{p['trip_minutes']:.0f} min  "
              f"= {p['cr_per_min']:,} cr/min{short}\n")
    print("  Data age matters: a big supply figure from months ago may be long gone.")


def main():
    ap = argparse.ArgumentParser(
        description="Rank buy locations for the Ega community goal.")
    ap.add_argument("--hold", type=int, default=784,
                    help="cargo capacity in tonnes (default 784, Panther Clipper)")
    ap.add_argument("--range", type=float, default=30.0, dest="max_ly",
                    help="search radius from Ega in ly (default 30)")
    ap.add_argument("--jump-empty", type=float, default=38.0,
                    help="jump range unladen (default 38)")
    ap.add_argument("--jump-laden", type=float, default=18.0,
                    help="jump range with a full hold (default 18)")
    ap.add_argument("--min-supply", type=int, default=200,
                    help="ignore markets stocking less than this (default 200)")
    ap.add_argument("--top", type=int, default=20, help="rows to show (default 20)")
    ap.add_argument("--sort", choices=["credits", "tonnes", "profit"],
                    default="credits",
                    help="credits/min (default), tonnes/min for CG rank, "
                         "or raw profit per tonne")
    ap.add_argument("--carriers", action="store_true",
                    help="include fleet carriers (prices move, data goes stale)")
    ap.add_argument("--mixed", action="store_true",
                    help="rank STATIONS by the best mixed hold they can fill, not "
                         "single commodities (a supply-capped high-value commodity "
                         "topped up with the next best is usually worth ~20%% more)")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    args = ap.parse_args()

    print(f"Fetching {CG_STATION} sell prices...", file=sys.stderr)
    try:
        cg = fetch_cg_prices()
    except Exception as e:
        sys.exit(f"Could not read the CG market from EDSM: {e}")
    if not cg:
        sys.exit("EDSM returned no CG commodities - station or system name changed?")

    # Arrival distance of the CG station itself, for the return leg.
    try:
        stns = get_json(f"https://www.edsm.net/api-system-v1/stations?systemName={CG_SYSTEM}")
        cg_ls = next((s.get("distanceToArrival", 0) for s in stns.get("stations", [])
                      if s["name"] == CG_STATION), 0) or 0
    except Exception:
        cg_ls = 0

    rows = []
    for name in COMMODITIES:
        info = cg.get(name)
        if not info or info["sell"] <= 0:
            print(f"  - {name}: not bought at the CG station right now", file=sys.stderr)
            continue
        sell = info["sell"]
        print(f"  searching {name} (CG pays {sell:,} cr/t)...", file=sys.stderr)

        for st in fetch_sources(name, args.max_ly, args.min_supply):
            if not st.get("has_large_pad"):
                continue
            is_carrier = "Carrier" in str(st.get("type", ""))
            if is_carrier and not args.carriers:
                continue
            entry = next((c for c in st.get("market", [])
                          if c["commodity"] == name), None)
            if not entry or entry["supply"] <= 0 or entry["buy_price"] <= 0:
                continue

            dist = st.get("distance", 0.0)
            if dist > args.max_ly:
                continue
            profit = sell - entry["buy_price"]
            if profit <= 0:
                continue

            load = min(entry["supply"], args.hold)
            src_ls = st.get("distance_to_arrival", 0) or 0
            mins = trip_minutes(dist, src_ls, cg_ls,
                                args.jump_empty, args.jump_laden)
            rows.append({
                "commodity": name,
                "station": st.get("name", "?"),
                "system": st.get("system_name", "?"),
                "carrier": is_carrier,
                "ly": round(dist, 1),
                "ls": round(src_ls),
                "supply": entry["supply"],
                "buy": entry["buy_price"],
                "sell": sell,
                "profit_per_t": profit,
                "load": load,
                "fills_hold": load >= args.hold,
                "loads_available": round(entry["supply"] / args.hold, 1),
                "trip_minutes": round(mins, 1),
                "trip_profit": load * profit,
                "cr_per_min": round(load * profit / mins),
                "t_per_min": round(load / mins, 1),
                "updated": (st.get("market_updated_at") or "")[:10],
            })

    if not rows:
        sys.exit("\nNo viable sources found. Try --range 50 or --min-supply 50.")

    if args.mixed:
        render_mixed(rows, args)
        return

    key = {"credits": "cr_per_min", "tonnes": "t_per_min",
           "profit": "profit_per_t"}[args.sort]
    rows.sort(key=lambda r: r[key], reverse=True)
    rows = rows[:args.top]

    if args.json:
        print(json.dumps(rows, indent=2))
        return

    print(f"\n  CG: {CG_STATION}, {CG_SYSTEM} ({cg_ls:,.0f} Ls from arrival)")
    print(f"  Hold {args.hold}t | radius {args.max_ly:g} ly | "
          f"jump {args.jump_empty:g}/{args.jump_laden:g} ly | sorted by {args.sort}\n")
    # Never truncate system names - you cannot plot a route to "Scorpii Sector G...".
    w_stn = max(len(r["station"]) for r in rows) + 5
    w_sys = max(len(r["system"]) for r in rows) + 2
    hdr = (f"{'COMMODITY':<12}{'STATION':<{w_stn}}{'SYSTEM':<{w_sys}}{'LY':>6}{'LS':>8}"
           f"{'SUPPLY':>9}{'LOADS':>7}{'BUY':>8}{'PROF/T':>8}{'TRIP':>7}"
           f"{'CR/MIN':>10}{'UPDATED':>12}")
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        tag = " [FC]" if r["carrier"] else ""
        loads = r["supply"] / args.hold
        loads_s = f"{loads:.1f}" if loads < 10 else f"{int(loads)}"
        print(f"{r['commodity']:<12}{(r['station'] + tag):<{w_stn}}{r['system']:<{w_sys}}"
              f"{r['ly']:>6.1f}{r['ls']:>8,}{r['supply']:>9,}{loads_s:>7}{r['buy']:>8,}"
              f"{r['profit_per_t']:>8,}{r['trip_minutes']:>6.0f}m"
              f"{r['cr_per_min']:>10,}{r['updated'] or '?':>12}")

    print(f"\n  LOADS = how many full {args.hold}t runs the current supply covers")
    print("  UPDATED = when a commander last reported this market. Supply figures"
          "\n            go stale fast while a CG is draining them.")
    if args.carriers:
        print("  [FC] = fleet carrier: may have jumped away, prices set by owner")
    best = max(rows, key=lambda r: r["cr_per_min"])
    print(f"\n  Best run: {best['load']:,}t of {best['commodity']} from "
          f"{best['station']} ({best['system']}, {best['ly']} ly)")
    print(f"            buy {best['buy']:,} -> sell {best['sell']:,} = "
          f"{best['profit_per_t']:,} cr/t")
    print(f"            ~{best['trip_profit']:,} cr per ~{best['trip_minutes']:.0f} min round trip")
    print("\n  Trip times are estimates. Market data is as recent as the last "
          "commander to dock there.")


if __name__ == "__main__":
    main()

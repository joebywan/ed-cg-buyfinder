#!/usr/bin/env python3
"""
Re-check candidate markets against EDSM.

Spansh is the only practical way to ask "which markets near Ega stock Gold",
but its station index lags by days - it reported 530t of Gold at Lovell
Sanctuary when the real figure was 18t. EDSM ingests EDDN continuously and
publishes a per-station market timestamp, so the shortlist can be corrected
against it before anything is ranked.

Discovery stays on Spansh; the numbers you act on come from EDSM.
"""

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from version import AGENT      # one place; see version.py

EDSM_STATIONS = "https://www.edsm.net/api-system-v1/stations?systemName={sys}"
EDSM_MARKET = ("https://www.edsm.net/api-system-v1/stations/market"
               "?systemName={sys}&stationName={stn}")


# EDSM starts returning 429 after roughly ten rapid requests. Going parallel
# made it look like the data simply did not exist, because the error was
# swallowed as an empty result. Serialise, space the calls out, and retry.
MIN_INTERVAL = 0.8
MAX_RETRIES = 3
CACHE_TTL = 600.0

_last_call = [0.0]
_lock = threading.Lock()
_cache = {}


class RateLimited(Exception):
    pass


def _get(url, timeout=25):
    """Throttled GET. Raises RateLimited if EDSM keeps saying no."""
    backoff = 1.0
    for attempt in range(MAX_RETRIES):
        with _lock:
            wait = MIN_INTERVAL - (time.monotonic() - _last_call[0])
            if wait > 0:
                time.sleep(wait)
            _last_call[0] = time.monotonic()
        req = urllib.request.Request(url, headers={"User-Agent": AGENT})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            if attempt == MAX_RETRIES - 1:
                raise RateLimited("EDSM rate limit")
            time.sleep(backoff)
            backoff *= 2
    raise RateLimited("EDSM rate limit")


def _cached(key, fn):
    hit = _cache.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < CACHE_TTL:
        return hit[1]
    val = fn()
    _cache[key] = (now, val)
    return val


def system_market_times(system):
    """{station name: 'YYYY-MM-DD HH:MM:SS'} for every market in a system.

    Raises RateLimited rather than returning {} - an empty answer and a
    throttled one must not look the same to the caller.
    """
    d = _cached(("sys", system),
                lambda: _get(EDSM_STATIONS.format(sys=urllib.parse.quote(system))))
    out = {}
    for s in d.get("stations", []):
        t = (s.get("updateTime") or {}).get("market")
        if t:
            out[s["name"]] = t
    return out


def system_bodies(system, cached_only=False):
    """{station name: the body it sits on, or the one it orbits}.

    Spansh records a body only for stations on a surface. The parent body of
    an orbital starport is in neither its station index nor its system dump,
    so the one source the search already uses cannot answer "what am I
    docking at". EDSM records it for both kinds, in the very payload
    system_market_times already reads - so for a system that has been
    verified this costs nothing at all.

    `cached_only` answers from what has already been fetched and returns None
    rather than going to the network, so a caller can show what it knows
    before deciding whether the question is worth a request.
    """
    key = ("sys", system)
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_TTL:
        data = hit[1]
    elif cached_only:
        return None
    else:
        data = _cached(key, lambda: _get(
            EDSM_STATIONS.format(sys=urllib.parse.quote(system))))
    out = {}
    for st in data.get("stations", []) or []:
        body = (st.get("body") or {}).get("name")
        if body:
            out[st["name"]] = body
    return out


def station_market(system, station):
    """{commodity: {buy, supply, sell, demand}} from EDSM."""
    d = _cached(("mkt", system, station),
                lambda: _get(EDSM_MARKET.format(sys=urllib.parse.quote(system),
                                                stn=urllib.parse.quote(station))))
    return {c["name"]: {"buy": c.get("buyPrice", 0), "supply": c.get("stock", 0),
                        "sell": c.get("sellPrice", 0), "demand": c.get("demand", 0)}
            for c in d.get("commodities", [])}


def refresh(rows, top=14, progress=None, budget=40):
    """Correct the best few rows in place using EDSM.

    Deliberately narrow: EDSM throttles hard, so only the handful of stations
    you might actually fly to are re-checked. `budget` caps total requests so
    one search cannot exhaust the rate limit. Returns
    (stations_checked, rows_corrected, rate_limited).
    """
    ranked = sorted(rows, key=lambda r: -r["cr_per_min"])
    stations, seen = [], set()
    for r in ranked:
        key = (r["system"], r["station"])
        if key not in seen:
            seen.add(key)
            stations.append(key)
        if len(stations) >= top:
            break

    spansh_dates = {}
    for r in rows:
        spansh_dates.setdefault((r["system"], r["station"]), r.get("updated", ""))

    times, markets = {}, {}
    spent = 0
    limited = False

    for sysname, station in stations:
        if spent >= budget:
            break
        try:
            if sysname not in times:
                times[sysname] = system_market_times(sysname)
                spent += 1
            edsm_time = times[sysname].get(station)
            if not edsm_time:
                continue          # EDSM has no market record for this station
            # Only spend a request when EDSM is actually fresher than what
            # Spansh already told us. Saves most of the rate-limit budget.
            spansh_time = spansh_dates.get((sysname, station), "")
            if spansh_time and edsm_time[:10] < spansh_time[:10]:
                continue
            markets[(sysname, station)] = station_market(sysname, station)
            spent += 1
        except RateLimited:
            limited = True
            break
        except (urllib.error.URLError, ValueError, OSError, TimeoutError):
            continue              # one bad station must not stop the rest
        if progress:
            progress(len(markets), len(stations))

    corrected = 0
    for r in rows:
        key = (r["system"], r["station"])
        m = markets.get(key)
        r["edsm"] = False
        if not m:
            continue
        entry = m.get(r["commodity"])
        if not entry:
            continue
        r["edsm"] = True
        r["updated"] = (times[r["system"]][r["station"]] or "")[:10]
        if entry["supply"] != r["supply"] or entry["buy"] != r["buy"]:
            corrected += 1
        r["supply"] = entry["supply"]
        r["buy"] = entry["buy"]
    return len(markets), corrected, limited


if __name__ == "__main__":
    t = system_market_times("Scorpii Sector FM-V b2-7")
    print("market times:", json.dumps(t, indent=2))
    m = station_market("Scorpii Sector FM-V b2-7", "Lovell Sanctuary")
    for c in ("Gold", "Silver"):
        print(" ", c, m.get(c))


# --------------------------------------------------------------------------
# lookups for the destination picker
# --------------------------------------------------------------------------

SPANSH_SYSTEMS = ("https://spansh.co.uk/api/systems/field_values/"
                  "system_names?q={q}")


def suggest_systems(prefix, limit=12):
    """System names matching a typed prefix. [] on any failure."""
    prefix = (prefix or "").strip()
    if len(prefix) < 2:
        return []
    try:
        d = _get(SPANSH_SYSTEMS.format(q=urllib.parse.quote(prefix)), timeout=12)
    except Exception:
        return []
    vals = d.get("values") if isinstance(d, dict) else d
    return list(vals or [])[:limit]


def market_stations(system):
    """Stations in a system that actually have a commodity market.

    Returns dicts with name, type, arrival distance and how recently the
    market was reported, so the picker can show what it is choosing between.
    """
    try:
        d = _get(EDSM_STATIONS.format(sys=urllib.parse.quote(system)), timeout=20)
    except Exception:
        return []
    out = []
    for s in d.get("stations", []) or []:
        if not s.get("haveMarket"):
            continue
        out.append({
            "name": s.get("name", "?"),
            "type": s.get("type") or "?",
            "ls": s.get("distanceToArrival") or 0,
            "updated": ((s.get("updateTime") or {}).get("market") or "")[:10],
        })
    out.sort(key=lambda x: x["ls"])
    return out

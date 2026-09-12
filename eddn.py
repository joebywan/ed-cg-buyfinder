#!/usr/bin/env python3
"""
EDDN uploader - contribute market data back to the network.

Everything this tool reads (EDSM, Spansh, Inara) ultimately comes from
commanders running uploaders. This sends your own market snapshots back so
the next person does not get a two-day-old supply figure.

Only commodity market data is sent: system, station, and the price/stock
table the game already wrote to Market.json. Your commander name is the
uploader ID, exactly as EDMC and every other uploader does it.

Standalone check:  python3 eddn.py --dry-run
"""

import gzip
import json
import os
import urllib.error
import urllib.request

EDDN_URL = "https://eddn.edcd.io:4430/upload/"
SCHEMA = "https://eddn.edcd.io/schemas/commodity/3"
SOFTWARE = "cgbuy"
VERSION = "2.0"

# Limpets/drones are not tradeable market goods and must not be sent.
NON_MARKET_NAMES = {"drones"}
NON_MARKET_CATEGORIES = {"nonmarketable"}

# Exactly what the commodity/3 schema permits per entry. It sets
# additionalProperties=false, so one stray key rejects the whole message.
ALLOWED_COMMODITY_KEYS = {
    "name", "meanPrice", "buyPrice", "stock", "stockBracket", "sellPrice",
    "demand", "demandBracket", "statusFlags", "Producer", "Rare", "id",
}
REQUIRED_COMMODITY_KEYS = {
    "name", "meanPrice", "buyPrice", "stock", "stockBracket", "sellPrice",
    "demand", "demandBracket",
}
REQUIRED_MESSAGE_KEYS = {
    "systemName", "stationName", "marketId", "timestamp", "commodities",
}
ALLOWED_MESSAGE_KEYS = REQUIRED_MESSAGE_KEYS | {
    "stationType", "horizons", "odyssey", "economies", "prohibited",
    "carrierDockingAccess",
}


def norm_name(raw):
    """'$gold_name;' -> 'gold'.  Already-plain names pass through."""
    n = (raw or "").strip().lower()
    if n.startswith("$"):
        n = n[1:]
    if n.endswith(";"):
        n = n[:-1]
    if n.endswith("_name"):
        n = n[:-5]
    return n


def build_message(market, commander, horizons, odyssey):
    """Turn a Market.json dict into an EDDN commodity/3 message."""
    commodities = []
    for it in market.get("Items", []):
        name = norm_name(it.get("Name"))
        category = norm_name(it.get("Category", "")).replace("market_category_", "")
        # Send the station's whole price table. Filtering to only what is in
        # stock would throw away the sell-side data other commanders need.
        if not name or name in NON_MARKET_NAMES:
            continue
        if category in NON_MARKET_CATEGORIES:
            continue
        entry = {
            "name": name,
            "meanPrice": int(it.get("MeanPrice", 0)),
            "buyPrice": int(it.get("BuyPrice", 0)),
            "stock": int(it.get("Stock", 0)),
            "stockBracket": it.get("StockBracket", 0),
            "sellPrice": int(it.get("SellPrice", 0)),
            "demand": int(it.get("Demand", 0)),
            "demandBracket": it.get("DemandBracket", 0),
        }
        if it.get("Rare"):
            entry["statusFlags"] = ["Rare"]
        commodities.append(entry)

    for required in ("StarSystem", "StationName", "MarketID", "timestamp"):
        if market.get(required) in (None, ""):
            raise ValueError("Market.json missing %s" % required)
    msg = {
        "systemName": market["StarSystem"],
        "stationName": market["StationName"],
        "marketId": market["MarketID"],
        "timestamp": market["timestamp"],
        "commodities": commodities,
    }
    if market.get("StationType"):
        msg["stationType"] = market["StationType"]
    if horizons is not None:
        msg["horizons"] = bool(horizons)
    if odyssey is not None:
        msg["odyssey"] = bool(odyssey)

    return {
        "$schemaRef": SCHEMA,
        "header": {
            "uploaderID": commander or "unknown",
            "softwareName": SOFTWARE,
            "softwareVersion": VERSION,
        },
        "message": msg,
    }


def add_gameversion(envelope, gameversion, gamebuild):
    """EDDN uses these to keep Live and Legacy data apart."""
    if gameversion:
        envelope["header"]["gameversion"] = gameversion
    if gamebuild:
        envelope["header"]["gamebuild"] = gamebuild
    return envelope


def validate(envelope):
    """Catch schema violations locally rather than having EDDN reject them."""
    problems = []
    msg = envelope.get("message", {})
    missing = REQUIRED_MESSAGE_KEYS - set(msg)
    if missing:
        problems.append("message missing %s" % sorted(missing))
    extra = set(msg) - ALLOWED_MESSAGE_KEYS
    if extra:
        problems.append("message has undeclared %s" % sorted(extra))
    for h in ("uploaderID", "softwareName", "softwareVersion"):
        if not envelope.get("header", {}).get(h):
            problems.append("header missing %s" % h)
    for i, c in enumerate(msg.get("commodities", [])[:400]):
        miss = REQUIRED_COMMODITY_KEYS - set(c)
        if miss:
            problems.append("commodity %d missing %s" % (i, sorted(miss)))
            break
        bad = set(c) - ALLOWED_COMMODITY_KEYS
        if bad:
            problems.append("commodity %d undeclared %s" % (i, sorted(bad)))
            break
        for k in ("meanPrice", "buyPrice", "stock", "sellPrice", "demand"):
            if not isinstance(c[k], int):
                problems.append("commodity %d %s is %s" % (i, k, type(c[k]).__name__))
                break
    if not msg.get("commodities"):
        problems.append("no commodities")
    return problems


def upload(envelope, timeout=20):
    """POST to EDDN. Returns (ok, detail)."""
    body = gzip.compress(json.dumps(envelope).encode("utf-8"))
    req = urllib.request.Request(
        EDDN_URL, data=body, method="POST",
        headers={"Content-Type": "application/json",
                 "Content-Encoding": "gzip",
                 "User-Agent": "%s/%s" % (SOFTWARE, VERSION)})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, "%s %s" % (r.status, r.read(200).decode("utf-8", "replace").strip())
    except urllib.error.HTTPError as e:
        return False, "HTTP %s: %s" % (e.code, e.read(400).decode("utf-8", "replace").strip())
    except (urllib.error.URLError, OSError) as e:
        return False, str(e)


class Sender:
    """Tracks what has already been sent so we never duplicate a snapshot."""

    MAX_SEEN = 400

    def __init__(self, seen=None):
        self.order = [tuple(x) for x in (seen or [])][-self.MAX_SEEN:]
        self.seen = set(self.order)
        self.sent = 0
        self.failed = 0
        self.last = ""

    def to_list(self):
        return [list(x) for x in self.order[-self.MAX_SEEN:]]

    def maybe_send(self, market_path, commander, horizons, odyssey,
                   gameversion=None, gamebuild=None, dry_run=False):
        try:
            with open(market_path, encoding="utf-8", errors="replace") as fh:
                market = json.load(fh)
        except (OSError, ValueError) as e:
            return False, "cannot read Market.json: %s" % e

        key = (market.get("MarketID"), market.get("timestamp"))
        if None in key:
            return False, "Market.json missing MarketID/timestamp"
        if key in self.seen:
            return False, "already sent"

        try:
            env = add_gameversion(
                build_message(market, commander, horizons, odyssey),
                gameversion, gamebuild)
        except (ValueError, TypeError, KeyError) as e:
            self.failed += 1
            self.last = "bad market data: %s" % e
            return False, self.last
        problems = validate(env)
        if problems:
            self.failed += 1
            self.last = "invalid: %s" % problems[0]
            return False, self.last
        n = len(env["message"]["commodities"])

        if dry_run:
            self.last = "DRY RUN %s (%d items)" % (market["StationName"], n)
            return True, self.last

        ok, detail = upload(env)
        if ok:
            self.seen.add(key)
            self.order.append(key)
            if len(self.order) > self.MAX_SEEN:
                drop = self.order[:-self.MAX_SEEN]
                del self.order[:-self.MAX_SEEN]
                self.seen.difference_update(drop)
            self.sent += 1
            self.last = "sent %s (%d items)" % (market["StationName"], n)
        else:
            self.failed += 1
            self.last = "failed: %s" % detail[:80]
        return ok, self.last

    def summary(self):
        if not self.sent and not self.failed:
            return "EDDN idle"
        return "EDDN %d sent%s" % (self.sent,
                                   ", %d failed" % self.failed if self.failed else "")


if __name__ == "__main__":
    import sys, journal
    d = journal.find_journal_dir()
    mp = os.path.join(d, "Market.json")
    m = json.load(open(mp, encoding="utf-8", errors="replace"))
    env = add_gameversion(build_message(m, "TestCmdr", True, True),
                          "4.4.1.1", "r332841/r0")
    print("station :", env["message"]["stationName"], "/", env["message"]["systemName"])
    print("items   :", len(env["message"]["commodities"]), "of", len(m["Items"]), "raw")
    print("sample  :", json.dumps(env["message"]["commodities"][0]))
    print("header  :", json.dumps(env["header"]))
    if "--dry-run" not in sys.argv:
        print("\n(not uploading; pass nothing but --dry-run is the default here)")

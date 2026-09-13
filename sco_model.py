#!/usr/bin/env python3
"""
When to cut supercruise overcharge: a braking-distance law, fitted.

Two earlier attempts here were wrong and are worth recording so they are not
retried. The first assumed constant acceleration and braking; captured HUD
traces killed it, because under overcharge the speed goes 0.35c -> 10c -> 70c
in five seconds and then only 16c -> 106c in the next 2.6, saturating toward a
cap rather than accelerating uniformly. The second replaced it with a constant
"seconds to target" ratio; that survives only if braking distance is
proportional to speed, and the observations exclude that outright - fitting
`brake = A * v^p` against every captured approach admits no exponent above
0.84, and a commander cutting at a 1-2s countdown on a 35,000 Ls leg ended up
so slow the drive had to be relit.

What the data supports is that the distance needed to shed speed grows much
more slowly than the speed does. So the cut is expressed as a RANGE TO RUN,
not a countdown:

    cut when range to target (Ls)  >=  A * speed(c) ** p

The ship's own numbers live in sco_table.json. The defaults below are the
Panther Clipper Mk II's, and p = 0.5 is chosen over the flatter fits on safety
grounds: it and a constant distance both fit the observations, they diverge
five-fold at 2,000c, and the conservative one merely wastes time while the
other overshoots.

The app cannot learn any of this by watching. Elite writes neither speed nor
range to target into any file - they exist only on screen - which is why
tools/ contains a capture rig and this module contains a fit rather than a
measurement.

Standalone-testable:  python3 sco_model.py
"""

import json
import math
import os

# Panther Clipper Mk II, from nine captured approaches. Used when a hull has
# no row of its own, which makes it a guess for any other ship - a lighter one
# will differ and none has been measured.
FALLBACK = {"a": 30.0, "p": 0.5}

TABLE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sco_table.json")


def load_table(path=TABLE):
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def terms(ship, table=None, path=TABLE):
    """The braking law for a hull: its coefficients and how well they are known."""
    table = load_table(path) if table is None else table
    row = (table.get("ships") or {}).get((ship or "").lower()) or {}
    law = row.get("law")
    if law and law.get("a") and law.get("p") is not None:
        return {"a": float(law["a"]), "p": float(law["p"]),
                "source": row.get("source", "measured"), "ship": ship,
                "samples": row.get("samples"),
                "bracket": row.get("bracket")}
    fb = (table.get("fallback") or {}).get("law") or FALLBACK
    return {"a": float(fb.get("a", FALLBACK["a"])),
            "p": float(fb.get("p", FALLBACK["p"])),
            "source": "estimate", "ship": ship, "samples": None,
            "bracket": None}


def brake_distance(speed_c, a=None, p=None):
    """Light seconds needed to shed `speed_c` before the drop. None if absurd."""
    try:
        speed_c = float(speed_c)
    except (TypeError, ValueError):
        return None
    if speed_c <= 0:
        return None
    a = FALLBACK["a"] if a is None else a
    p = FALLBACK["p"] if p is None else p
    return a * speed_c ** p


def cut_range(speed_c, ship=None, table=None, path=TABLE, margin=1.15):
    """Range to run at which to cut, for this ship at this speed.

    The margin is small and deliberate. Cutting late overshoots and costs a
    loop back; cutting early bleeds speed too soon and, far out, can leave the
    ship so slow the drive has to be relit. Neither side is free, so this sits
    just above the boundary rather than well clear of it.
    """
    t = terms(ship, table, path)
    d = brake_distance(speed_c, t["a"], t["p"])
    return None if d is None else d * margin


def plan(ship=None, table=None, path=TABLE,
         speeds=(70, 150, 250, 500, 1000, 2000)):
    """A small speed -> range table, which is the usable form in a cockpit.

    A formula is not readable mid-burn. Both numbers are already on the HUD
    panel, so the pilot matches the row to the speed and watches the range.
    """
    return [(v, cut_range(v, ship, table, path)) for v in speeds]


def fit(observations, exponents=None, bounds=(), tolerance=0.0):
    """Coefficients admitted by (range_at_cut, speed_at_cut, overshot) records.

    `bounds` are (speed_c, max_needed_ls) pairs from approaches that were cut
    so early the ship had to relight the drive: they say the required distance
    at that speed is below what was flown, which is the only thing holding the
    exponent down at high speed. Without at least one of them the fit admits
    exponents above 1, i.e. a constant seconds-to-target - so the case against
    that rule rests on those bounds, and the caller has to supply them
    knowingly rather than get the conclusion for free.

    `tolerance` allows an observation to sit the wrong side of the line by a
    fraction of its range, for laws that fit every point but one marginally.

    Returns the envelope rather than a single answer: with no overshoot
    recorded at high speed nothing pins the exponent from below, and honest
    error bars beat a confident number in the middle of them.
    """
    obs = [(float(d), float(v), bool(o)) for d, v, o in observations]
    if not obs:
        return None
    ok = []
    for pi in (exponents or range(0, 151)):
        p = pi / 100.0
        for ai in range(1, 4000):
            a = ai / 10.0
            if any(a * v ** p >= limit for v, limit in bounds):
                continue
            if all((d >= a * v ** p * (1.0 - tolerance)) != o for d, v, o in obs):
                ok.append((a, p))
    if not ok:
        return None
    return {"fits": len(ok), "p_min": min(p for _, p in ok),
            "p_max": max(p for _, p in ok),
            "envelope": lambda v: (min(a * v ** p for a, p in ok),
                                   max(a * v ** p for a, p in ok))}


def summary(ship, speed_c=None, table=None, path=TABLE):
    """One line: what to do, and how much to trust it."""
    t = terms(ship, table, path)
    if speed_c:
        d = cut_range(speed_c, ship, table, path)
        return "cut SCO with %s%.0f Ls to run at %.0fc%s" % (
            "" if t["source"] == "measured" else "~", d, speed_c,
            "" if t["source"] == "measured" else " (estimate)")
    rows = plan(ship, table, path, speeds=(70, 250, 1000))
    return "cut SCO at %s Ls to run (%s)" % (
        " / ".join("%.0f@%dc" % (d, v) for v, d in rows), t["source"])


if __name__ == "__main__":
    for v, d in plan("panthermkii"):
        print("%6dc  cut with %6.0f Ls to run  (countdown %.2fs)" % (v, d, d / v))
    print()
    print(summary("panthermkii"))
    print(summary("sidewinder", 250))

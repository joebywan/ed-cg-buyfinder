#!/usr/bin/env python3
"""
Elite Dangerous journal watching + trip-time calibration.

The default trip model is guesswork (0.85 min/jump, 6 min docking, a
supercruise curve fitted by eye). This module replaces those guesses with
what actually happened in your own journals, and keeps learning as you fly.

Standalone-testable:  python3 journal.py
"""

import calendar
import glob
import json
import math
import os
import statistics
import time

# Where Elite writes journals. On Windows it is a fixed spot under the user
# profile (possibly redirected into OneDrive); under Proton it lives inside the
# game's prefix, and the Steam library may be on any mounted drive.
_WIN_TAIL = "Saved Games/Frontier Developments/Elite Dangerous"
_PROTON_TAIL = ("steamapps/compatdata/359320/pfx/drive_c/users/steamuser/"
                "Saved Games/Frontier Developments/Elite Dangerous")

JOURNAL_GLOBS = [
    "~/" + _WIN_TAIL,
    # OneDrive silently redirects the profile folders on many Windows setups.
    "~/OneDrive/" + _WIN_TAIL,
    os.path.join(os.environ.get("USERPROFILE", "~"), _WIN_TAIL),
    "~/.local/share/Steam/steamapps/compatdata/359320/pfx/drive_c/users/steamuser/Saved Games/Frontier Developments/Elite Dangerous",
    "~/.steam/steam/steamapps/compatdata/359320/pfx/drive_c/users/steamuser/Saved Games/Frontier Developments/Elite Dangerous",
    "/media/*/SteamLibrary/steamapps/compatdata/359320/pfx/drive_c/users/steamuser/Saved Games/Frontier Developments/Elite Dangerous",
    "/mnt/*/SteamLibrary/steamapps/compatdata/359320/pfx/drive_c/users/steamuser/Saved Games/Frontier Developments/Elite Dangerous",
    # Steam libraries on other drive letters (Windows) or mounts.
    "?:/SteamLibrary/" + _PROTON_TAIL,
    "?:/Program Files (x86)/Steam/" + _PROTON_TAIL,
]


def find_journal_dir(override=None):
    """Locate the journal directory, newest-journal-wins if several match."""
    if override and os.path.isdir(override):
        return override
    best, best_mtime = None, -1
    seen = set()
    for pattern in JOURNAL_GLOBS:
        if pattern in seen:             # USERPROFILE collapses to ~ off Windows
            continue
        seen.add(pattern)
        for d in glob.glob(os.path.expanduser(pattern)):
            logs = glob.glob(os.path.join(d, "Journal.*.log"))
            if not logs:
                continue
            m = max(os.path.getmtime(f) for f in logs)
            if m > best_mtime:
                best, best_mtime = d, m
    return best


def parse_ts(s):
    """Journal timestamps are ISO-8601 Zulu, returned as a true UTC epoch.

    time.mktime would read the struct as local time. Every existing caller
    subtracts two of these, so the timezone cancelled and nothing was visibly
    wrong - except across a DST boundary, where it silently added an hour to a
    jump. It matters now regardless: Status.json transitions are stamped with
    the wall clock, and the two have to be comparable.
    """
    try:
        return calendar.timegm(time.strptime(s, "%Y-%m-%dT%H:%M:%SZ"))
    except (ValueError, TypeError):
        return None


def sco_band(ls):
    """Approaches only compare to each other when they are the same shape.

    Under about a thousand light seconds the whole approach happens inside the
    arrival star's gravity well, where the speed cap is low and the overcharge
    has little room to do anything. Past twenty thousand the cruise dominates
    and the drive can run for a long time. The middle is where the interesting
    trade-off lives.
    """
    if ls < 1000:
        return "short"
    if ls < 20000:
        return "mid"
    return "long"


class Calibration:
    """Measured trip timings, learned from journal events.

    Every value is None until enough real samples exist; callers fall back to
    the estimate in that case. We keep raw samples so the medians stay honest
    as more data arrives.
    """

    MIN_SAMPLES = 3        # below this, one weird run would skew everything
    MAX_SAMPLES = 200      # keep the medians cheap and the config small

    def _add(self, lst, value):
        lst.append(value)
        if len(lst) > self.MAX_SAMPLES:
            del lst[:-self.MAX_SAMPLES]

    def __init__(self, data=None):
        d = data or {}
        self.jump_secs = list(d.get("jump_secs", []))[-200:]
        self.dock_secs = list(d.get("dock_secs", []))[-200:]
        # Undocked -> first FSDJump: launch, clear mass lock, align, charge.
        # Mechanical and low variance, unlike time spent sitting on the pad.
        self.depart_secs = list(d.get("depart_secs", []))[-200:]
        # Deliberately NOT loaded from config: earlier versions paired each
        # supercruise duration with the arrival distance of the previously
        # docked station, which is unrelated. Those samples are unusable.
        self.sc_samples = []
        # FSDJump -> Docked: the whole arrival leg (supercruise + approach +
        # docking). SupercruiseEntry is not always journalled, but this is.
        self.approach_samples = [tuple(x) for x in d.get("approach_samples", [])][-200:]
        # (arrival_Ls, jump->drop seconds, seconds of overcharge, seconds from
        # the start of the approach to the drive first lighting, ship). Only
        # recorded when Status.json was being watched for the whole approach,
        # so an absent SCO reading means "not observed", never "not used".
        #
        # Keyed by ship because approach behaviour is a property of the hull,
        # not the commander. Samples written before that was understood carry
        # no ship and are padded with None rather than being credited to
        # whatever happens to be in the bay now.
        self.sco_samples = [(tuple(x) + (None,))[:5] if len(x) < 5 else tuple(x)
                            for x in d.get("sco_samples", [])][-200:]

    def to_dict(self):
        return {"jump_secs": self.jump_secs, "dock_secs": self.dock_secs,
                "depart_secs": self.depart_secs,
                "approach_samples": self.approach_samples,
                "sco_samples": self.sco_samples}

    # -- learned values, or None when we don't have the evidence -----------
    @property
    def jump_minutes(self):
        """Median seconds for one full route jump (jump-to-jump), in minutes."""
        if len(self.jump_secs) < self.MIN_SAMPLES:
            return None
        return statistics.median(self.jump_secs) / 60.0

    @property
    def dock_minutes(self):
        """Deliberately not used for estimates.

        Docked -> Undocked cannot tell trading apart from being away from the
        keyboard, and the window that keeps an overnight AFK out of the median
        also throws away genuine long stops. Samples are still collected so
        the figure can be shown, but the trip model uses a fixed turnaround.
        """
        if len(self.dock_secs) < self.MIN_SAMPLES:
            return None
        return statistics.median(self.dock_secs) / 60.0

    @property
    def depart_minutes(self):
        """Median time from leaving the pad to the first jump, in minutes."""
        if len(self.depart_secs) < self.MIN_SAMPLES:
            return None
        return statistics.median(self.depart_secs) / 60.0

    @property
    def sc_scale(self):
        """Multiplier on the estimated supercruise curve.

        Each sample is (arrival_Ls, observed_seconds). We compare observed
        against the model and take the median ratio, so one 500,000 Ls outlier
        cannot dominate. Falls back to arrival-leg samples, which are logged
        far more reliably than SupercruiseEntry.
        """
        pool = self.approach_samples
        if len(pool) < self.MIN_SAMPLES:
            return None
        ratios = []
        for ls, secs in pool:
            model = est_sc_minutes(ls) * 60.0
            if model > 0:
                ratios.append(secs / model)
        if len(ratios) < self.MIN_SAMPLES:
            return None
        return statistics.median(ratios)

    # An arrival leg is mostly fixed cost - drop, approach, request docking,
    # land - with a travel term on top. One multiplier on a distance curve
    # cannot fit both ends of that: on the journals this was written against,
    # two stations 15x apart in arrival distance were 18% apart in time, and
    # the single ratio that "fitted" them was 22% low at one and 57% high at
    # the other. Fitting the constant and the travel term separately gets
    # both, which matters because the destination's own arrival leg is paid
    # on every single run.
    ARRIVAL_MIN_SPREAD = 3.0        # furthest/nearest sampled Ls, to fit at all

    @property
    def arrival_fit(self):
        """(a, b, lo, hi): arrival seconds as a + b * Ls**0.3, and the range
        of arrival distances actually flown to learn it. None when the
        samples cannot support a fit.

        Bucketed by distance and fitted on the bucket medians, so a station
        farmed for a hundred runs does not outvote one visited twice, and one
        interdicted approach does not bend the line.
        """
        pool = self.approach_samples
        if len(pool) < self.MIN_SAMPLES:
            return None
        buckets = {}
        for ls, secs in pool:
            # Half-decade buckets: near enough to the same station to share a
            # median, far enough apart to be a different distance.
            buckets.setdefault(round(math.log10(max(ls, 1)) * 2), []).append((ls, secs))
        if len(buckets) < 2:
            return None
        pts = [(statistics.median(l for l, _s in g) ** 0.3,
                statistics.median(s for _l, s in g)) for g in buckets.values()]
        lo = min(ls for ls, _s in pool)
        hi = max(ls for ls, _s in pool)
        if lo <= 0 or hi / lo < self.ARRIVAL_MIN_SPREAD:
            return None
        n = len(pts)
        mx = sum(x for x, _y in pts) / n
        my = sum(y for _x, y in pts) / n
        var = sum((x - mx) ** 2 for x, _y in pts)
        if var <= 0:
            return None
        b = sum((x - mx) * (y - my) for x, y in pts) / var
        # A negative travel term is noise, not a discount for flying further.
        b = max(b, 0.0)
        a = my - b * mx
        if a < 0:
            return None
        return a, b, lo, hi

    def arrival_minutes(self, ls):
        """Measured arrival leg for a station this far out, in minutes, or
        None when there is nothing measured to go on.

        Inside the range actually flown this is measurement. Outside it the
        fit is extended by the shape of the estimate curve rather than by its
        own slope: samples from 350 and 5,000 Ls say nothing about what
        40,000 Ls costs, and a straight line through them will cheerfully
        claim it is quick.
        """
        fit = self.arrival_fit
        if not fit:
            return None
        a, b, lo, hi = fit
        anchor = min(max(float(ls), lo), hi)
        secs = a + b * anchor ** 0.3
        if abs(anchor - ls) > 1e-9:
            secs += (est_sc_minutes(ls) - est_sc_minutes(anchor)) * 60.0
        return max(secs, 0.0) / 60.0

    def add_sco_sample(self, ls, total_secs, sco_secs, lit_after, ship=None):
        """Record one approach and how the overcharge was used flying it."""
        self._add(self.sco_samples,
                  (round(float(ls), 1), round(float(total_secs), 1),
                   round(float(sco_secs), 1),
                   None if lit_after is None else round(float(lit_after), 1),
                   (ship or "").lower() or None))

    def sco_advice(self, ls, ship=None):
        """What overcharge burn produced your fastest arrival at this range.

        No physics and no model. The game publishes neither speed nor range to
        target, so the only honest handle on overshoot is the clock: a loop
        back to the station shows up as a long jump-to-drop time, and the burn
        that avoids it is whichever one your own fastest arrival used.

        Returns None until there is something to say. `spread` counts how many
        distinct burn lengths have been tried, because a single habit repeated
        twenty times is twenty samples of one data point - it says what you
        always do, not what works.
        """
        band = sco_band(ls)
        pool = [s for s in self.sco_samples if sco_band(s[0]) == band]
        if ship:
            # A Panther's approach says nothing about a Cobra's. Only fall back
            # to the mixed pool when this hull has nothing of its own, and even
            # then the caller can tell from `ship_specific`.
            mine = [s for s in pool if s[4] == (ship or "").lower()]
            pool = mine if len(mine) >= self.MIN_SAMPLES else pool
        if len(pool) < self.MIN_SAMPLES:
            return None
        best = min(pool, key=lambda s: s[1])
        worst = max(pool, key=lambda s: s[1])
        spread = len({round(s[2] / 2.0) for s in pool})
        ships = {s[4] for s in pool}
        return {"band": band, "hold": best[2], "total": best[1],
                "lit_after": best[3], "worst": worst[1], "worst_hold": worst[2],
                "n": len(pool), "spread": spread,
                "ship_specific": bool(ship) and ships == {(ship or "").lower()}}

    def summary(self):
        bits = []
        j, d, s = self.jump_minutes, self.dock_minutes, self.sc_scale
        bits.append("jump %s" % ("%.2f min (n=%d)" % (j, len(self.jump_secs))
                                 if j else "estimate (n=%d)" % len(self.jump_secs)))
        dep = self.depart_minutes
        bits.append("departure %s" % ("%.1f min (n=%d)" % (dep, len(self.depart_secs))
                                      if dep else "estimate (n=%d)"
                                      % len(self.depart_secs)))
        bits.append("station stop %s (not used: fixed 2 min turnaround)"
                    % ("%.1f min median" % d if d else "no samples"))
        n_sc = len(self.approach_samples)
        fit = self.arrival_fit
        if fit:
            bits.append("arrival leg %.1f min + travel, %.0f-%.0f Ls (n=%d)"
                        % (fit[0] / 60.0, fit[2], fit[3], n_sc))
        else:
            bits.append("supercruise %s" % ("x%.2f (n=%d)" % (s, n_sc)
                                            if s else "estimate (n=%d)" % n_sc))
        return "  |  ".join(bits)


def run_minutes(log, station, min_samples=3, window=6, turnaround=2.0):
    """Median run as actually flown: pad to pad at `station`, counting only
    the part spent flying, plus a flat `turnaround` at each end.

    Returns (minutes, runs counted), or (None, 0).

    Wall-clock dock-to-dock was the obvious measure and the wrong one. Time
    parked is not piloting, and Docked -> Undocked cannot tell restocking
    from making a cup of tea, so an hour on the pad turned a 14-minute run
    into a 102-minute one and the estimate built on it was useless. The trip
    model already takes this view - it prices every stop at a flat two
    minutes - so measuring the same shape keeps the two comparable, and the
    figure moves when the flying does.

    A run needs a stop somewhere else in the middle: undocking and docking
    again at the same pad is a repair, not a round trip.

    Anything over four hours of flight is a session break - a log-out in
    supercruise - rather than a very slow run.
    """
    marks = [i for i, (kind, stn, _t) in enumerate(log)
             if kind == "dock" and stn == station]
    runs = []
    for a, b in zip(marks, marks[1:]):
        leg, out, elsewhere = None, 0.0, False
        for kind, stn, t in log[a:b + 1]:
            if kind == "undock":
                leg = t
            elif kind == "dock":
                if stn != station:
                    elsewhere = True
                if leg is not None and t > leg:
                    out += (t - leg) / 60.0
                leg = None
        if elsewhere and 0 < out <= 240:
            runs.append(out + 2 * turnaround)
    if len(runs) < min_samples:
        return None, 0
    recent = runs[-window:]
    return statistics.median(recent), len(recent)


def laden_jump_range(max_range, unladen_mass, fuel, cargo, observed=None):
    """Jump range with a full hold.

    FSD range is inversely proportional to total mass, so scaling the ship's
    unladen maximum by the mass ratio gives the laden figure. `observed` is
    the longest jump actually made while carrying cargo - a hard lower bound
    that overrides the estimate if the estimate is somehow lower.
    """
    est = None
    if max_range and unladen_mass and cargo:
        dry = unladen_mass + (fuel or 0.0)
        est = max_range * dry / (dry + cargo)
    if observed and (not est or observed > est):
        est = observed
    return est


def est_sc_minutes(ls):
    """The uncalibrated supercruise estimate (same curve the app ships with)."""
    return 0.25 * max(ls, 1) ** 0.3


class JournalWatcher:
    """Tails the newest journal and turns events into timings + position.

    Callbacks:
      on_event(event_dict)        every parsed event
      on_docked(station, system)  docked anywhere
      on_calibration(cal)         a new timing sample landed
      on_approach(ls, start, drop, station)
                                  an approach completed: arrival distance, the
                                  UTC epochs it ran between, where it ended.
                                  Whoever is watching Status.json pairs this
                                  with the overcharge windows - the journal
                                  itself has no idea whether SCO was running.
    """

    def __init__(self, directory=None, cal=None):
        self.dir = find_journal_dir(directory)
        self.cal = cal or Calibration()
        self.path = None
        self.pos = 0
        self.system = None
        self.station = None
        self.docked = False
        self.commander = None
        self.ship = None            # internal name, e.g. "panthermkii"
        self.ship_id = None         # distinguishes two of the same hull
        self.ship_name = None       # localised, e.g. "Panther Clipper Mk II"
        self.cargo_capacity = None
        self.max_jump_range = None
        self.unladen_mass = None
        self.fuel_capacity = None
        self.best_laden_jump = None     # longest jump actually made with cargo
        self.dock_log = []              # ("dock"|"undock", station, ts)
        self._cargo = None
        self.horizons = None
        self.odyssey = None
        self.gameversion = None
        self.gamebuild = None
        # open interval markers
        self._jump_start = None
        self._last_fsdjump = None
        self._arrived_at = None
        self._undocked_at = None
        self._dock_at = None
        self._sc_entry = None
        self._last_ls = None
        # Kept separately from _arrived_at, which the approach_samples pool
        # defines as FSDJump -> Docked and should keep meaning exactly that.
        # This one restarts on a re-entry, because a supercruise you dropped
        # out of and resumed is a different flight from the one that began at
        # the jump.
        self._approach_start = None
        self._drop_ts = None
        self.on_event = None
        self.on_docked = None
        self.on_calibration = None
        self.on_approach = None

    def newest(self):
        if not self.dir:
            return None
        logs = glob.glob(os.path.join(self.dir, "Journal.*.log"))
        return max(logs, key=os.path.getmtime) if logs else None

    def _log_dock(self, kind, station, ts):
        """Pad events, newest last. Two hundred is a few sessions of runs."""
        self.dock_log.append((kind, station, ts))
        del self.dock_log[:-200]

    def prime(self, backfill_files=6):
        """Learn from history once, before live tailing starts."""
        if not self.dir:
            return 0
        logs = sorted(glob.glob(os.path.join(self.dir, "Journal.*.log")),
                      key=os.path.getmtime)[-backfill_files:]
        n = 0
        for f in logs:
            try:
                with open(f, encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        if self._handle(line, live=False):
                            n += 1
            except OSError:
                continue
        # start live tailing at the end of the newest file
        self.path = self.newest()
        if self.path:
            try:
                self.pos = os.path.getsize(self.path)
            except OSError:
                self.pos = 0
        return n

    def poll(self):
        """Read whatever is new. Call this on a timer."""
        newest = self.newest()
        if newest != self.path:          # the game rotated to a new journal
            self.path, self.pos = newest, 0
        if not self.path:
            return
        try:
            with open(self.path, encoding="utf-8", errors="replace") as fh:
                fh.seek(self.pos)
                for line in fh:
                    if not line.endswith("\n"):
                        # The game is mid-write; leave the partial line for the
                        # next poll rather than consuming it half-formed.
                        break
                    try:
                        self._handle(line, live=True)
                    except Exception:
                        pass            # never let one line stop the tail
                    self.pos += len(line.encode("utf-8", "replace"))
        except OSError:
            pass

    # -- event handling ---------------------------------------------------
    def _set_ship(self, ship, ship_id=None, localised=None):
        """Adopt a ship identity, dropping the last ship's numbers if it changed.

        Hold size, jump range and the longest laden jump all belong to one
        hull. Carrying them across a swap is worse than having nothing: the
        Panther's 832t would quietly plan runs for a Cobra, and priming reads
        several journals back, so a swap is normal rather than exotic.
        """
        ship = (ship or "").lower() or None
        if not ship:
            return False
        changed = bool(self.ship) and (
            ship != self.ship
            or (ship_id is not None and self.ship_id is not None
                and ship_id != self.ship_id))
        if changed:
            self.ship_name = None
            self.cargo_capacity = None
            self.max_jump_range = None
            self.unladen_mass = None
            self.fuel_capacity = None
            self.best_laden_jump = None
            self._cargo = None
        self.ship = ship
        if ship_id is not None:
            self.ship_id = ship_id
        if localised:
            self.ship_name = localised
        return changed

    def _handle(self, line, live):
        line = line.strip()
        if not line:
            return False
        try:
            e = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            return False
        if not isinstance(e, dict):
            # A truncated journal can leave a line that parses but is not an
            # event object; .get() below would raise on it.
            return False
        ev, ts = e.get("event"), parse_ts(e.get("timestamp"))
        learned = False

        if ev == "StartJump" and e.get("JumpType") == "Hyperspace":
            self._jump_start = ts
        elif ev == "FSDJump":
            self.system = e.get("StarSystem")
            self.station, self.docked = None, False
            if self._last_fsdjump and ts and ts > self._last_fsdjump:
                dt = ts - self._last_fsdjump
                # Only count back-to-back jumps on a route. A long gap means
                # you stopped to do something, which is not jump cost.
                if 15 <= dt <= 300:
                    self.cal._add(self.cal.jump_secs, dt)
                    learned = True
            # A jump actually made with a hold full of cargo is hard evidence
            # of laden range, and beats any formula.
            if self._cargo and self._cargo > 0 and e.get("JumpDist"):
                if not self.best_laden_jump or e["JumpDist"] > self.best_laden_jump:
                    self.best_laden_jump = e["JumpDist"]
            if self._undocked_at and ts and ts > self._undocked_at:
                dt = ts - self._undocked_at
                if 20 <= dt <= 600:      # beyond ten minutes is not a departure
                    self.cal._add(self.cal.depart_secs, dt)
                    learned = True
            self._undocked_at = None
            self._last_fsdjump = ts
            self._arrived_at = ts
            self._approach_start = ts
            self._drop_ts = None
            self._jump_start = None
        elif ev in ("SupercruiseEntry",):
            self._sc_entry = ts
            self._approach_start = ts
            self._drop_ts = None
        elif ev in ("SupercruiseExit", "SupercruiseDestinationDrop"):
            # No usable distance for this leg: the journal does not say how far
            # the supercruise actually was. FSDJump -> Docked is measured
            # instead, where DistFromStarLS genuinely describes the same trip.
            self._sc_entry = None
            # SupercruiseDestinationDrop is the moment the approach succeeded,
            # and it is the number worth minimising. SupercruiseExit fires a
            # few seconds later and only stands in when the drop was manual.
            if self._drop_ts is None or ev == "SupercruiseDestinationDrop":
                self._drop_ts = ts
        elif ev == "Docked":
            self.station = e.get("StationName")
            self.system = e.get("StarSystem", self.system)
            self.docked = True
            self._dock_at = ts
            if e.get("DistFromStarLS"):
                self._last_ls = e["DistFromStarLS"]
                if self._arrived_at and ts and ts > self._arrived_at:
                    dt = ts - self._arrived_at
                    if 20 <= dt <= 3600:
                        self.cal._add(self.cal.approach_samples, (self._last_ls, dt))
                        learned = True
            if (self._approach_start and self._drop_ts
                    and self._drop_ts > self._approach_start and self._last_ls
                    and live and self.on_approach):
                self.on_approach(self._last_ls, self._approach_start,
                                 self._drop_ts, self.station)
            self._approach_start = self._drop_ts = None
            self._arrived_at = None
            if ts:
                self._log_dock("dock", self.station, ts)
            if live and self.on_docked:
                self.on_docked(self.station, self.system)
        elif ev == "Undocked":
            if self._dock_at and ts and ts > self._dock_at:
                dt = ts - self._dock_at
                if 20 <= dt <= 1800:
                    self.cal._add(self.cal.dock_secs, dt)
                    learned = True
            if ts:
                self._log_dock("undock", self.station, ts)
            self._dock_at, self.docked = None, False
            self._undocked_at = ts
        elif ev == "Loadout":
            # The ship is the source of truth for hold size, jump range and
            # which landing pads you can actually use.
            self._set_ship(e.get("Ship") or self.ship, e.get("ShipID"),
                           e.get("Ship_Localised"))
            if e.get("CargoCapacity") is not None:
                self.cargo_capacity = e["CargoCapacity"]
            if e.get("MaxJumpRange"):
                self.max_jump_range = e["MaxJumpRange"]
            if e.get("UnladenMass"):
                self.unladen_mass = e["UnladenMass"]
            fuel = e.get("FuelCapacity")
            if isinstance(fuel, dict) and fuel.get("Main"):
                self.fuel_capacity = fuel["Main"]
        elif ev in ("ShipyardSwap", "ShipyardNew"):
            # The swap itself, before the new Loadout lands: the old ship's
            # figures must stop being used the moment they stop applying.
            self._set_ship(e.get("ShipType"),
                           e.get("ShipID", e.get("NewShipID")),
                           e.get("ShipType_Localised"))
        elif ev in ("LoadGame", "Fileheader"):
            self._set_ship(e.get("Ship"), e.get("ShipID"),
                           e.get("Ship_Localised"))
            self.commander = e.get("Commander", self.commander)
            if "Horizons" in e:
                self.horizons = e["Horizons"]
            if "Odyssey" in e:
                self.odyssey = e["Odyssey"]
            self.gameversion = e.get("gameversion", self.gameversion)
            self.gamebuild = (e.get("build") or self.gamebuild or "").strip() or None
        elif ev == "Cargo" and e.get("Count") is not None:
            self._cargo = e["Count"]
        elif ev == "Location":
            self.system = e.get("StarSystem", self.system)
            self.station = e.get("StationName")
            self.docked = bool(e.get("Docked"))
        elif ev in ("FSDTarget", "NavRoute"):
            pass

        if live and self.on_event:
            self.on_event(e)
        if learned and self.on_calibration:
            self.on_calibration(self.cal)
        return learned


if __name__ == "__main__":
    d = find_journal_dir()
    print("journal dir:", d or "NOT FOUND")
    w = JournalWatcher(d)
    n = w.prime()
    print("learned %d timing samples from history" % n)
    print("calibration:", w.cal.summary())
    print("position: system=%r station=%r docked=%s" % (w.system, w.station, w.docked))

#!/usr/bin/env python3
"""
Elite Dangerous journal watching + trip-time calibration.

The default trip model is guesswork (0.85 min/jump, 6 min docking, a
supercruise curve fitted by eye). This module replaces those guesses with
what actually happened in your own journals, and keeps learning as you fly.

Standalone-testable:  python3 journal.py
"""

import glob
import json
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
    """Journal timestamps are ISO-8601 Zulu."""
    try:
        return time.mktime(time.strptime(s, "%Y-%m-%dT%H:%M:%SZ"))
    except (ValueError, TypeError):
        return None


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

    def to_dict(self):
        return {"jump_secs": self.jump_secs, "dock_secs": self.dock_secs,
                "depart_secs": self.depart_secs,
                "approach_samples": self.approach_samples}

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
        bits.append("supercruise %s" % ("x%.2f (n=%d)" % (s, n_sc)
                                        if s else "estimate (n=%d)" % n_sc))
        return "  |  ".join(bits)


def real_cycle_minutes(docks, station, min_samples=3):
    """Median time between consecutive docks at `station` - a whole run as
    actually flown.

    The calibrated trip model measures focused travel: its sanity windows
    reject long station stays so one overnight AFK cannot poison it. That
    makes it a floor, not a forecast. This is the other number - what a run
    really costs you, distractions included.

    Anything over four hours is treated as a session break rather than a run.
    """
    times = sorted(t for stn, t in docks if stn == station)
    gaps = [(b - a) / 60.0 for a, b in zip(times, times[1:])
            if 0 < (b - a) / 60.0 <= 240]
    if len(gaps) < min_samples:
        return None
    return statistics.median(gaps)


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
        self.dest_docks = []            # times docked at the destination
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
        self.on_event = None
        self.on_docked = None
        self.on_calibration = None

    def newest(self):
        if not self.dir:
            return None
        logs = glob.glob(os.path.join(self.dir, "Journal.*.log"))
        return max(logs, key=os.path.getmtime) if logs else None

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
            self._jump_start = None
        elif ev in ("SupercruiseEntry",):
            self._sc_entry = ts
        elif ev in ("SupercruiseExit", "SupercruiseDestinationDrop"):
            # No usable distance for this leg: the journal does not say how far
            # the supercruise actually was. FSDJump -> Docked is measured
            # instead, where DistFromStarLS genuinely describes the same trip.
            self._sc_entry = None
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
            self._arrived_at = None
            if ts:
                self.dest_docks.append((self.station, ts))
                del self.dest_docks[:-80]
            if live and self.on_docked:
                self.on_docked(self.station, self.system)
        elif ev == "Undocked":
            if self._dock_at and ts and ts > self._dock_at:
                dt = ts - self._dock_at
                if 20 <= dt <= 1800:
                    self.cal._add(self.cal.dock_secs, dt)
                    learned = True
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

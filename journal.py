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

# Where Elite writes journals. Proton keeps them inside the game's prefix, so
# the Steam library may be on any mounted drive.
JOURNAL_GLOBS = [
    "~/Saved Games/Frontier Developments/Elite Dangerous",
    "~/.local/share/Steam/steamapps/compatdata/359320/pfx/drive_c/users/steamuser/Saved Games/Frontier Developments/Elite Dangerous",
    "~/.steam/steam/steamapps/compatdata/359320/pfx/drive_c/users/steamuser/Saved Games/Frontier Developments/Elite Dangerous",
    "/media/*/SteamLibrary/steamapps/compatdata/359320/pfx/drive_c/users/steamuser/Saved Games/Frontier Developments/Elite Dangerous",
    "/mnt/*/SteamLibrary/steamapps/compatdata/359320/pfx/drive_c/users/steamuser/Saved Games/Frontier Developments/Elite Dangerous",
]


def find_journal_dir(override=None):
    """Locate the journal directory, newest-journal-wins if several match."""
    if override and os.path.isdir(override):
        return override
    best, best_mtime = None, -1
    for pattern in JOURNAL_GLOBS:
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

    def __init__(self, data=None):
        d = data or {}
        self.jump_secs = list(d.get("jump_secs", []))[-200:]
        self.dock_secs = list(d.get("dock_secs", []))[-200:]
        self.sc_samples = [tuple(x) for x in d.get("sc_samples", [])][-200:]
        # FSDJump -> Docked: the whole arrival leg (supercruise + approach +
        # docking). SupercruiseEntry is not always journalled, but this is.
        self.approach_samples = [tuple(x) for x in d.get("approach_samples", [])][-200:]

    def to_dict(self):
        return {"jump_secs": self.jump_secs, "dock_secs": self.dock_secs,
                "sc_samples": self.sc_samples,
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
        if len(self.dock_secs) < self.MIN_SAMPLES:
            return None
        return statistics.median(self.dock_secs) / 60.0

    @property
    def sc_scale(self):
        """Multiplier on the estimated supercruise curve.

        Each sample is (arrival_Ls, observed_seconds). We compare observed
        against the model and take the median ratio, so one 500,000 Ls outlier
        cannot dominate. Falls back to arrival-leg samples, which are logged
        far more reliably than SupercruiseEntry.
        """
        pool = self.sc_samples if len(self.sc_samples) >= self.MIN_SAMPLES \
            else self.approach_samples
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
        bits.append("dock %s" % ("%.1f min (n=%d)" % (d, len(self.dock_secs))
                                 if d else "estimate (n=%d)" % len(self.dock_secs)))
        n_sc = max(len(self.sc_samples), len(self.approach_samples))
        bits.append("supercruise %s" % ("x%.2f (n=%d)" % (s, n_sc)
                                        if s else "estimate (n=%d)" % n_sc))
        return "  |  ".join(bits)


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
        self.horizons = None
        self.odyssey = None
        self.gameversion = None
        self.gamebuild = None
        # open interval markers
        self._jump_start = None
        self._last_fsdjump = None
        self._arrived_at = None
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
                    try:
                        self._handle(line, live=True)
                    except Exception:
                        continue        # never let one line stop the tail
                self.pos = fh.tell()
        except OSError:
            pass

    # -- event handling ---------------------------------------------------
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
                    self.cal.jump_secs.append(dt)
                    learned = True
            self._last_fsdjump = ts
            self._arrived_at = ts
            self._jump_start = None
        elif ev in ("SupercruiseEntry",):
            self._sc_entry = ts
        elif ev in ("SupercruiseExit", "SupercruiseDestinationDrop"):
            if self._sc_entry and ts and ts > self._sc_entry:
                dt = ts - self._sc_entry
                if 10 <= dt <= 3600 and self._last_ls:
                    self.cal.sc_samples.append((self._last_ls, dt))
                    learned = True
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
                        self.cal.approach_samples.append((self._last_ls, dt))
                        learned = True
            self._arrived_at = None
            if live and self.on_docked:
                self.on_docked(self.station, self.system)
        elif ev == "Undocked":
            if self._dock_at and ts and ts > self._dock_at:
                dt = ts - self._dock_at
                if 20 <= dt <= 1800:
                    self.cal.dock_secs.append(dt)
                    learned = True
            self._dock_at, self.docked = None, False
        elif ev in ("LoadGame", "Fileheader"):
            self.commander = e.get("Commander", self.commander)
            if "Horizons" in e:
                self.horizons = e["Horizons"]
            if "Odyssey" in e:
                self.odyssey = e["Odyssey"]
            self.gameversion = e.get("gameversion", self.gameversion)
            self.gamebuild = (e.get("build") or self.gamebuild or "").strip() or None
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

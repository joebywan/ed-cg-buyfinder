#!/usr/bin/env python3
"""
Elite Dangerous Status.json watching: what the journal cannot tell you.

The journal records that a supercruise ended, never how it was flown. Whether
the overcharge was running - and for how long - appears in exactly one place,
the Flags2 bitfield of Status.json, which the game rewrites on every state
change. Polling it a few times a second catches transitions that have no
journal event at all.

What is deliberately not here: range to target and current speed. Neither is
written to any file the game produces, so advice of the form "cut at 1,200 Ls"
is not computable. Everything in this module is therefore timing - how long the
drive was lit, and when, relative to events the journal does log.

Standalone-testable:  python3 status.py
"""

import json
import os
import time

# Flags2 bit 20. Confirmed empirically on 2026-09-13 rather than taken from the
# journal manual: a capture across two round trips showed exactly two bits ever
# set, bit 19 spanning StartJump to arrival (the hyperdrive charging) and this
# one appearing only mid-supercruise with a station targeted.
SCO_ACTIVE = 1 << 20

# Flags bit 4. Used to throw away a stray SCO reading that is not part of an
# approach - the drive cannot be overcharged outside supercruise, so if we ever
# see one, the file was read mid-write.
IN_SUPERCRUISE = 1 << 4


class StatusWatcher:
    """Polls Status.json and records when the overcharge was running.

    Windows are kept as (start, end) wall-clock pairs. Wall clock rather than
    the file's own timestamp because that field has one-second resolution and
    goes stale between writes, while the journal's timestamps agree with the
    system clock to well under a second.

    Callbacks:
      on_sco(active, when)   the overcharge started or stopped
    """

    MAX_WINDOWS = 60        # a couple of hours of flying, then the oldest go

    def __init__(self, directory=None, clock=time.time):
        self.path = os.path.join(directory, "Status.json") if directory else None
        self.clock = clock
        # An approach that started before this moment cannot be scored: no
        # burn was seen, but none would have been. Recording it as a zero-burn
        # approach would quietly become the fastest advice on offer.
        self.watching_since = clock()
        self.flags = None
        self.flags2 = None
        self.sco = False
        self.windows = []       # closed (start, end) pairs, oldest first
        self.sco_since = None   # set while the drive is lit
        self._stamp = None
        self.on_sco = None

    def _read(self):
        """Return the parsed file, or None if it is missing or mid-write.

        The game truncates and rewrites in place, so a poll landing inside a
        write sees half a document. That is normal and not worth logging; the
        next poll 250ms later gets a whole one.
        """
        if not self.path:
            return None
        try:
            stamp = os.stat(self.path)
        except OSError:
            return None
        key = (stamp.st_mtime, stamp.st_size)
        if key == self._stamp:
            return None                 # nothing has changed since last poll
        try:
            with open(self.path, encoding="utf-8", errors="replace") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict):
            return None
        self._stamp = key
        return data

    def poll(self):
        """Read whatever changed. Call this on a timer, ~4x a second."""
        data = self._read()
        if data is None:
            return
        self.flags = data.get("Flags")
        self.flags2 = data.get("Flags2")
        if not isinstance(self.flags2, int):
            return
        sco = bool(self.flags2 & SCO_ACTIVE)
        if isinstance(self.flags, int) and not self.flags & IN_SUPERCRUISE:
            sco = False
        if sco == self.sco:
            return
        now = self.clock()
        self.sco = sco
        if sco:
            self.sco_since = now
        else:
            if self.sco_since is not None:
                self.windows.append((self.sco_since, now))
                del self.windows[:-self.MAX_WINDOWS]
            self.sco_since = None
        if self.on_sco:
            self.on_sco(sco, now)

    def observed(self, start):
        """Whether an approach beginning at `start` was watched throughout."""
        return start is not None and start >= self.watching_since

    def seconds_between(self, start, end):
        """How many seconds the overcharge was lit within [start, end].

        Clipped to the interval, so a burn that straddles the boundary counts
        only the part inside it, and an approach still in progress counts the
        time so far.
        """
        if start is None or end is None or end <= start:
            return 0.0
        spans = list(self.windows)
        if self.sco_since is not None:
            spans.append((self.sco_since, end))
        total = 0.0
        for a, b in spans:
            lo, hi = max(a, start), min(b, end)
            if hi > lo:
                total += hi - lo
        return total

    def first_lit(self, start, end):
        """When the overcharge first came on within [start, end], or None."""
        spans = list(self.windows)
        if self.sco_since is not None:
            spans.append((self.sco_since, end))
        lit = [max(a, start) for a, b in spans
               if start is not None and end is not None and b > start and a < end]
        return min(lit) if lit else None


if __name__ == "__main__":
    import journal
    d = journal.find_journal_dir()
    w = StatusWatcher(d)
    print("watching:", w.path or "NOT FOUND")
    w.on_sco = lambda on, t: print("%s  SCO %s" % (
        time.strftime("%H:%M:%S", time.localtime(t)), "ON" if on else "off"))
    while True:
        w.poll()
        time.sleep(0.25)

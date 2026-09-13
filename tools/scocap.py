"""Capture the HUD through an approach, labelled by what the drive was doing.

Speed and range to target exist only on screen - no file the game writes
contains either. So photograph them, and stamp every frame with the SCO state
from Status.json so a reading can be placed on a timeline afterwards.

Frames are dense where it matters (either side of the cut) and sparse where it
does not, and cropped to the fixed HUD panel that carries target name, range
and speed. A whole frame is kept occasionally anyway: the crop is calibrated to
one ship at one resolution, and a session that captured nothing but the wrong
1700x260 would be worth nothing at all.
"""
import json, os, subprocess, sys, time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import journal                                                    # noqa: E402

SRC = os.path.join(journal.find_journal_dir() or "", "Status.json")
OUT = sys.argv[1]
CROP = os.environ.get("CROP", "1700x260+1400+930")
SCO, SUPERCRUISE = 1 << 20, 1 << 4
CRUISE_EVERY, BURST_EVERY, BURST_FOR = 3.0, 0.5, 12.0
FULL_EVERY = 30.0
BUDGET_MB = 2048

os.makedirs(OUT, exist_ok=True)
man = open(os.path.join(OUT, "frames.jsonl"), "a", buffering=1)


def window():
    try:
        out = subprocess.run(["xdotool", "search", "--name", "^Elite - Dangerous"],
                             capture_output=True, text=True, timeout=5).stdout
        return out.split()[0] if out.split() else None
    except Exception:
        return None


def status():
    try:
        with open(SRC, encoding="utf-8", errors="replace") as fh:
            return json.load(fh)
    except Exception:
        return None


wid = window()
print("window:", wid, "crop:", CROP, flush=True)
print("status:", SRC if os.path.exists(SRC) else "NOT FOUND - is the game installed?",
      flush=True)
written = 0.0
last_cap = last_full = 0.0
burst_until = 0.0
prev_sco = False


def grab(now, flags, flags2, sco, why, full=False):
    global written
    if written > BUDGET_MB * 1024 * 1024:
        return
    path = os.path.join(OUT, "f%013.2f_%s_%s%s.jpg"
                        % (now, 1 if sco else 0, why, "_full" if full else ""))
    cmd = ["import", "-window", wid]
    if not full:
        cmd += ["-crop", CROP, "+repage"]
    cmd += ["-quality", "90", path]
    ok = True
    try:
        subprocess.run(cmd, timeout=5, check=True)
        written += os.path.getsize(path)
    except Exception:
        ok = False          # alt-tabbed, or the window went away
    # Logged either way: a lost frame is recoverable, a lost transition time
    # is not, and the edges are the whole point.
    man.write(json.dumps({"t": now, "file": os.path.basename(path) if ok else None,
                          "sco": sco, "why": why, "full": full,
                          "Flags": flags, "Flags2": flags2}) + "\n")


while True:
    s = status()
    now = time.time()
    if s and wid:
        flags, flags2 = s.get("Flags") or 0, s.get("Flags2") or 0
        sco, in_sc = bool(flags2 & SCO), bool(flags & SUPERCRUISE)
        if sco != prev_sco:
            burst_until = now + BURST_FOR
            grab(now, flags, flags2, sco, "edge")
            last_cap, prev_sco = now, sco
        elif in_sc:
            if now - last_cap >= (BURST_EVERY if now < burst_until else CRUISE_EVERY):
                grab(now, flags, flags2, sco,
                     "burst" if now < burst_until else "cruise")
                last_cap = now
            if now - last_full >= FULL_EVERY:
                grab(now, flags, flags2, sco, "cruise", full=True)
                last_full = now
    time.sleep(0.25)

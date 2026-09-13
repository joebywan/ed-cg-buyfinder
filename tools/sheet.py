"""Tile captured frames into one readable contact sheet.

Reading 150 screenshots one at a time is not viable, and most of them are the
uneventful middle of a cruise. This picks the frames that carry information -
every SCO transition, everything in the bursts around them, and a thinned
sample of the cruise - crops to a region if one is given, stamps each with its
offset from the start of the approach and what the drive was doing, and lays
them out in a grid.
"""
import json, os, subprocess, sys

FRAMES = sys.argv[1]
OUT = sys.argv[2]
CROP = sys.argv[3] if len(sys.argv) > 3 else None      # WxH+X+Y
EVERY = float(sys.argv[4]) if len(sys.argv) > 4 else 9.0   # cruise thinning
COLS = int(os.environ.get("COLS", 2))
BURST_THIN = float(os.environ.get("BURST_THIN", 2.0))
TILEW = os.environ.get("TILEW", "1400x")

rows = [json.loads(l) for l in open(os.path.join(FRAMES, "frames.jsonl"))]
rows = [r for r in rows if r.get("file")]
if not rows:
    sys.exit("no frames")

# Split into approaches: a gap of more than 90s is a different flight.
groups, cur = [], [rows[0]]
for prev, r in zip(rows, rows[1:]):
    if r["t"] - prev["t"] < 90:
        cur.append(r)
    else:
        groups.append(cur)
        cur = [r]              # a new list: cur.clear() would empty the one
groups.append(cur)             # just handed to groups

for gi, g in enumerate(groups):
    t0 = g[0]["t"]
    keep, last_cruise = [], -1e9
    for r in g:
        if r["why"] == "edge" or (r["why"] == "burst"
                                  and r["t"] - last_cruise >= BURST_THIN):
            keep.append(r)
            last_cruise = r["t"]
        elif r["t"] - last_cruise >= EVERY:
            keep.append(r)
            last_cruise = r["t"]
    tiles = []
    for r in keep:
        src = os.path.join(FRAMES, r["file"])
        dst = os.path.join(FRAMES, ".tile_%s" % r["file"])
        cmd = ["convert", src]
        if CROP:
            cmd += ["-crop", CROP, "+repage"]
        cmd += ["-resize", TILEW, "-gravity", "north",
                "-background", "black", "-splice", "0x32",
                "-pointsize", "26", "-fill", "yellow",
                "-annotate", "+0+3", "+%.1fs  SCO %s" % (r["t"] - t0,
                                                         "ON" if r["sco"] else "off"),
                dst]
        subprocess.run(cmd, check=True)
        tiles.append(dst)
    out = OUT if len(groups) == 1 else "%s-%d%s" % (os.path.splitext(OUT)[0],
                                                    gi + 1, os.path.splitext(OUT)[1])
    subprocess.run(["montage"] + tiles + ["-tile", "%dx" % COLS, "-geometry",
                                          "+2+2", "-background", "#222", out],
                   check=True)
    for t in tiles:
        os.unlink(t)
    print("%s  %d frames of %d, %.0fs long" % (out, len(keep), len(g),
                                               g[-1]["t"] - t0))

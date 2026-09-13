# Calibration rig

Measuring when to cut supercruise overcharge, for one ship.

Nothing here ships in the binary. `build.sh` bundles by following imports from
`cgbuy`, and `cgbuy` imports none of this, so the rig stays out of the build on
its own. It needs X11, ImageMagick and `xdotool`, none of which the app is
allowed to depend on.

## Why a rig at all

The app cannot learn this by itself. Elite writes neither current speed nor
range to target into any file - not the journal, not `Status.json` - and those
are exactly the two numbers the cut condition is made of. They exist only on
screen. So the rig photographs the HUD, and a person reads the numbers back.

The output is one scalar per hull, which goes in `../sco_table.json` and is
what the app actually consumes at runtime. No screenshots are involved in
normal use.

## Running a session

```
python3 tools/scocap.py /tmp/frames
```

It watches `Status.json` for the overcharge bit and captures only the Elite
window - never the rest of the desktop. Frames are dense either side of every
transition and sparse through the cruise, cropped to the HUD panel carrying
target name, range and speed, with a whole frame kept every 30s in case the
crop is wrong for your resolution.

Then fly. Vary where you cut: the boundary is only found by crossing it, so
runs that overshoot and loop are as useful as clean ones. Stop the rig when
you are done.

`CROP` overrides the crop region if the default misses on your setup - take one
full frame first and work out the geometry from it.

## Reading them back

```
COLS=2 python3 tools/sheet.py /tmp/frames sheet.png "1700x260+1400+930" 15
```

One contact sheet per approach: every transition, a thinned sample of the
cruise, each tile stamped with its offset and the drive state. Read off the
range and speed at the frame where SCO goes off, and divide - Ls over c is
seconds, and that ratio is the whole measurement.

An approach that looped shows up unmistakably: the range stops falling and
starts climbing.

## Turning readings into a table row

Feed the `(seconds_at_cut, looped)` pairs to `sco_model.classify` and
`sco_model.recommend`. A recommendation needs the boundary bracketed from both
sides - clean cuts alone prove only that you were early enough, never how much
burn you left unused.

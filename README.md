# <img src="icon.png" width="28" alt=""> cgbuy

[![build](https://github.com/joebywan/ed-cg-buyfinder/actions/workflows/build.yml/badge.svg)](https://github.com/joebywan/ed-cg-buyfinder/actions/workflows/build.yml)
[![virustotal](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fjoebywan%2Fed-cg-buyfinder%2Fmain%2F.github%2Fbadges%2Fvirustotal.json)](#antivirus-false-positives)

Finds the best places to **buy** for an Elite Dangerous community goal, ranked
by credits per minute of round trip — not by profit per tonne, because a rich
station 40 minutes away loses to a decent one 15 minutes away.

![Best mixed loads](screenshots/01-best-mixed-loads.png)

It reads your journal to know which goal you joined, what ship you are flying
and how long your jumps actually take, then discovers candidate markets through
Spansh and re-checks the best of them against EDSM, which is days fresher.

The point is to stop bouncing between a dozen Inara tabs. Check a commodity,
note the station, check another, go back and refresh the first because the data
has moved, work out which of the two is actually closer, lose track of the
third, start again — arithmetic done in your head between page loads.
All of that belongs in one pane: a single window, a single ranked list, kept
current in place.

## Install

**Download a binary** — no Python needed:

| | |
|---|---|
| [Latest release](https://github.com/joebywan/ed-cg-buyfinder/releases/latest) | stable, version-tagged |
| [Snapshot](https://github.com/joebywan/ed-cg-buyfinder/releases/tag/snapshot) | rebuilt on every push to `main` |

Every asset carries its version — `cgbuy-v1.5-windows.zip`, `cgbuy-v1.5-linux`
and so on — so a second download never lands as `cgbuy-linux(1)`.

**Windows** — take the `.zip`, extract the whole folder, run `cgbuy.exe` from
inside it. It is a folder rather than a single `.exe` on purpose: the
self-extracting one-file format is what antivirus engines were flagging, and
dropping it took the Windows build from 7/75 on VirusTotal to 0/75. The cost is
that `cgbuy.exe` needs the DLLs beside it, so move the folder, not the exe.
`README-FIRST.txt` in the zip says as much for anyone who skips this page.
The download is about the same size as the old single file (~12 MB); it is
~33 MB once extracted.

**Linux** — take the `.tar.gz` and `tar -xzf cgbuy-v*-linux.tar.gz`; the binary
comes out executable. The loose binary next to it is the same thing without the
wrapper, and a plain download of that one needs `chmod +x` first, because a
GitHub release asset cannot record the execute bit.

Neither build is code-signed, so Windows SmartScreen will warn on first run
("More info" → "Run anyway") — see
[Antivirus false positives](#antivirus-false-positives).

**Or run from source** — Python 3 with tkinter, nothing else:

```
git clone https://github.com/joebywan/ed-cg-buyfinder
cd ed-cg-buyfinder
python cgbuy                  # searches immediately
python cgbuy --no-autosearch  # open without hitting the APIs
```

Stdlib only — no pip installs. tkinter is `python3-tk` on Debian/Ubuntu/Mint;
Python from python.org already includes it. It needs a desktop session and
exits with a clear message if there is no display. The file has no `.py`
extension, so on Windows run it through `python` rather than double-clicking.

Building your own: `./build.sh` on Linux, `build.bat` on Windows. Each creates
a `.venv` and installs its packager into it — the only step that needs network.
Linux uses PyInstaller and produces the single `cgbuy-linux` file; Windows uses
Nuitka and produces a `cgbuy-windows` folder, for the reasons under
[Antivirus false positives](#antivirus-false-positives). Neither packager can
cross-compile, so each has to be built on the OS it targets, which is why CI
runs a separate job per platform.

## What you are looking at

The **best mixed loads** view groups by station and shows what to buy there.
A station's most profitable commodity is often capped below your hold, so it
tops up with that station's next best — no extra travel, more credits.

Expand a row for the per-commodity breakdown. Both views sort on any column
header — click once for high-to-low, again to reverse it. Or switch to
**all sources** for the flat one-row-per-commodity table:

![All sources](screenshots/02-all-sources.png)

`SRC` says whether a row was verified against EDSM or is still Spansh's
figure, and `AGE` is colour-coded — stale supply is the single
biggest cause of a wasted trip.

Click any row to copy its system to the clipboard. A note saying so appears
next to the pointer and clears itself after a second and a half — nothing to
dismiss, since you do this every run.


## Destination

![Settings](screenshots/03-settings.png)

The tool works out where you are selling rather than asking:

1. **The community goal you joined.** Your journal records it — station,
   system and expiry — and Frontier's feed supplies that goal's commodity
   list.
2. **A live trade goal you have not joined.** If one is running it is used
   anyway — routes are never withheld — with a dismissible notice explaining
   that you need to sign up at the goal board first, since deliveries made
   before you register do not count. Dock at that station while still
   unregistered and it reminds you again, which is the one moment the
   reminder is worth anything. Everything clears the moment the journal shows
   you joining.
3. **Whatever you set by hand**, which always wins and is never overwritten.

**Settings → DESTINATION** takes a system (with name completion), then
`LOAD STATIONS` lists that system's markets, nearest arrival star first.
`CHOOSE FROM LIST` opens a filterable checklist of everything the destination
trades — type to narrow it, click to tick, `ADD SHOWN` to take every match at
once — so the commodity list never has to be typed out. `PREFILL FROM LIVE CG`
lists the running trade goals; `DERIVE FROM MARKET`
reads the market of the station you are docked at and picks out whatever it
pays a premium for — at a goal station that recovers the list exactly, and at
an ordinary station it finds what that place is short of.

No community goal anywhere? Set a station and it works as a plain hauling
tool.

## The idea

A run carries at most one hold of cargo. The time cost of the trip is the same
whether the hold is full of Water or full of Palladium, so **the tonnage per run
is capped by the hold, and the only thing that varies is profit per tonne.**
Haul the most valuable tonne you can fill the hold with.

That runs into supply. The station with the best profit/t often only has 200t of
it, well under an 800t hold. So the tool also builds **mixed loads**: for each
station it sorts that station's stock by profit per tonne and fills the hold
greedily — take all of the best commodity, top up with the next best, and so on.
The extra tonnage costs no extra travel, which is why a mixed load usually beats
the same station's single-commodity number.

Scoring: `cr_per_min = (tonnes loaded × profit per tonne) / estimated round-trip
minutes`. The round trip is jumps out (empty range) + jumps back (laden range) +
supercruise/approach at both ends + two departures (pad to first jump) + two
station turnarounds.

Filters applied when collecting sources: a landing pad your ship fits, supply
and buy price must be positive, profit must be positive, the station must be
inside the radius, and the market data must be newer than MAX AGE. Fleet
carriers are excluded unless you tick the box.

## The two views

**BEST MIXED LOADS** — one expandable row per station, ranked by cr/min until
you click another header. The columns read where it is, then what it pays, then
what makes up the load: `SYSTEM`, `LY`, `STATION`, `LS`, `AGE`, then `CR/MIN`
(the plan's value over the trip estimate) and `VALUE` (tonnes × profit/t,
summed), then `TONNES`, `BUY` and `PROFIT/T`.

`TONNES` is what the station can actually fill, so a figure below your hold is a
station that cannot fill it. Expanding a row puts each commodity in the mix in
the `STATION` column, with its own `TONNES`, `BUY`, `PROFIT/T` and `VALUE`.
`BUY` and `PROFIT/T` belong to those commodities rather than to the station, so
those two headers do not sort; every other one does. Whatever the order, the
best cr/min plan keeps its highlight, so re-sorting never loses it. Top 40
stations, first five expanded.

**ALL SOURCES** — one row per commodity-at-station, click any header to sort.

| Column | Meaning |
| --- | --- |
| `LY` | distance from the destination system |
| `LS` | arrival distance of the source station from its star |
| `SUPPLY` | tonnes on offer |
| `LOADS` | how many full holds that supply covers |
| `BUY` | price per tonne at the source |
| `PROFIT/T` | CG sell price minus buy price |
| `TRIP` | estimated round-trip minutes |
| `CR/MIN` | credits per minute for a single-commodity run |
| `T/MIN` | tonnes per minute — use this if you care about CG rank rather than credits |
| `AGE` | how long ago a commander last reported this market; green ≤2 days, amber ≤7, red beyond — a CG drains supply fast |

The header line shows what the CG currently pays for each commodity (the CG
multiplier is already baked into the EDSM price — the tool does not apply it).

## Interface

Inputs across the top: hold size, radius (30 ly), jump range empty and laden,
minimum supply (200), max data age (7 days), and a fleet-carrier toggle. Enter
or SEARCH runs it. Rows older than the max age are hidden and the status bar
says how many; if every row is older, they are shown anyway.

Hold and the two jump ranges are marked `*` and locked while your journal can
see a ship — they are the ship's, not yours to guess at. Hover one to see
where its number came from. See [Ship detection](#ship-detection).

**Font scaling.** The default size is picked from your screen width (9pt under
2560px, 14 under 3840, 17 above). The `- 9 +` control, or Ctrl+`+` / Ctrl+`-`,
rescales everything — fonts, row heights, column widths, and the window itself —
and the choice is saved.

**Settings** (SETTINGS button): journal folder (auto-detected, override only if
you have several installs), the destination, how many minutes cached results
count as fresh (10), how many top results to re-check against EDSM (18),
toggles for desktop notifications and EDDN, and a readout of current trip
timings with a reset.

On startup the last results are shown straight away; if they are older than
the freshness window a new search runs behind them without asking.

**Config** lives at `~/.config/cgbuy.json` (`$XDG_CONFIG_HOME` respected) and holds font
size, journal path, search parameters, the integration toggles, EDSM
verification settings and accumulated calibration samples.

## When to cut SCO

Overcharge is what makes a long arrival leg cheap; overshooting the station is
what makes it expensive again. The rule is a **range to run**, not a countdown,
and it depends on how fast you are going:

```
cut when range to target (Ls)  >=  a x speed(c) ^ p
```

For the Panther Clipper Mk II, `a = 30`, `p = 0.5`. In the cockpit that is a
short table, matched against the two figures already on the HUD panel:

| speed | cut with this much range left | reads on the countdown as |
| --- | --- | --- |
| 70c | 290 Ls | 4.1 s |
| 250c | 545 Ls | 2.2 s |
| 500c | 770 Ls | 1.5 s |
| 1,000c | 1,090 Ls | 1.1 s |
| 2,000c | 1,540 Ls | 0.8 s |

The status bar shows the same figures for the ship you are flying, marked
`estimate` when that hull has no measured law.

**There is no single "seconds to target" answer**, which is the mistake worth
avoiding: the same law reads four seconds at 70c and under one at 2,000c.
Braking distance grows far more slowly than speed does, so a countdown that is
right on a short hop has you cutting several thousand light seconds too early
on a long one - shedding all your speed and crawling the rest of the way, or
having to relight the drive.

### Where the numbers come from

Measured, not modelled. The game writes neither your speed nor your range to
target into any file, so the app cannot learn this by watching - the figures
exist only on screen. They were captured by photographing the HUD through nine
approaches and reading both numbers at the moment the drive cut.

The boundary is pinned near 70c, between a cut with 172 Ls to run that overshot
and looped, and one with 273 Ls that arrived clean. Above that speed no
overshoot has been recorded, so the exponent is bounded from above but not
below; `p = 0.5` is a safety choice among the fits that remain, because the
flatter ones and this one diverge fivefold by 2,000c and only one of those
errors costs a loop.

Two honest caveats. Below about a thousand light seconds the whole thing barely
matters - the approach is dominated by the final crawl into the station, and
overcharge is worth 10-20 seconds there against 105-135 on a 5,000 Ls leg. And
the law is a property of the hull, so [`sco_table.json`](sco_table.json) holds
one row per measured ship; only the Panther is measured, everything else
borrows its numbers and says so. [`tools/`](tools/README.md) has the rig for
measuring your own.

## Journal calibration

The shipped trip model is guesswork: 0.85 min per jump, 1.8 min from the pad to
the first jump, and a supercruise curve (`0.25 × Ls^0.3`) fitted by eye. The app
tails your Elite journals and replaces those guesses with what actually happens
to you:

- **jump cycle** — FSDJump to FSDJump, counted only when 15–300s apart, so a stop
  mid-route is not charged as jump time. It prices the jumps *after* the first:
  the first one's cost is already inside departure and the arrival leg, so a
  route of N jumps is charged N−1 cycles
- **departure** — Undocked to the first FSDJump: launch, clear mass lock, align,
  charge
- **arrival leg** — FSDJump to Docked, i.e. supercruise plus approach plus
  docking, paired with the station's arrival Ls

**Station time is not calibrated.** Docked to Undocked cannot tell trading apart
from making a cup of tea, so the trip model uses a fixed 2-minute turnaround.
The median stop is still collected and shown in the timings readout.

Each measurement needs **at least 3 samples** before it is used at all, and the
value is a median, so one 500,000 Ls outlier cannot swing it. Until then the
estimate stands, and the status bar says `estimate (n=…)`. On first run it
back-fills from your last six journal files. It keeps the most recent 200
samples of each kind in the config.

**The arrival leg is fitted, not scaled.** Most of a leg is fixed cost — drop,
approach, request docking, land — with travel on top, so one multiplier on a
distance curve cannot fit both ends. On the journals this was written against,
two stations 15× apart in arrival distance were 18% apart in time, and the
single ratio that "fitted" them ran 22% fast at one and 57% slow at the other.
Once you have flown legs at arrival distances at least 3× apart, the fixed cost
and the travel term are fitted separately, on bucket medians so a station farmed
for a hundred runs cannot outvote one visited twice. Beyond the range you have
actually flown the estimate curve's shape takes over again — two clusters of
samples say nothing about what 40,000 Ls costs, and a straight line through them
would cheerfully claim it is quick. Below 3× spread, the old ratio stands in.

This matters more than it sounds: the destination's own arrival leg is paid on
every run, and because the error ran the wrong way at each end it was not a flat
offset — distant sources were being pushed down the rankings and near ones
pulled up.

Docking at the destination station triggers an automatic re-search — the run
just ended, so the next one gets fresh data.

**The reward-tier ETA uses your real runs, not the model.** Once three runs are
on record, the `% to next tier` tooltip plans on the median of your **last six**,
and the model only stands in until then.

A run is measured pad to pad at the CG station, but counts only the part you
spend **flying**, plus a flat two minutes at each end — the same two minutes the
trip model prices a stop at. Time parked is not piloting: `Docked → Undocked`
cannot tell restocking from making a cup of tea, and wall-clock dock-to-dock
turned a 14-minute run into a 102-minute one every time its commander stood up.
A run also has to include a stop somewhere else, so leaving the pad and coming
straight back is a repair, not a round trip, and over four hours in flight is a
log-out in supercruise rather than a very slow run.

The upshot is a number that moves when your flying does: tighten the loop and
the estimate follows within two or three runs.

## EDDN sharing

**Off by default, opt-in in Settings.** When on, every time the game writes
`Market.json` (a `Market` journal event) the tool sends that station's commodity
table to EDDN under the `commodity/3` schema, the same way EDMC does.

What is sent: system name, station name, market ID, timestamp, station type, the
Horizons/Odyssey flags, and the price/stock/demand table the game already wrote.
Limpets and non-marketable goods are stripped. Nothing else — no position, no
ship, no cargo. **Your commander name is the uploader ID**, exactly as every
other uploader does it: public and pseudonymous. Messages are validated locally
against the schema before sending, and each market snapshot is sent at most once.

Everything this tool reads came from someone else doing this, which is the
argument for turning it on.

## Limitations

- **Trip times are estimates.** Even calibrated, they are medians of your past
  flying, not a prediction of this run. Interdictions, traffic, and a bad
  approach are not modelled.
- **Market data is only as fresh as the last commander to visit.** Supply drains
  fast during a CG, and a station showing 40,000t three weeks ago may be empty.
  Watch the AGE column; it is coloured for exactly this reason.
- **Fleet carriers move and reprice.** Off by default for that reason.
- **The Linux binary is glibc-specific** and is built on a current Ubuntu runner,
  so it may not start on an older distro. Run from source or build it locally
  if so.
- **No macOS binary.** The code runs there from source; nothing builds one.

## Windows and macOS

What adapts automatically:

- **Journals** — `%USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous`,
  including the OneDrive-redirected variant, plus Steam libraries on other
  drive letters. Override it in Settings if detection misses.
- **Config** — `%APPDATA%\cgbuy.json` on Windows, `~/Library/Application Support`
  on macOS, `~/.config` elsewhere. `XDG_CONFIG_HOME` always wins if set.
- **Cache** — `%LOCALAPPDATA%` / `~/Library/Caches` / `~/.cache`.
- **Font** — first installed of DejaVu Sans Mono, Consolas, Menlo, Liberation
  Mono, Courier New.

Beyond those paths, the only platform-specific code is
[notifications](#notifications), which call each OS's own notifier.

## Antivirus false positives

Both downloads currently scan clean on VirusTotal — zero detections for
Windows and Linux alike. That was not true before v1.5, and the history is
worth keeping, because the fix was not a code change.

Up to v1.4 the Windows download was a PyInstaller `--onefile` build, and a
handful of engines flagged it — 14/75 at v1.3, 7/75 at v1.4, **Microsoft
Defender among them**, which matters more than the count because Defender can
quarantine a download rather than just warn about it.

The cause was the packaging. `--onefile` appends a ~12 MB compressed archive to
a small stub; at runtime the stub unpacks CPython, Tcl/Tk and the extension
modules to a temporary directory and executes from there. A high-entropy blob
glued to an unsigned executable that then self-extracts and runs is, to a
heuristic, indistinguishable from a dropper.

Four builds from one commit, scanned minutes apart, isolate the variable.
The exe column is what an on-disk scan sees; the zip column is what people
actually download:

| Build | Layout | Zip | Exe |
|---|---|---|---|
| PyInstaller one-file *(shipped up to v1.4)* | one file | — | 7/75 |
| Nuitka one-file | one file | — | 15/75 |
| PyInstaller `--onedir` | exe + `_internal/` | 1/74 | 5/75 |
| **Nuitka standalone** *(shipped from v1.5)* | flat folder | **0/73** | **0/75** |

Denominators vary because VirusTotal does not run the same number of engines on
every submission; the counts above are from that one experiment, while the
badge and each release's notes carry the figures for what actually shipped.

Compiling to C rather than bundling an interpreter made it *worse*, because
Nuitka's one-file mode extracts at startup too. It is the extraction step the
engines score, not the language, and not the code.

`--onedir` is worth singling out because it is the tidier shape — the exe alone
at the top with everything under `_internal/` — and it was rejected on the
numbers rather than on taste. Dropping the self-extraction got it most of the
way, Microsoft Defender included, but PyInstaller's bootloader is itself scored
and five engines still flagged it. Nuitka's standalone output is a flat
directory with no way to nest the DLLs, so the cost of zero detections is
about two dozen support files sitting next to `cgbuy.exe`. That trade was made
deliberately.

The same reasoning is why there is no Go rewrite: Go would land near zero for
exactly this reason — a static binary with nothing to unpack — and so does the
Python, at the price of a build flag rather than 4,400 lines and a new GUI
toolkit.

If you would rather not take that on trust:

- **Run from source** — `python cgbuy`. No binary, no packaging, and the source
  is all in this repository.
- **Check the hash.** `Get-FileHash` on Windows, `sha256sum` elsewhere,
  against the file on the Releases page.
- **Read the sandbox report** rather than the score. The relevant question is
  what it did: contacted hosts, files written, processes spawned.

Neither build is code-signed, and neither will be. A certificate is a recurring
annual cost and this is a free tool written for its author's own use; sharing it
is a courtesy. Signing would also quiet SmartScreen, which shipping a folder
does not, but not at that price.

Detections can come back — heuristics change, and an unsigned binary from a
small project has no reputation to fall back on. If one does, the options above
are the answer: run from source, check the hash, read the sandbox report — or
don't run it. All three are reasonable.

Every release scans itself. After a version is published, CI submits both
downloads to VirusTotal and appends the detection counts, hashes and the names
of any flagging engines to the release notes. The numbers are a point-in-time
reading and the links show the current verdict — but it means anyone forwarded
an alarming-looking scan link finds the same figures already on the download
page, with this section next to them, rather than having to guess.

## Notifications

The window normally sits behind the game, so it tells you when something
changes rather than waiting to be looked at:

- **the best target changed** — a different station is now top, usually
  because the previous one drained or fresher data arrived
- **your reward bracket moved** — up, or *down* when other commanders
  overtake you, which is the one you would otherwise never see coming

Delivered through `notify-send` on Linux, a toast on Windows 10+, and
`osascript` on macOS. Whatever the platform, the window title is also marked
and the bell rung, so there is a visible sign even with no notification
daemon; the mark clears when you next focus the window. Turn it off with
**Desktop notifications** in Settings.

The status bar also shows how long ago the shown data was fetched, ticking
live and turning amber once it passes the auto-refresh threshold — so you can
tell at a glance whether docking at the destination actually refreshed it.

## Ship detection

Hold size, jump ranges and landing-pad class are read from the game's
`Loadout` event, not typed in. **While a journal is readable it is the source
of truth**: those boxes show the ship's own figures, are locked, and update
themselves. They unlock only when no journal names a ship — with nothing to
read, your estimate is all there is, and it is remembered between sessions.
(The starter-hauler numbers behind them are deliberately small: too small is
visibly wrong, whereas a plausible big-ship number would just be believed.)

Swapping ships, refitting, or flying a longer laden jump than before all
update the toolbar live, without a restart. A swap is taken from `Loadout`,
`ShipyardSwap`, `ShipyardNew` or `LoadGame`, and the previous ship's figures
are dropped the instant the hull changes rather than lingering — priming reads
several journals back, so a swap is ordinary, and a Panther's 832t hold on a
Cobra would plan confident runs you cannot fly. Between the swap and the new
`Loadout` the status bar says so. Once the new figures land, the results are
re-run automatically: pad class decides which stations are eligible at all, so
what was on screen was about a ship you are no longer flying.

Laden jump range is the one the game never reports. It is derived from the
mass ratio — FSD range is inversely proportional to total mass, so the unladen
maximum scales by `(hull + fuel) / (hull + fuel + cargo)` — and then floored by
the longest jump you have actually made with cargo aboard, which is hard
evidence no formula can argue with.

This matters more than it sounds. An underestimate makes the tool think the
return leg needs an extra jump, inflating every trip time and quietly biasing
the ranking against the nearer stations.

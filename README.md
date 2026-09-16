# <img src="icon.png" width="28" alt=""> cgbuy

[![build](https://github.com/joebywan/ed-cg-buyfinder/actions/workflows/build.yml/badge.svg)](https://github.com/joebywan/ed-cg-buyfinder/actions/workflows/build.yml)
[![virustotal](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fjoebywan%2Fed-cg-buyfinder%2Fmain%2F.github%2Fbadges%2Fvirustotal.json)](#antivirus)

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

**Windows** — take the `.zip` (~12 MB), extract the whole folder, and run
`cgbuy.exe` from inside it. **Keep the folder together**: `cgbuy.exe` needs the
files beside it and will not start on its own, so move the folder, not the exe.
For a desktop entry, make a shortcut rather than a copy. `README-FIRST.txt`
ships inside the zip and says the same for anyone who skips this page.

It is a folder rather than a single `.exe` deliberately — that is what took the
Windows build to zero antivirus detections, and the
[reasoning is in DEVELOPMENT.md](DEVELOPMENT.md#why-windows-ships-as-a-folder).

**Linux** — take the `.tar.gz` and `tar -xzf cgbuy-v*-linux.tar.gz`; the binary
comes out executable. The loose binary next to it is the same thing without the
wrapper, and a plain download of that one needs `chmod +x` first, because a
GitHub release asset cannot record the execute bit.

Neither build is code-signed, so Windows SmartScreen will warn on first run
("More info" → "Run anyway") — see [Antivirus](#antivirus).

**Or run from source** — Python 3 with tkinter, nothing else. Stdlib only, no
pip installs:

```
git clone https://github.com/joebywan/ed-cg-buyfinder
cd ed-cg-buyfinder
python cgbuy                  # searches immediately
python cgbuy --no-autosearch  # open without hitting the APIs
```

tkinter is `python3-tk` on Debian/Ubuntu/Mint; Python from python.org already
includes it. It needs a desktop session and exits with a clear message if there
is no display. The file has no `.py` extension, so on Windows run it through
`python` rather than double-clicking.

Building it yourself, and how it is packaged, are in
[DEVELOPMENT.md](DEVELOPMENT.md).

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

Hover the destination at the top to see what the CG pays per tonne for each
commodity (the CG multiplier is already baked into the EDSM price — the tool
does not apply it). It is a hover rather than a row of its own because every
one of those prices is already inside the `PROFIT/T` beside it.

**Hover any station row, in either table, to see which body it is.** `LS` says
how long the approach is; it does not say whether it ends at a starport you
dock at or a pad you have to glide down to — and if it is a surface, which rock
you set course for. The hover says that, with the body's type and surface
gravity when it is one you land on. A carrier says so instead, because it
orbits nothing and can leave.

The two halves come from different places. Spansh names the body for a surface
station, so that answer is already in hand. It records nothing at all for an
orbital starport — not in its station index and not in its system dump — so the
body a starport orbits is asked of EDSM, once per system, only for a row you
actually pointed at, and it fills itself in a moment later. A system the search
already re-checked against EDSM costs nothing, because it is the same response.

## Interface

Inputs across the top: hold size, radius (30 ly), jump range empty and laden,
minimum supply (200), and toggles for fleet carriers and Odyssey. Enter or
SEARCH runs it.

**ODYSSEY** decides whether stations on a planet surface are candidates at all
— settlements, planetary outposts and ports. It is off by default because a
surface market is a different trip from a starport: a glide down, a pad on a
rock, and a client that owns the expansion. The first time your journal names a
game it sets the box for you from what that game is running; after that the
choice is yours and it is remembered. Hover a row to see which body you would
be landing on.

**When Spansh will not answer for a commodity, the status bar says so.** It
sheds load rather than queueing, so a busy evening returns 502s; those pages
are asked for again, and a commodity it still will not answer for is named in
amber, because nothing from it is in the ranking. The line above it counts what
the *destination* pays for, which is not the same as what got searched — so
without this a search missing a quarter of the goal read exactly like a
complete one.

**What the age filter did has its own line, under the table, always.** Sources
older than the cutoff (Settings → DATA ACCURACY, 7 days by default) are dropped
during the fetch, and the line says how many out of how many — or says nothing
was hidden, which is worth reading too. Raise the cutoff and the search re-runs,
because the rows it hid are not held anywhere to un-hide. If *every* source is
older than the cutoff the filter stands down rather than leave you an empty
table, and the line says so.

The title line carries the destination and how old the data on screen is. The
status bar is the search's own line — what was found, what was hidden, what
went wrong. Nothing else lives in either: a progress bar you have finished
reading is a full-width orange rule saying nothing, so it is only there while
a search runs.

Hold and the two jump ranges are marked `*` and locked while your journal can
see a ship — they are the ship's, not yours to guess at. Hover one to see
where its number came from. See [Ship detection](#ship-detection).

**Font scaling.** The default size is picked from your screen width (9pt under
2560px, 14 under 3840, 17 above). Ctrl+`+` / Ctrl+`-`, or Settings → DISPLAY,
rescales everything — fonts, row heights, column widths, and the window itself —
and the choice is saved.

**Settings** (SETTINGS button): journal folder (auto-detected, override only if
you have several installs), the destination, how many minutes cached results
count as fresh (10), how many top results to re-check against EDSM (18), how old
a source may be (7 days), font size, toggles for desktop notifications and EDDN,
and a readout of current trip
timings with a reset.

On startup the last results are shown straight away; if they are older than
the freshness window a new search runs behind them without asking.

**Config** lives at `~/.config/cgbuy.json` (`$XDG_CONFIG_HOME` respected) and holds font
size, journal path, search parameters, the Odyssey toggle, the integration
toggles, EDSM verification settings and accumulated calibration samples.

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

## Update check

**Off by default, opt-in in Settings** (*Check for a new version at startup*).
When on, the app asks GitHub once as it opens what the latest release is. If
that is newer than what you are running, a line appears in the status bar —

> New version 1.7 available

— and clicking it opens the releases page in your browser. That is the entire
feature. It is not an updater: nothing is downloaded, nothing is replaced, and
the app never opens a browser on its own. The Windows build scans clean
precisely because nothing in it fetches or runs code, and that is not being
traded away for convenience.

One request per run, no polling, and nothing about you is sent — it is a plain
`GET` of the public releases endpoint, with the same User-Agent every other
call uses. If it fails for any reason at all — offline, blocked, rate-limited,
GitHub having a bad day — it says nothing rather than reporting an error at
you. There is no second prompt and nothing to dismiss: the line is either
there or it is not.

Running from source? The notice still appears, and `git pull` is your update.
The rolling [snapshot](#install) build is a pre-release, so it is never
offered as an update to anyone.

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

## Antivirus

**Both downloads currently scan clean on VirusTotal — zero detections, Windows
and Linux alike.** Every release scans itself: after a version is published CI
submits both downloads and appends the counts, hashes and the names of any
flagging engines to the release notes, so anyone forwarded an alarming-looking
scan link finds the same figures already on the download page.

This was not always true. Up to v1.4 the Windows download was a single
self-extracting `.exe`, and a handful of engines flagged that shape generically
no matter what the program did — Microsoft Defender among them, which matters
because Defender can quarantine a download rather than just warn. Shipping a
folder instead cleared every detection. It was never the code, and the full
investigation is in
[DEVELOPMENT.md](DEVELOPMENT.md#why-windows-ships-as-a-folder).

Detections can come back — heuristics change, and an unsigned binary from a
small project has no reputation to fall back on. If one does:

- **Run from source** — `python cgbuy`. No binary, no packaging, and the source
  is all in this repository.
- **Check the hash.** `Get-FileHash` on Windows, `sha256sum` elsewhere, against
  the figures in the release notes.
- **Read the sandbox report** rather than the score. The relevant question is
  what it did: contacted hosts, files written, processes spawned.

Neither build is code-signed, and neither will be. A certificate is a recurring
annual cost and this is a free tool written for its author's own use; sharing it
is a courtesy. Signing would also quiet SmartScreen, which shipping a folder
does not, but not at that price.

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

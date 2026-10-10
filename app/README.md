# <img src="icon.png" width="28" alt=""> cgbuy web

**[knowhowit.com.au/ed-cg-buyfinder-web](https://knowhowit.com.au/ed-cg-buyfinder-web/)**

Finds the best places to **buy** for an Elite Dangerous community goal, ranked
by credits per minute of round trip — not by profit per tonne, because a rich
station 40 minutes away loses to a decent one 15 minutes away.

This is the browser version of
[cgbuy](https://github.com/joebywan/ed-cg-buyfinder). Nothing to download or
install: open the page.

## Using it

1. Open the page. It picks up the community goal that is running and searches
   straight away.
2. Give it your Elite journal folder, usually
   `C:\Users\<you>\Saved Games\Frontier Developments\Elite Dangerous`.
   The page then knows which goal you joined and which ship you are flying,
   and learns how long your jumps and approaches really take.
   - **Chrome or Edge:** **Connect journal folder**. The browser asks once for
     permission, then the page keeps reading the folder as you play, and
     re-searches by itself when you dock at the goal.
   - **Firefox, Brave or Safari:** **Load journal folder**. These browsers
     only hand a page a copy of the folder as it is at that moment (Brave
     switches off the feature Chrome uses), so nothing updates by itself:
     press **Load journal folder again** after docking to refresh. If the
     browser asks about uploading files, nothing leaves your computer — the
     page reads them locally.
3. Click a row to copy its system name, then paste it into the galaxy map.

Without the journal, type your hold size and jump ranges into the boxes at the
top.

**BEST MIXED LOADS** groups by station and fills your hold with that station's
best commodities, topping up when the best one runs short. **ALL SOURCES** is
one row per commodity at each station. Click any column header to sort.
`AGE` is how long ago someone last reported that market: green is 2 days or
less, amber up to 7, red beyond.

**ODYSSEY** decides whether stations on a planet surface are candidates at all
— settlements, planetary outposts and ports. It is off by default because a
surface market is a different trip from a starport: a glide down, a pad on a
rock, and a client that owns the expansion. The first time your journal names
a game it sets the box for you from what that game is running; after that the
choice is yours.

**Hover a station to see which body it is.** `LS` says how long the approach
is; it does not say whether it ends at a starport you dock at or a pad you
have to glide down to — and if it is a surface, which rock you set course for.

## Sharing back

Every price on this page started as a market reading some other commander
uploaded: the page reads Ardent, Ardent is built from EDDN, and EDDN is built
from people running uploaders. **SHARE TO EDDN** is the other half of that —
when you dock, what the game writes goes back to the same pool:

| Schema | From | What it carries |
| --- | --- | --- |
| `commodity/3` | `Market.json` | the price/stock/demand table |
| `outfitting/2` | `Outfitting.json` | the module names on sale |
| `shipyard/2` | `Shipyard.json` | the hulls on sale |

Only the first is data this page reads back. The other two are given rather
than taken — somebody else's route planner needs them, and they cost nothing,
because those files sit beside the journals we can already see.

It is **off until you turn it on**, and it appears only once the page can see
your journal folder. It is public and pseudonymous: it uploads as your
commander name, exactly as E:D Market Connector does, and sends nothing but
the station's commodity table — no position, no route, no cargo.

Anything malformed is caught here rather than at EDDN — all three schemas set
`additionalProperties: false`, so one stray key rejects a whole message — and
a reading is never sent twice. Module names are spelled the way EDMC spells
them, so consumers see one string from both uploaders, and the planet approach
suite is dropped because every hull has one.

Two details, both learned from real files. The game repeats module names (484
entries, 465 distinct in one reading) and the schema demands unique ones, so
the list is de-duplicated or it would be rejected outright. And
`Outfitting.json` and `Shipyard.json` persist from the last station that *had*
that service, so each upload is checked against the market ID the journal
event just named — otherwise a shipyard three systems back is republished as
this one.

**Chrome or Edge** share as you play, because they can keep reading the
folder. **Firefox, Brave and Safari** only ever hand over a snapshot, so they
share what was on disk when you last loaded the folder — and nothing at all if
that reading is over an hour old, because republishing stale supply figures as
current is the problem this tool exists to complain about. Those two files in
particular are usually far older than that, so in practice a snapshot browser
shares the market and little else.

**DESTINATION** lets you pick a different goal, or any station and commodity
list, and that choice sticks until you press **BACK TO AUTOMATIC**.

Docking at the goal station re-runs the search, since the run just ended.

### Compared with the desktop app

- Markets come from [Ardent Insight](https://ardent-insight.com) rather than
  Spansh, which does not allow other web pages to read its data.
- Not here yet: desktop notifications, the reward-tier estimate.
- The body a station sits on or orbits comes free here: Ardent records it for
  orbital starports as well as surface stations, where the desktop app has to
  ask EDSM for half of it.
- Keep the tab open. A tab left in the background for a while is only checked
  about once a minute, so updates can lag.

## Development

Plain HTML, CSS and ES modules. No dependencies and no build step.

| | |
|---|---|
| `src/model.js` | trip time, mixed loads, pads, ages |
| `src/journal.js` | trip-time calibration and ship identity from journal events |
| `src/cg.js` | Frontier's goal feed and the goal you joined |
| `src/ardent.js` | market discovery through Ardent |
| `src/commodities.js` | display name → FDev symbol, generated from [EDCD/FDevIDs](https://github.com/EDCD/FDevIDs) |
| `src/tail.js` | reads the journal folder through the File System Access API |
| `src/eddn.js` | the `commodity/3` uploader: schema, local validation, dedup |
| `src/bodies.js` | which body an orbital station orbits, from EDSM |
| `src/version.js` | the version number, which EDDN records as `softwareVersion` |
| `app.js` | the page itself |

```
npm test                          # node --test, Node 20+
python3 -m http.server 8765       # or any static server: modules need http://
```

The trip model, calibration windows and mixed-load packing follow the desktop
app's; its source explains the reasoning behind each number.

Two Ardent quirks the code works around: `nearby/exports` leaves out the
reference system itself, so the goal system's own markets are a second query;
and its `distance` is whole light years, so distance is recomputed from system
coordinates.

Pushing to `main` runs the tests and publishes to GitHub Pages
(`.github/workflows/pages.yml`).

Market data: Ardent Insight, fed by the Elite Dangerous Data Network. Goal
data: Frontier Developments. Elite Dangerous is © Frontier Developments plc;
this is an unofficial tool.

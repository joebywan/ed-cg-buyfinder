# Developing cgbuy

Everything here is for working *on* cgbuy. If you only want to use it, the
[README](README.md) is the whole story.

## Layout

Stdlib only, no dependencies, no build step to run it. `cgbuy` is the entry
point and has no `.py` extension, which is why the build scripts copy it to
`build_src.py` before packaging and why the tests load it through
`importlib.machinery.SourceFileLoader`.

| | |
|---|---|
| `cgbuy` | the app: UI, search orchestration, ranking, config and cache |
| `cg.py` | community goal discovery and parsing |
| `eddn.py` | EDDN upload: `commodity/3`, `outfitting/2`, `shipyard/2` |
| `journal.py` | journal tailing and trip-time calibration |
| `notify.py` | per-OS notifications |
| `update.py` | asks GitHub for the latest release tag; compares, never fetches |
| `verify.py` | market re-checks against EDSM |
| `version.py` | the version number and the User-Agent, for everything else |
| `test_cgbuy.py` | the whole suite, one file |

`version.py` is the only place the version lives. `cgbuy`, `cg.py`,
`verify.py` and `eddn.py` all import it, so one line governs `--version`, all
three User-Agent strings and the `softwareVersion` EDDN records. They used to
carry a literal each, and three had drifted to `2.0` while the app shipped
`1.5` — harmless while nothing read it, which stopped being true when the
update check started comparing against it. A test asserts nothing declares its
own again.

## Running it

```
python cgbuy                  # searches immediately
python cgbuy --no-autosearch  # open without hitting the APIs
python cgbuy --version
```

tkinter is `python3-tk` on Debian/Ubuntu/Mint; the python.org installer already
includes it. It needs a desktop session and exits with a clear message without
one.

## Tests

```
python test_cgbuy.py
```

tkinter needs a display even to construct widgets, so CI runs it under
`xvfb-run -a`. Do the same on a headless box.

## Building

```
./build.sh     # Linux
build.bat      # Windows
```

Each creates a `.venv` and installs its packager — the only step needing
network. Neither packager can cross-compile, so each binary must be built on the
OS it targets, which is why CI runs a job per platform rather than a matrix.

The two platforms are packaged differently on purpose:

| | Packager | Output |
|---|---|---|
| Linux | PyInstaller `--onefile` | `cgbuy-linux`, one file |
| Windows | Nuitka `--standalone` | `cgbuy-windows/`, a folder |

## Why Windows ships as a folder

This is the one piece of build trivia worth knowing before changing anything,
because it is easy to "tidy up" and silently undo.

Up to v1.4 Windows shipped a PyInstaller `--onefile` build and a handful of
engines flagged it — 14/75 at v1.3, 7/75 at v1.4, **Microsoft Defender among
them**, which matters more than the count because Defender can quarantine a
download rather than merely warn.

The cause was packaging, not code. `--onefile` appends a compressed archive to a
small stub; at runtime the stub unpacks CPython, Tcl/Tk and the extension
modules into a temp directory and executes from there. A high-entropy blob glued
to an unsigned executable that then self-extracts and runs is, to a heuristic,
indistinguishable from a dropper.

Four builds from one commit, scanned minutes apart, isolate the variable. The
exe column is an on-disk scan; the zip column is what people download:

| Build | Layout | Zip | Exe |
|---|---|---|---|
| PyInstaller one-file *(shipped up to v1.4)* | one file | — | 7/75 |
| Nuitka one-file | one file | — | 15/75 |
| PyInstaller `--onedir` | exe + `_internal/` | 1/74 | 5/75 |
| **Nuitka standalone** *(shipped from v1.5)* | flat folder | **0/73** | **0/75** |

Denominators vary because VirusTotal does not run the same number of engines on
every submission.

Compiling to C rather than bundling an interpreter made it *worse*: Nuitka's
one-file mode extracts at startup too. **It is the extraction step engines
score**, not the language and not the code.

`--onedir` deserves singling out, because it is the tidier shape — the exe alone
at the top with everything under `_internal/` — and it is the first thing anyone
looking at two dozen DLLs beside `cgbuy.exe` will reach for. It was rejected on
numbers, not taste: dropping self-extraction got it most of the way, Defender
included, but PyInstaller's bootloader is itself scored and five engines still
flagged it. Nuitka's standalone output is flat with no way to nest the DLLs, so
the price of zero detections is a cluttered folder. That trade was made
deliberately.

Two tests guard it: every Windows build script must pass `--standalone`, and
`build.bat` must never contain `--onefile`. Linux keeps `--onefile` — it scans
clean there and one file is the better download.

Go was considered and rejected for the same reason. A static Go binary would
land near zero because there is nothing to unpack — but so does the Python, at
the price of a build flag rather than 4,400 lines and a new GUI toolkit.

## What ships, and under what name

Release assets carry their version, so a second download never lands as
`cgbuy-linux(1)`:

- `cgbuy-v<ver>-windows.zip` — a folder, with `README-FIRST.txt` beside
  `cgbuy.exe`. The zip wraps a directory rather than loose files so extracting
  cannot spray ~950 files across someone's Downloads.
- `cgbuy-v<ver>-linux.tar.gz` — tar stores the mode, so the extracted binary is
  already executable.
- `cgbuy-v<ver>-linux` — the same binary loose, needing `chmod +x`.

That last point is the reason the tarball exists at all: **a GitHub release
asset carries no POSIX mode.** The execute bit is dropped on upload and again on
download, so a plain binary can never arrive runnable however it was built. Git
storing mode `100755` does not help — these are never committed, they are built
in CI and pushed through the releases API.

`packaging/README-FIRST.txt` is the note that ships inside the Windows zip.
`@VERSION@` is substituted at build time and line endings are forced to CRLF
during packaging, because the `.gitattributes` `eol=crlf` rule cannot be relied
on to survive checkout on the runner — a build that trusted it shipped an LF
file that opens in Notepad as one long line.

## CI

| Workflow | Trigger | Does |
|---|---|---|
| `build.yml` | push to `main`, PRs | tests, both builds; on `main` also refreshes the `snapshot` pre-release |
| `release.yml` | manual dispatch | validates the version, tests, tags, builds, publishes, scans |

The `snapshot` tag is reused on every push, and its assets are keyed to the
short commit. Because those names change per push, same-name replacement no
longer clears the previous build, so the snapshot release is emptied of assets
before new ones are uploaded. Forget that and the downloads list grows forever.

## Cutting a release

Actions → **release** → Run workflow → a version like `2.2` (no leading `v`),
plus optional extra notes. It refuses a version that is malformed or already
tagged, runs the suite before anything is tagged, rewrites `VERSION` in
`version.py`, commits, tags, builds both platforms, checks each binary reports
the version it claims, publishes, and then scans the published files on
VirusTotal — appending counts, hashes and flagging engine names to the release
notes and refreshing the badge on `main`.

The VirusTotal step needs the `VT_API_KEY` secret and never fails a release:
the binaries are already out, and VirusTotal being slow is not a broken build.
It is release-only because doing it per push would burn the free key's daily
quota.

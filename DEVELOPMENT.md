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

Both also build the Tauri desktop app (`build-desktop-linux`,
`build-desktop-windows`); see [The desktop app](#the-desktop-app-app).

The `snapshot` tag is reused on every push, and its assets are keyed to the
short commit. Because those names change per push, same-name replacement no
longer clears the previous build, so the snapshot release is emptied of assets
before new ones are uploaded. Forget that and the downloads list grows forever.

## Cutting a release

Actions → **release** → Run workflow → a version like `2.2` (no leading `v`),
plus optional extra notes. It refuses a version that is malformed or already
tagged, runs both suites before anything is tagged, rewrites `VERSION` in
`version.py` and stamps the same number into `app/`, commits, tags, builds both platforms, checks each binary reports
the version it claims, publishes, and then scans the published files on
VirusTotal — appending counts, hashes and flagging engine names to the release
notes and refreshing the badge on `main`.

The VirusTotal step needs the `VT_API_KEY` secret and never fails a release:
the binaries are already out, and VirusTotal being slow is not a broken build.
It is release-only because doing it per push would burn the free key's daily
quota.

## The desktop app (`app/`)

A rewrite of cgbuy as a web page in a Tauri v2 window. It lives in `app/`,
imported from the `ed-cg-buyfinder-web` repo with its history
(`git subtree`), and is released from this repo so existing users' update
checks, the README and the VirusTotal badge carry over. The Python app is
untouched and still the main download for now.

| | |
|---|---|
| `app/index.html`, `app.js`, `style.css`, `src/` | the page; runs in a plain browser too |
| `app/src/desktop.js` | everything that only exists inside the Tauri window: settings file, journal folder, no-CORS fetch, external links |
| `app/src/update.js` | "a newer version exists" check, a port of `update.py` |
| `app/src-tauri/` | the Rust shell: `src/main.rs`, `tauri.conf.json` (CSP), `capabilities/` (what the page may call, including the allowed HTTP hosts) |
| `app/src-tauri/prep.mjs` | copies the page files into `src-tauri/dist`, which is what gets embedded |
| `app/stamp-version.mjs` | copies `version.py` into the app's version files |
| `app/test/` | `node --test`, no dependencies |

Needs Node 22+, Rust (rustup) and `cargo install tauri-cli --version "^2" --locked`.
On Debian/Ubuntu also `libwebkit2gtk-4.1-dev build-essential libxdo-dev
libssl-dev libayatana-appindicator3-dev librsvg2-dev`.

```
cd app
npm test                        # web tests
node src-tauri/prep.mjs         # once, so cargo can see dist/
(cd src-tauri && cargo test)    # Rust tests
cargo tauri dev                 # run it
cargo tauri build --no-bundle   # just the binary: src-tauri/target/release/cgbuy
```

Opening `app/index.html` through any static server also works, as the website:
anything that needs the app is behind `DESKTOP` in `desktop.js`.

### Versions

`version.py` is still the only place a version is typed. The app's copies —
`src/version.js` (`"1.9"`), and `tauri.conf.json`, `Cargo.toml` and the
`cgbuy` entry in `Cargo.lock` (`"1.9.0"`; Tauri insists on three parts) — are
written by `node app/stamp-version.mjs`. `node app/stamp-version.mjs --check`
and `app/test/version.test.js` fail if any has drifted, so after changing
`version.py` by hand, run the stamp. The release workflow does that itself.

### What the desktop build ships as

Built by `cargo tauri build` (not `tauri-action`, which would want to own the
release and the file names that this repo's workflows already own). Asset names
carry `desktop` so they never collide with the Python ones:

- `cgbuy-desktop-v<ver>-windows-setup.exe` — NSIS installer
- `cgbuy-desktop-v<ver>-windows-portable.zip` — a folder with the single
  `cgbuy.exe` and `README-FIRST.txt` (`packaging/README-FIRST-desktop.txt`).
  Needs WebView2, which Windows 10/11 ship with
- `cgbuy-desktop-v<ver>-linux.AppImage`, `-linux.deb`, and `-linux`, the bare
  binary, which needs libwebkit2gtk-4.1 installed

Snapshots use the short commit instead of `v<ver>`. The two Windows files are
scanned on VirusTotal with the Python ones, but the README badge still follows
the Python zip: `vt_scan.py` skips `desktop` names when writing it. Remove that
condition when the desktop build becomes the main download.

### Moving the website (GitHub Pages)

Nothing here publishes a site on purpose. To move it: add a `pages.yml` that
copies `app/index.html app.js style.css icon.png src` into `_site` and deploys
it (the web repo's one did exactly that), set the Pages source to GitHub
Actions in this repo's settings, and decide what happens to the old site's URL.

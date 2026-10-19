# Developing cgbuy

Everything here is for working *on* cgbuy. If you only want to use it, the
[README](README.md) is the whole story.

cgbuy is a web page (`app/`) that runs two ways: as the website, served as-is
by GitHub Pages, and inside a native window built with Tauri v2, which is the
downloadable desktop app. (It used to be a Python/tkinter program; that was
retired and its code removed once the desktop app replaced it.)

## Layout

| | |
|---|---|
| `VERSION` | the one place the version number is typed, e.g. `1.9` |
| `app/index.html`, `app.js`, `style.css`, `src/` | the page; runs in a plain browser too |
| `app/src/desktop.js` | everything that only exists inside the Tauri window: settings file, journal folder, no-CORS fetch, external links, the mini-mode window |
| `app/src/update.js` | "a newer version exists" check against GitHub releases |
| `app/src-tauri/` | the Rust shell: `src/main.rs`, `tauri.conf.json` (CSP), `capabilities/` (what the page may call, including the allowed HTTP hosts) |
| `app/src-tauri/prep.mjs` | copies the page files into `src-tauri/dist`, which is what gets embedded |
| `app/stamp-version.mjs` | copies `VERSION` into the app's version files |
| `app/test/` | `node --test`, no dependencies |
| `packaging/README-FIRST.txt` | the note shipped inside the Windows zip |
| `.github/` | workflows, the VirusTotal scanner (`scripts/vt_scan.py`, stdlib Python run only in CI) and its badge |

`app/README.md` describes the website itself and its module map.

## Running and testing

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

## Versions

`VERSION` is the only place a version is typed (two parts, `1.9`). The app's
copies — `src/version.js` (`"1.9"`), and `tauri.conf.json`, `Cargo.toml` and
the `cgbuy` entry in `Cargo.lock` (`"1.9.0"`; Tauri insists on three parts) —
are written by `node app/stamp-version.mjs`. `node app/stamp-version.mjs
--check` and `app/test/version.test.js` fail if any has drifted, so after
changing `VERSION` by hand, run the stamp. The release workflow does that
itself. The version is also what EDDN records as `softwareVersion` and what
the update check compares against.

## What ships, and under what name

Built by `cargo tauri build` (not `tauri-action`, which would want to own the
release and the file names that this repo's workflows already own). Release
assets carry their version, so a second download never lands as `cgbuy(1)`:

- `cgbuy-v<ver>-windows.zip` — a folder with the single `cgbuy.exe` and
  `README-FIRST.txt` (`packaging/README-FIRST.txt`). Needs WebView2, which
  Windows 10/11 ship with. Built with `--no-bundle`: no installer, because the
  NSIS setup.exe drew 3/75 heuristic VirusTotal hits (APEX, Cylance,
  DeepInstinct) while the same exe zipped scored 0/75.
- `cgbuy-v<ver>-linux.AppImage`, `-linux.deb`, and `-linux`, the bare binary,
  which needs libwebkit2gtk-4.1 installed.

Snapshots use the short commit instead of `v<ver>`. A GitHub release asset
carries no POSIX mode, so the execute bit is lost on upload and the Linux files
need a `chmod +x` after download.

`packaging/README-FIRST.txt` has `@VERSION@` substituted at build time and its
line endings forced to CRLF during packaging, because the `.gitattributes`
`eol=crlf` rule cannot be relied on to survive checkout on the runner — a build
that trusted it shipped an LF file that opens in Notepad as one long line.

## CI

| Workflow | Trigger | Does |
|---|---|---|
| `build.yml` | push to `main`, PRs | `build-linux` and `build-windows` (web + Rust tests, version check, build, package); on PRs `virustotal-preview`; on `main` also `snapshot`, which refreshes the rolling pre-release |
| `release.yml` | manual dispatch | `tag` (validate, test, bump `VERSION`, stamp, tag), `build-linux`, `build-windows`, `publish`, `virustotal` |
| `pages.yml` | push to `main`, PRs | tests and builds the website; deploys it on `main` |

The `snapshot` tag is reused on every push, and its assets are keyed to the
short commit. Because those names change per push, same-name replacement no
longer clears the previous build, so the snapshot release is emptied of assets
before new ones are uploaded. Forget that and the downloads list grows forever.

## Cutting a release

Actions → **release** → Run workflow → a version like `2.2` (no leading `v`),
plus optional extra notes. It refuses a version that is malformed or already
tagged, runs the web tests before anything is tagged, writes `VERSION` and
stamps the same number into `app/`, commits, tags, builds both platforms,
publishes, and then scans the Windows zip and the Linux binary on VirusTotal —
appending counts, hashes and flagging engine names to the release notes and
refreshing the badge (which tracks the Windows zip) on `main`.

The VirusTotal step needs the `VT_API_KEY` secret and never fails a release:
the binaries are already out, and VirusTotal being slow is not a broken build.
It is release-only because doing it per push would burn the free key's daily
quota. `virustotal-preview` in `build.yml` scans the Windows zip on PRs and
manual runs and writes the verdict to the job summary (never the badge); it is
skipped when `VT_API_KEY` is unavailable, e.g. on fork PRs.

## Website (GitHub Pages)

The site is `app/index.html app.js style.css icon.png src` served as-is by
`.github/workflows/pages.yml`. It deploys from this repo on a push to main (or
a manual run); on a PR it runs the tests and builds the artifact but does not
deploy.

One-time step, by the owner: Settings -> Pages -> Source = "GitHub Actions".
Until that is set the first deploy fails. The expected URL is
`https://knowhowit.com.au/ed-cg-buyfinder/` (confirm it serves the new path).

Decommissioning the old `ed-cg-buyfinder-web` site, in order:

1. Merge this PR and enable Pages as above.
2. Check the new URL loads and works.
3. In the old repo, push the `moved-notice` branch (banner plus a 10 s redirect
   to the new URL) and merge it to its main so its Pages workflow redeploys.
4. Later, once nobody is using the old URL, archive the old repo.

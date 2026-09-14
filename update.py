#!/usr/bin/env python3
"""
"There is a newer version" - and nothing more than that.

Deliberately not an updater. The Windows build is a folder of DLLs that scans
clean precisely because nothing in it downloads or executes anything, and a
program that replaces its own binaries is the shape antivirus engines score.
So this asks GitHub for the latest release tag, compares it with the running
version, and hands the answer back. Fetching the new build is the user's
click, in their own browser.

It is also deliberately quiet:
  * off unless switched on in Settings
  * one request, at startup, once per run - there is no poller and no nag
  * any failure at all is silence, not a message

Standalone:  python3 update.py
"""

import sys
import webbrowser

OWNER_REPO = "joebywan/ed-cg-buyfinder"

# /releases/latest skips drafts and pre-releases, so the rolling `snapshot`
# release that every push to main refreshes is invisible here - which is what
# we want. A snapshot user is told about stable releases, not about snapshots.
RELEASES_API = "https://api.github.com/repos/%s/releases/latest" % OWNER_REPO
RELEASES_PAGE = "https://github.com/%s/releases/latest" % OWNER_REPO


def parse_version(text):
    """'v1.10' -> (1, 10). None if it is not a plain dotted number.

    Strict on purpose: this decides whether to interrupt someone, and an
    unparseable tag should say nothing rather than guess.
    """
    if not isinstance(text, str):
        return None
    parts = text.strip().lstrip("vV").split(".")
    if not parts or len(parts) > 4:
        return None
    out = []
    for p in parts:
        if not p.isdigit():          # rejects "", "1a", "-1" and "1 "
            return None
        out.append(int(p))
    return tuple(out)


def is_newer(latest, current):
    """Is `latest` a higher version than `current`?

    String comparison gets this wrong at 1.10 vs 1.9, which is the whole
    reason this is not `latest > current`. Unparseable either side is False:
    never nag on something we do not understand.
    """
    a, b = parse_version(latest), parse_version(current)
    if a is None or b is None:
        return False
    n = max(len(a), len(b))          # 1.5.1 beats 1.5, and 1.5 ties 1.5.0
    return a + (0,) * (n - len(a)) > b + (0,) * (n - len(b))


def running_from_source():
    """True for `python cgbuy` out of a clone, False for a built binary.

    Only used to word the hint: a source install updates with git pull, not
    by downloading a zip.
    """
    if getattr(sys, "frozen", False):        # PyInstaller (the Linux build)
        return False
    if "__compiled__" in globals():          # Nuitka (the Windows build)
        return False
    return True


def latest_version(fetch=None, timeout=10):
    """The newest published release's version, or None.

    `fetch` is injected by the app so it reuses the one HTTP helper - and by
    the tests, so they never open a socket.
    """
    if fetch is None:
        import json
        import urllib.request
        from version import AGENT

        def fetch(url, timeout=timeout):
            req = urllib.request.Request(
                url, headers={"User-Agent": AGENT,      # GitHub 403s without
                              "Accept": "application/vnd.github+json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)

    doc = fetch(RELEASES_API, timeout=timeout)
    tag = doc.get("tag_name") if isinstance(doc, dict) else None
    return tag if parse_version(tag) else None


def check(cfg, current, fetch=None):
    """The newer version as a bare string ('1.6'), or None to say nothing.

    Never raises. Offline, rate-limited, proxied, GitHub down, a tag in a
    shape we do not parse - all of it is None, because a background courtesy
    check has no business surfacing an error.
    """
    if not cfg.get("update_check"):
        return None
    try:
        latest = latest_version(fetch=fetch)
    except Exception:
        return None
    if latest and is_newer(latest, current):
        return latest.lstrip("vV")
    return None


def open_page():
    """Open the releases page. Only ever called from a click."""
    try:
        return bool(webbrowser.open_new_tab(RELEASES_PAGE))
    except Exception:
        return False


if __name__ == "__main__":
    from version import VERSION
    print("running   :", VERSION)
    print("from source:", running_from_source())
    print("latest    :", latest_version())
    print("would show:", check({"update_check": True}, VERSION))

#!/usr/bin/env python3
"""
Drive Elite's galaxy map from the pilot seat to plot a route.

Elite has no route-plotting API, so this is keystroke automation: it presses
your real Galaxy Map bind, types the system into the search box, and confirms.
That means it is inherently timing- and state-dependent - if the map is not
where the macro expects, the keys land on your flight controls.

Every step is editable in ~/.config/cgbuy.json under "plot_macro", because no
fixed sequence survives every UI version and every commander's binds.

Standalone check:  python3 plot.py --check
"""

import os
import subprocess
import xml.etree.ElementTree as ET

ELITE_PATTERNS = ["Elite - Dangerous (CLIENT)", "Elite - Dangerous"]

# Status.json GuiFocus values. The game publishes this live, which lets the
# macro confirm where it actually is instead of pressing blind.
GUI_NONE, GUI_LEFT_PANEL = 0, 1
GUI_STATION_SERVICES = 5
GUI_GALAXY_MAP = 6
GUI_SYSTEM_MAP = 7
GUI_NAMES = {0: "cockpit", 1: "left panel", 2: "right panel", 3: "comms",
             4: "role panel", 5: "station services", 6: "galaxy map",
             7: "system map", 8: "orrery", 9: "FSS", 10: "SAA", 11: "codex"}


def read_gui_focus(journal_dir):
    """Current UI focus, or None if Status.json is unreadable."""
    import json
    try:
        with open(os.path.join(journal_dir, "Status.json"),
                  encoding="utf-8", errors="replace") as fh:
            return json.load(fh).get("GuiFocus")
    except (OSError, ValueError, TypeError):
        return None


def wait_for_gui(journal_dir, target, timeout=8.0, poll=0.25):
    """Block until GuiFocus reaches `target`. Returns the final value."""
    import time
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = read_gui_focus(journal_dir)
        if last == target:
            return last
        time.sleep(poll)
    return last

BINDS_GLOB = (
    "AppData/Local/Frontier Developments/Elite Dangerous/Options/Bindings")

# xdotool spellings for the Elite binds-file key names that differ.
KEYMAP = {
    "Space": "space", "Enter": "Return", "Backspace": "BackSpace",
    "UpArrow": "Up", "DownArrow": "Down", "LeftArrow": "Left",
    "RightArrow": "Right", "Escape": "Escape", "Tab": "Tab",
    "LeftShift": "shift", "RightShift": "shift",
    "LeftControl": "ctrl", "RightControl": "ctrl",
    "LeftAlt": "alt", "RightAlt": "alt",
    # xdotool uses X keysyms, which differ from Elite's names for these.
    "PageUp": "Prior", "PageDown": "Next", "Insert": "Insert",
    "Home": "Home", "End": "End", "Delete": "Delete",
    "Comma": "comma", "Period": "period", "Minus": "minus",
}

# Route A - through the cockpit panel, using your existing binds. Needs no
# changes to your control setup, but the panel remembers its last tab and
# cursor position, so the navigation steps are not deterministic and need
# tuning once.
def default_panel_macro(binds=None):
    focus = read_bind(binds, "UIFocus") or "shift"
    left = read_bind(binds, "UI_Left") or "a"
    sel = read_bind(binds, "UI_Select") or "space"
    up = read_bind(binds, "UI_Up") or "w"
    return [
        {"key": "%s+%s" % (focus, left), "wait": 1.5,
         "note": "open the left cockpit panel"},
        {"key": up, "wait": 0.4, "note": "move to the panel tab row"},
        {"key": sel, "wait": 2.5, "note": "open Galaxy Map"},
        {"key": "ctrl+a", "wait": 0.3, "note": "clear any existing search"},
        {"type": "<SYSTEM>", "wait": 1.2, "note": "type the destination"},
        {"key": "Return", "wait": 2.0, "note": "run the search"},
        {"key": "Return", "wait": 0.5, "note": "select result / plot route"},
    ]


# Route B - a dedicated Galaxy Map bind. One keystroke, no cursor state, so
# it works the same every time. Requires binding GalaxyMapOpen in Elite.
DEFAULT_MACRO = [
    {"key": "<GALAXYMAP>", "wait": 3.0, "note": "open the galaxy map"},
    {"key": "ctrl+a", "wait": 0.3, "note": "select any existing search text"},
    {"type": "<SYSTEM>", "wait": 1.2, "note": "type the destination"},
    {"key": "Return", "wait": 2.0, "note": "run the search"},
    {"key": "Return", "wait": 0.5, "note": "select the result / plot"},
]


def run(args, timeout=20):
    try:
        p = subprocess.run(args, capture_output=True, timeout=timeout, text=True)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except (OSError, subprocess.SubprocessError) as e:
        return 1, "", str(e)


def have_xdotool():
    return run(["which", "xdotool"])[0] == 0


def find_elite_window():
    for pat in ELITE_PATTERNS:
        rc, out, _ = run(["xdotool", "search", "--name", pat])
        if rc == 0 and out:
            return out.split("\n")[-1].strip()
    return None


def find_binds_file(prefix_hint=None):
    """Locate the newest Custom.*.binds under any Elite install."""
    import glob
    roots = []
    if prefix_hint:
        roots.append(os.path.join(prefix_hint, BINDS_GLOB))
    roots += [
        os.path.expanduser("~/" + BINDS_GLOB),
        "/media/*/SteamLibrary/steamapps/compatdata/359320/pfx/drive_c/users/steamuser/" + BINDS_GLOB,
        "/mnt/*/SteamLibrary/steamapps/compatdata/359320/pfx/drive_c/users/steamuser/" + BINDS_GLOB,
        os.path.expanduser("~/.steam/steam/steamapps/compatdata/359320/pfx/drive_c/users/steamuser/" + BINDS_GLOB),
        os.path.expanduser("~/.local/share/Steam/steamapps/compatdata/359320/pfx/drive_c/users/steamuser/" + BINDS_GLOB),
    ]
    found = []
    for r in roots:
        found += glob.glob(os.path.join(r, "*.binds"))
    return max(found, key=os.path.getmtime) if found else None


def read_bind(binds_path, action):
    """Return an xdotool key spec for an Elite action, or None if unbound."""
    if not binds_path or not os.path.exists(binds_path):
        return None
    try:
        root = ET.parse(binds_path).getroot()
    except (ET.ParseError, OSError):
        return None
    el = root.find(action)
    if el is None:
        return None
    for tag in ("Primary", "Secondary"):
        b = el.find(tag)
        if b is None:
            continue
        if b.get("Device") != "Keyboard":
            continue                      # xdotool cannot press a HOTAS button
        key = (b.get("Key") or "").replace("Key_", "")
        if not key:
            continue
        mods = [KEYMAP.get(m.get("Key", "").replace("Key_", ""),
                           m.get("Key", "").replace("Key_", "").lower())
                for m in b.findall("Modifier")
                if m.get("Device") == "Keyboard"]
        k = KEYMAP.get(key, key if len(key) > 1 else key.lower())
        return "+".join(mods + [k]) if mods else k
    return None


# Keys offered in the settings dialog. Anything xdotool can press works, but
# these are the ones Elite commanders usually have spare.
BINDABLE_KEYS = ["F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11",
                 "Insert", "Home", "PageUp", "Delete", "End", "PageDown"]


def keys_in_use(binds_path):
    """Plain (unmodified) keyboard keys already bound to something."""
    used = set()
    if not binds_path or not os.path.exists(binds_path):
        return used
    try:
        root = ET.parse(binds_path).getroot()
    except (ET.ParseError, OSError):
        return used
    for action in root:
        for tag in ("Primary", "Secondary"):
            b = action.find(tag)
            if b is None or b.get("Device") != "Keyboard":
                continue
            key = (b.get("Key") or "").replace("Key_", "")
            if key and not b.findall("Modifier"):
                used.add(key)
    return used


def set_bind(binds_path, action, key, backup=True):
    """Write a keyboard bind into Elite's binds file. Returns (ok, message)."""
    import shutil, time as _t
    if not binds_path or not os.path.exists(binds_path):
        return False, "binds file not found"
    try:
        tree = ET.parse(binds_path)
    except (ET.ParseError, OSError) as e:
        return False, "cannot parse binds: %s" % e
    root = tree.getroot()
    el = root.find(action)
    if el is None:
        return False, "%s not present in binds file" % action
    if backup:
        try:
            shutil.copy2(binds_path, "%s.cgbuy-backup-%s"
                         % (binds_path, _t.strftime("%Y%m%d-%H%M%S")))
        except OSError:
            pass
    prim = el.find("Primary")
    if prim is None:
        prim = ET.SubElement(el, "Primary")
    for m in prim.findall("Modifier"):
        prim.remove(m)
    prim.set("Device", "Keyboard")
    prim.set("Key", "Key_%s" % key)
    try:
        tree.write(binds_path, encoding="UTF-8", xml_declaration=True)
    except OSError as e:
        return False, "cannot write binds: %s" % e
    return True, "bound %s to %s (restart Elite to apply)" % (action, key)


def galaxy_map_key(binds_path=None, override=None):
    if override:
        return override
    return read_bind(binds_path or find_binds_file(), "GalaxyMapOpen")


def plot_route(system, journal_dir, gm_key=None, dry_run=False,
               open_timeout=8.0, type_delay=30):
    """Open the galaxy map, confirm it is open, then search for `system`.

    Closed-loop: every stage is verified against Status.json GuiFocus, so we
    never type a system name into the cockpit. If the map does not open, we
    stop rather than pressing on.
    """
    import time
    log = []
    if not have_xdotool():
        return False, "xdotool is not installed", log
    win = find_elite_window()
    if not win:
        return False, "Elite window not found", log
    if not gm_key:
        return False, "no Galaxy Map key bound", log

    focus = read_gui_focus(journal_dir)
    log.append("start focus=%s" % GUI_NAMES.get(focus, focus))

    if dry_run:
        log.append("key %s -> wait for galaxy map" % gm_key)
        log.append("type %r" % system)
        log.append("key Return")
        return True, "dry run", log

    run(["xdotool", "windowactivate", "--sync", win])
    time.sleep(0.3)

    if focus != GUI_GALAXY_MAP:
        run(["xdotool", "key", "--clearmodifiers", "--window", win, gm_key])
        focus = wait_for_gui(journal_dir, GUI_GALAXY_MAP, open_timeout)
        log.append("after %s: focus=%s" % (gm_key, GUI_NAMES.get(focus, focus)))
        if focus != GUI_GALAXY_MAP:
            # Put it back the way we found it rather than leaving a panel open.
            return (False,
                    "galaxy map did not open (focus=%s). If Elite was running "
                    "when the bind was added, restart it."
                    % GUI_NAMES.get(focus, focus), log)

    time.sleep(0.6)
    run(["xdotool", "key", "--clearmodifiers", "--window", win, "ctrl+a"])
    run(["xdotool", "type", "--clearmodifiers", "--window", win,
         "--delay", str(type_delay), system], timeout=30)
    log.append("typed %r" % system)
    time.sleep(0.9)
    run(["xdotool", "key", "--clearmodifiers", "--window", win, "Return"])
    log.append("Return (search)")
    time.sleep(1.6)
    run(["xdotool", "key", "--clearmodifiers", "--window", win, "Return"])
    log.append("Return (select/plot)")

    return True, "plotted %s" % system, log


def run_macro(system, macro=None, gm_key=None, dry_run=False):
    """Execute a user-defined key macro (the manual fallback)."""
    import time
    log = []
    if not have_xdotool():
        return False, "xdotool is not installed", log
    win = find_elite_window()
    if not win:
        return False, "Elite window not found", log

    steps = macro or default_panel_macro(find_binds_file())
    if any("<GALAXYMAP>" in str(s.get("key", "")) for s in steps) and not gm_key:
        return (False,
                "Galaxy Map is not bound to a keyboard key - bind it in Elite "
                "(Controls > Interface Mode > Galaxy Map) or set "
                "\"galaxy_map_key\" in the config", log)

    if not dry_run:
        run(["xdotool", "windowactivate", "--sync", win])
        time.sleep(0.3)

    for st in steps:
        wait = float(st.get("wait", 0.4))
        if "key" in st:
            spec = str(st["key"]).replace("<GALAXYMAP>", gm_key or "")
            if not spec:
                continue
            log.append("key %s" % spec)
            if not dry_run:
                run(["xdotool", "key", "--clearmodifiers", "--window", win, spec])
        elif "type" in st:
            text = str(st["type"]).replace("<SYSTEM>", system)
            log.append("type %r" % text)
            if not dry_run:
                run(["xdotool", "type", "--clearmodifiers", "--window", win,
                     "--delay", "30", text], timeout=30)
        if not dry_run:
            time.sleep(wait)

    return True, ("dry run: %d steps" % len(steps)) if dry_run else \
        "sent %d steps for %s" % (len(steps), system), log


if __name__ == "__main__":
    import sys, json
    b = find_binds_file()
    print("binds file    :", b or "NOT FOUND")
    print("galaxy map key:", galaxy_map_key(b) or "UNBOUND (keyboard)")
    print("ui_select     :", read_bind(b, "UI_Select"))
    print("xdotool       :", have_xdotool())
    print("elite window  :", find_elite_window())
    if "--check" in sys.argv:
        ok, msg, log = run_macro("Scorpii Sector FM-V b2-7",
                                 gm_key=galaxy_map_key(b) or "F6", dry_run=True)
        print("dry run       :", ok, msg)
        for l in log:
            print("   ", l)

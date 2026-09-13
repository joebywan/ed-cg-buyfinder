#!/usr/bin/env python3
"""
Desktop notifications, for when the window is behind the game.

The app is useful precisely when you are not looking at it: it re-searches on
docking, and the answer can change while you are in the cockpit. A silent
update is a wasted one.

Channels, best first:
  * notify-send (Linux, libnotify) - a real desktop notification
  * PowerShell toast (Windows 10+)
  * the window title and the terminal bell, which work everywhere

Standalone:  python3 notify.py
"""

import os
import shutil
import subprocess
import sys
import threading

APP_NAME = "cgbuy"

# urgency -> (notify-send level, whether to also ring the bell)
LEVELS = {"low": ("low", False), "normal": ("normal", True),
          "high": ("critical", True)}


def _have(cmd):
    return shutil.which(cmd) is not None


def _linux(title, body, urgency):
    level = LEVELS.get(urgency, LEVELS["normal"])[0]
    try:
        subprocess.run(["notify-send", "-a", APP_NAME, "-u", level,
                        title, body], timeout=5, capture_output=True)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def _windows(title, body, urgency):
    """Toast via PowerShell. Best effort - the format is finicky and some
    hosts have script execution disabled, so failure is expected and fine."""
    ps = (
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications,"
        " ContentType=WindowsRuntime] > $null;"
        "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(1);"
        "$x=$t.GetElementsByTagName('text');"
        "$x.Item(0).AppendChild($t.CreateTextNode('%s')) > $null;"
        "$x.Item(1).AppendChild($t.CreateTextNode('%s')) > $null;"
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('%s')"
        ".Show([Windows.UI.Notifications.ToastNotification]::new($t))"
        % (title.replace("'", " "), body.replace("'", " "), APP_NAME)
    )
    try:
        subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                       timeout=8, capture_output=True)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def send(title, body, urgency="normal", root=None):
    """Notify however this machine can. Never raises, never blocks the caller.

    `root` is an optional Tk window: its title is marked and the bell rung, so
    something is visible in the taskbar even with no notification daemon.
    """
    def work():
        ok = False
        if sys.platform.startswith("linux") and _have("notify-send"):
            ok = _linux(title, body, urgency)
        elif sys.platform == "win32":
            ok = _windows(title, body, urgency)
        if not ok and sys.platform == "darwin" and _have("osascript"):
            try:
                subprocess.run(["osascript", "-e",
                                'display notification "%s" with title "%s"'
                                % (body.replace('"', " "), title.replace('"', " "))],
                               timeout=5, capture_output=True)
            except (OSError, subprocess.SubprocessError):
                pass

    threading.Thread(target=work, daemon=True).start()

    if root is not None:
        try:
            if LEVELS.get(urgency, LEVELS["normal"])[1]:
                root.bell()
            _mark_title(root, title)
        except Exception:
            pass


def _mark_title(root, title):
    """Put the news in the taskbar, and clear it when the window is next used."""
    base = getattr(root, "_cgbuy_base_title", None)
    if base is None:
        base = root.title()
        root._cgbuy_base_title = base
    root.title("* %s - %s" % (title, base))

    def clear(_e=None):
        try:
            root.title(root._cgbuy_base_title)
        except Exception:
            pass

    root.bind("<FocusIn>", clear, add="+")
    root.bind("<Button-1>", clear, add="+")


def set_base_title(root, text):
    """Retitle the window, and make it what a cleared marker restores.

    _mark_title remembers the first title it saw; without this, clearing a
    marker after the destination changed would put the old place back.
    """
    root._cgbuy_base_title = text
    root.title(text)


if __name__ == "__main__":
    print("platform :", sys.platform)
    print("notify-send:", _have("notify-send"))
    send("cgbuy", "Notification test - if you see this, it works.")
    import time
    time.sleep(2)
    print("sent")

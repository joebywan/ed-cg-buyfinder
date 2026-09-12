#!/usr/bin/env python3
"""
A virtual keyboard via /dev/uinput.

Elite (under Proton) accepts synthetic X key events for *bound actions* but
ignores them for *text entry* - typing into the galaxy map search box does
nothing. uinput injects at the kernel input layer instead, so the characters
are indistinguishable from a real keyboard and reach every input path.

Needs write access to /dev/uinput. On Mint that is granted to the logged-in
user by systemd-logind, so no root and no udev rule is required.
"""

import fcntl
import os
import struct
import time

UINPUT = "/dev/uinput"

EV_SYN, EV_KEY = 0x00, 0x01
SYN_REPORT = 0

_IOC_WRITE = 1
def _iow(t, nr, size):
    return (_IOC_WRITE << 30) | (size << 16) | (ord(t) << 8) | nr
def _io(t, nr):
    return (ord(t) << 8) | nr

UI_SET_EVBIT = _iow('U', 100, 4)
UI_SET_KEYBIT = _iow('U', 101, 4)
UI_DEV_CREATE = _io('U', 1)
UI_DEV_DESTROY = _io('U', 2)

# Linux input event codes (linux/input-event-codes.h)
KEY = {
    "a": 30, "b": 48, "c": 46, "d": 32, "e": 18, "f": 33, "g": 34, "h": 35,
    "i": 23, "j": 36, "k": 37, "l": 38, "m": 50, "n": 49, "o": 24, "p": 25,
    "q": 16, "r": 19, "s": 31, "t": 20, "u": 22, "v": 47, "w": 17, "x": 45,
    "y": 21, "z": 44,
    "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10,
    "0": 11,
    "-": 12, "=": 13, "[": 26, "]": 27, ";": 39, "'": 40, "`": 41,
    "\\": 43, ",": 51, ".": 52, "/": 53, " ": 57,
    "enter": 28, "esc": 1, "backspace": 14, "tab": 15, "space": 57,
    "leftshift": 42, "leftctrl": 29, "leftalt": 56,
    "f1": 59, "f2": 60, "f3": 61, "f4": 62, "f5": 63, "f6": 64, "f7": 65,
    "f8": 66, "f9": 67, "f10": 68, "f11": 87, "f12": 88,
    "home": 102, "up": 103, "pageup": 104, "left": 105, "right": 106,
    "end": 107, "down": 108, "pagedown": 109, "insert": 110, "delete": 111,
}
SHIFTED = {
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7",
    "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]",
    ":": ";", '"': "'", "~": "`", "|": "\\", "<": ",", ">": ".", "?": "/",
}


class VirtualKeyboard:
    def __init__(self, name="cgbuy virtual keyboard"):
        self.fd = os.open(UINPUT, os.O_WRONLY | os.O_NONBLOCK)
        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_KEY)
        for code in set(KEY.values()):
            fcntl.ioctl(self.fd, UI_SET_KEYBIT, code)
        # struct uinput_user_dev: name[80], id{bustype,vendor,product,version},
        # ff_effects_max, absmax/absmin/absfuzz/absflat [64] each
        dev = struct.pack("80sHHHHi" + "i" * 64 * 4,
                          name.encode()[:79], 0x03, 0x1234, 0x5678, 1, 0,
                          *([0] * 256))
        os.write(self.fd, dev)
        fcntl.ioctl(self.fd, UI_DEV_CREATE)
        time.sleep(0.35)          # let udev notice the new device

    def _emit(self, etype, code, value):
        # struct input_event: timeval (2 longs), type, code, value
        os.write(self.fd, struct.pack("llHHi", 0, 0, etype, code, value))

    def _syn(self):
        self._emit(EV_SYN, SYN_REPORT, 0)

    def tap(self, code, hold=0.03, shift=False):
        if shift:
            self._emit(EV_KEY, KEY["leftshift"], 1); self._syn()
        self._emit(EV_KEY, code, 1); self._syn()
        time.sleep(hold)
        self._emit(EV_KEY, code, 0); self._syn()
        if shift:
            self._emit(EV_KEY, KEY["leftshift"], 0); self._syn()

    def type(self, text, hold=0.03, gap=0.03):
        for ch in text:
            shift = False
            if ch.isupper():
                ch, shift = ch.lower(), True
            elif ch in SHIFTED:
                ch, shift = SHIFTED[ch], True
            code = KEY.get(ch)
            if code is None:
                continue
            self.tap(code, hold, shift)
            time.sleep(gap)

    def key(self, name, hold=0.05):
        code = KEY.get(name.lower())
        if code is not None:
            self.tap(code, hold)

    def close(self):
        try:
            fcntl.ioctl(self.fd, UI_DEV_DESTROY)
        except OSError:
            pass
        os.close(self.fd)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


def available():
    try:
        fd = os.open(UINPUT, os.O_WRONLY | os.O_NONBLOCK)
        os.close(fd)
        return True
    except OSError:
        return False


if __name__ == "__main__":
    print("uinput available:", available())

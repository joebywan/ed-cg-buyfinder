ED CG Buyfinder @VERSION@ - Elite Dangerous community goal buy finder
https://github.com/joebywan/ed-cg-buyfinder


RUNNING IT

  1. Extract this whole folder somewhere you will find it again.
     Do not run it from inside the zip: Windows opens zips like
     folders, but the program cannot start from there.

  2. Double-click ed-cg-buyfinder.exe.

That is the entire install. There is no installer, nothing is
written to the registry, and nothing is set to run at startup.

ed-cg-buyfinder.exe is a single file: it can be moved or copied on its own.


WEBVIEW2

The window is drawn by Microsoft's WebView2 runtime. It comes with
Windows 11 and with up-to-date Windows 10, so you almost certainly
have it. If ed-cg-buyfinder.exe will not open, install the "Evergreen
Bootstrapper" from
https://developer.microsoft.com/microsoft-edge/webview2/


UPGRADING FROM THE OLD PYTHON cgbuy

This is a new app. On first run it reads the old %APPDATA%\cgbuy.json
and carries your settings over; the old files can then be deleted.

UPGRADING FROM cgbuy.exe (THE EARLIER NAME OF THIS APP)

The app used to be called cgbuy. Settings carry over automatically
from %APPDATA%\cgbuy-desktop.json; the old cgbuy.exe can be deleted.


THE FIRST TIME YOU RUN IT

Windows SmartScreen will warn you, because this program is not
code-signed. Click "More info", then "Run anyway". It is not signed
because a certificate costs more per year than this project has
ever cost to run, and that is unlikely to change.

ED CG Buyfinder finds your Elite Dangerous journals on its own, at

  %USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous

If it does not find yours, set the folder by hand in Settings.


UNINSTALLING

Delete ed-cg-buyfinder.exe. Your settings are the one file

  %APPDATA%\ed-cg-buyfinder.json

delete that too if you want no trace left.


SOMETHING WRONG?

https://github.com/joebywan/ed-cg-buyfinder/issues

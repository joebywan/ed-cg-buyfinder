cgbuy desktop @VERSION@ - Elite Dangerous community goal buy finder
https://github.com/joebywan/ed-cg-buyfinder


RUNNING IT

  1. Extract this whole folder somewhere you will find it again.
     Do not run it from inside the zip: Windows opens zips like
     folders, but the program cannot start from there.

  2. Double-click cgbuy.exe.

That is the entire install. There is no installer, nothing is
written to the registry, and nothing is set to run at startup.

Unlike the older cgbuy-v*-windows.zip, this one really is a single
file: cgbuy.exe can be moved or copied on its own.


WEBVIEW2

The window is drawn by Microsoft's WebView2 runtime. It comes with
Windows 11 and with up-to-date Windows 10, so you almost certainly
have it. If cgbuy.exe will not open, install the "Evergreen
Bootstrapper" from
https://developer.microsoft.com/microsoft-edge/webview2/


THE FIRST TIME YOU RUN IT

Windows SmartScreen will warn you, because this program is not
code-signed. Click "More info", then "Run anyway". It is not signed
because a certificate costs more per year than this project has
ever cost to run, and that is unlikely to change.

cgbuy finds your Elite Dangerous journals on its own, at

  %USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous

If it does not find yours, set the folder by hand in Settings.


UNINSTALLING

Delete cgbuy.exe. Your settings are the one file

  %APPDATA%\cgbuy-desktop.json

delete that too if you want no trace left.


SOMETHING WRONG?

https://github.com/joebywan/ed-cg-buyfinder/issues

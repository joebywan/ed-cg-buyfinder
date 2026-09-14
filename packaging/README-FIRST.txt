cgbuy @VERSION@ - Elite Dangerous community goal buy finder
https://github.com/joebywan/ed-cg-buyfinder


RUNNING IT

  1. Extract this whole folder somewhere you will find it again.
     Your Documents folder is fine. Do not run it from inside the
     zip: Windows opens zips like folders, but the program cannot
     start from there.

  2. Double-click cgbuy.exe.

That is the entire install. There is no installer, nothing is
written to the registry, and nothing is set to run at startup.


KEEP THE FOLDER TOGETHER

cgbuy.exe is not self-contained. The .dll files and the tcl and tk
folders sitting next to it are part of the program, and it will not
start without them. Move or copy the whole folder, never just the
.exe on its own.

For a desktop or taskbar entry, right-click cgbuy.exe, choose
"Send to" then "Desktop (create shortcut)", and pin that shortcut.
A shortcut is fine; a copy of the .exe is not.


THE FIRST TIME YOU RUN IT

Windows SmartScreen will warn you, because this program is not
code-signed. Click "More info", then "Run anyway". It is not signed
because a certificate costs more per year than this project has
ever cost to run, and that is unlikely to change.

cgbuy finds your Elite Dangerous journals on its own, at

  %USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous

including the OneDrive-redirected version of that path and Steam
libraries on other drive letters. If it does not find yours, set
the folder by hand in Settings.


WHAT IT WRITES

  %APPDATA%\cgbuy.json              your settings
  %LOCALAPPDATA%\cgbuy-results.json a cache of the last results

Nothing else, anywhere.


ANTIVIRUS

This build should scan clean. Previous releases shipped as a single
.exe that unpacked itself at startup, and a handful of engines flag
that behaviour generically no matter what the program does - which
is exactly why cgbuy is now a folder instead. Each release on
GitHub carries a VirusTotal scan of the files in that release.


UNINSTALLING

Delete this folder. If you want no trace left, also delete the two
files listed under WHAT IT WRITES.


SOMETHING WRONG?

https://github.com/joebywan/ed-cg-buyfinder/issues

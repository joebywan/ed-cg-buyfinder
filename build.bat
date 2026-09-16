@echo off
REM Build the standalone cgbuy folder on Windows.
REM Needs Python 3 with tkinter (the python.org installer includes it).
REM PyInstaller cannot cross-compile and neither can Nuitka: a Windows build
REM must be made here.
REM
REM Nuitka --standalone, not a single packed .exe: the self-extracting one-file
REM format is what antivirus engines flag, whichever tool produces it. Measured
REM on one commit -- PyInstaller one-file 7/75, Nuitka one-file 15/75, Nuitka
REM standalone 0/75. Slower to compile; that is the whole cost.

cd /d "%~dp0"
if not exist .venv (
    python -m venv .venv || goto :err
)
.venv\Scripts\python -m pip install --quiet --upgrade pip nuitka || goto :err

copy /y cgbuy build_src.py >nul
.venv\Scripts\python -m nuitka --standalone --assume-yes-for-downloads ^
    --enable-plugin=tk-inter --windows-console-mode=disable ^
    --windows-icon-from-ico="%~dp0icon.ico" ^
    --output-dir=nuitka --output-filename=cgbuy.exe build_src.py || goto :err

if exist cgbuy-windows rmdir /s /q cgbuy-windows
move /y nuitka\build_src.dist cgbuy-windows >nul
REM The same note that ships in the release zip, so a local build is testable
REM as the thing users actually get.
powershell -NoProfile -Command ^
    "(Get-Content packaging\README-FIRST.txt) -replace '@VERSION@','local build' | Set-Content cgbuy-windows\README-FIRST.txt" || goto :err

del build_src.py
rmdir /s /q nuitka
echo Built cgbuy-windows\cgbuy.exe
echo Ship the whole cgbuy-windows folder; the .exe will not run without it.
goto :eof

:err
echo Build failed.
exit /b 1

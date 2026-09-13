@echo off
REM Build a standalone cgbuy.exe on Windows.
REM Needs Python 3 with tkinter (the python.org installer includes it).
REM PyInstaller cannot cross-compile: a Windows .exe must be built here.

cd /d "%~dp0"
if not exist .venv (
    python -m venv .venv || goto :err
)
.venv\Scripts\python -m pip install --quiet --upgrade pip pyinstaller || goto :err

copy /y cgbuy build_src.py >nul
.venv\Scripts\pyinstaller --onefile --name cgbuy --clean --noconfirm ^
    --windowed --icon="%~dp0icon.ico" --distpath dist --workpath .build --specpath .build build_src.py || goto :err

move /y dist\cgbuy.exe cgbuy.exe >nul
del build_src.py
rmdir /s /q .build dist
echo Built cgbuy.exe
goto :eof

:err
echo Build failed.
exit /b 1

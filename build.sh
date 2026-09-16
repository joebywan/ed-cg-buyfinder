#!/usr/bin/env bash
# Build the standalone binary. Needs network once, for PyInstaller from PyPI.
# Linux Mint has no system pip, but python3 -m venv bootstraps pip via ensurepip.
set -euo pipefail
cd "$(dirname "$0")"

[ -d .venv ] || python3 -m venv .venv
.venv/bin/python -m pip install --quiet --upgrade pip pyinstaller

cp cgbuy build_src.py
.venv/bin/pyinstaller --onefile --name cgbuy-linux --clean --noconfirm \
    --distpath dist --workpath .build --specpath .build build_src.py
mv -f dist/cgbuy-linux ./cgbuy-linux
rm -rf build_src.py .build dist
echo "built: $(ls -lh cgbuy-linux | awk '{print $5}') -> ./cgbuy-linux"

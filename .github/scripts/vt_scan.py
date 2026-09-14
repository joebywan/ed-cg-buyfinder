#!/usr/bin/env python3
"""Scan the release binaries on VirusTotal and emit a markdown summary.

Runs after a release is published. Never fails the release: VirusTotal being
slow, rate-limited or down is not a reason to mark a good build broken, so
every failure path here exits 0 with a note instead.

Needs VT_API_KEY. A free key allows 500 requests/day at 4/minute, which is
generous for ~13 requests per binary, and is licensed for non-commercial use
only -- which this is.
"""
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "https://www.virustotal.com/api/v3"
DIRECT_UPLOAD_LIMIT = 32 * 1024 * 1024  # above this VT wants an upload_url
POLL_SECONDS = 20                       # 4 req/min ceiling, so stay well under
POLL_LIMIT = 45                         # give up after ~15 minutes


def call(path_or_url, key, data=None, content_type=None):
    url = path_or_url if path_or_url.startswith("http") else API + path_or_url
    req = urllib.request.Request(url, data=data)
    req.add_header("x-apikey", key)
    if content_type:
        req.add_header("Content-Type", content_type)
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


def multipart(path):
    """Build a multipart/form-data body without pulling in requests."""
    boundary = "----cgbuy" + hashlib.sha256(path.encode()).hexdigest()[:16]
    name = os.path.basename(path)
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    with open(path, "rb") as f:
        body = head + f.read() + tail
    return body, f"multipart/form-data; boundary={boundary}"


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def scan(path, key):
    digest = sha256(path)

    # Already known to VirusTotal? Re-uploading an identical file only burns
    # quota and starts a fresh analysis of bytes it has already seen.
    try:
        known = call(f"/files/{digest}", key)
        return digest, known["data"]["attributes"], "already on file"
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise

    body, ctype = multipart(path)
    if os.path.getsize(path) > DIRECT_UPLOAD_LIMIT:
        target = call("/files/upload_url", key)["data"]
    else:
        target = "/files"
    analysis_id = call(target, key, data=body, content_type=ctype)["data"]["id"]

    for _ in range(POLL_LIMIT):
        time.sleep(POLL_SECONDS)
        status = call(f"/analyses/{analysis_id}", key)["data"]["attributes"]["status"]
        if status == "completed":
            return digest, call(f"/files/{digest}", key)["data"]["attributes"], "scanned now"
    return digest, None, "still analysing when this job gave up"


def summarise(name, digest, attrs, note):
    link = f"https://www.virustotal.com/gui/file/{digest}"
    if attrs is None:
        return (f"| `{name}` | [pending]({link}) | — | {note} |", [], None)
    stats = attrs.get("last_analysis_stats", {})
    bad = stats.get("malicious", 0) + stats.get("suspicious", 0)
    total = sum(v for k, v in stats.items() if k != "timeout")
    flagged = sorted(
        engine
        for engine, r in (attrs.get("last_analysis_results") or {}).items()
        if r.get("category") in ("malicious", "suspicious")
    )
    return (f"| `{name}` | [{bad}/{total}]({link}) | `{digest[:16]}…` | {note} |", flagged, (bad, total))


def main():
    key = os.environ.get("VT_API_KEY", "").strip()
    if not key:
        print("VT_API_KEY not set - skipping the VirusTotal scan.", file=sys.stderr)
        return 0

    args = [a for a in sys.argv[1:] if not a.startswith("--badge=")]
    badge = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--badge=")), None)
    rows, all_flagged = [], {}
    for path in args:
        try:
            badge_path = badge
            digest, attrs, note = scan(path, key)
            row, flagged, ratio = summarise(os.path.basename(path), digest, attrs, note)
            rows.append(row)
            if flagged:
                all_flagged[os.path.basename(path)] = flagged
            # The badge tracks the Windows download, which is the one that
            # ever had detections. Matched on the name rather than on ".exe"
            # so it survived the move from a one-file exe to a zipped folder.
            if badge_path and ratio and "windows" in os.path.basename(path):
                bad, total = ratio
                # Blue rather than red: a non-zero count here is the expected
                # state for an unsigned one-file build, not a failure. The badge
                # links to the explanation so the number is never context-free.
                with open(badge_path, "w") as fh:
                    json.dump({"schemaVersion": 1,
                               "label": "virustotal",
                               "message": f"{bad}/{total}",
                               "color": "brightgreen" if bad == 0 else "informational"}, fh)
        except Exception as e:                      # noqa: BLE001 - never fail a release
            print(f"VirusTotal scan of {path} failed: {e}", file=sys.stderr)
            rows.append(f"| `{os.path.basename(path)}` | scan failed | — | {e} |")

    out = ["", "### VirusTotal", "",
           "| File | Detections | SHA-256 | |",
           "| --- | --- | --- | --- |"]
    out += rows
    out += ["",
            "Counts are a point-in-time reading taken when this release was published; "
            "follow the links for the current verdict."]
    if all_flagged:
        out.append("")
        for name, engines in all_flagged.items():
            out.append(f"Flagged `{name}`: {', '.join(engines)}.")
        out += ["",
                "These are generic heuristic detections, not a verdict on what the code does; "
                "see [Antivirus false positives](../../#antivirus-false-positives). "
                "Run from source if you would rather not take that on trust."]
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())

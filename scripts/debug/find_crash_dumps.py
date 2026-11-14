#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Locate crash dumps / cores for Study UI and solver-engine.

Windows: %LOCALAPPDATA%\\CrashDumps\\ (LocalDumps). Look for
  Holdem Study.exe.*.dmp, poker-solver-study.exe.*.dmp, solver-engine.exe.*.dmp
Linux: /var/crash, systemd-coredump, cwd cores, apport.
macOS: ~/Library/Logs/DiagnosticReports

Also prints how to enable LocalDumps if none are found on Windows.

Examples:
  python3 scripts/debug/find_crash_dumps.py
  python3 scripts/debug/find_crash_dumps.py --since-hours 48
"""

from __future__ import annotations

import argparse
import json
import platform
import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import crash_dumps_dirs, utc_now_iso, write_json  # noqa: E402

NAME_GLOBS = (
    "Holdem Study.exe*.dmp",
    "poker-solver-study.exe*.dmp",
    "solver-engine.exe*.dmp",
    "solver-engine*.dmp",
    "core",
    "core.*",
    "core-*",
    "*solver-engine*.crash",
    "*Holdem*Study*.crash",
    "*poker-solver*",
)


def _iter_candidates(roots: list[Path], since: float | None) -> list[dict]:
    found: list[dict] = []
    seen: set[str] = set()
    for root in roots:
        if not root.exists():
            continue
        patterns = list(NAME_GLOBS)
        # Broaden slightly under known dump dirs.
        if root.name.lower() in {"crashdumps", "coredump", "crash"}:
            patterns.append("*.dmp")
            patterns.append("core*")
        for pattern in patterns:
            try:
                matches = root.glob(pattern)
            except OSError:
                continue
            for path in matches:
                try:
                    if not path.is_file():
                        continue
                    st = path.stat()
                except OSError:
                    continue
                if since is not None and st.st_mtime < since:
                    continue
                key = str(path.resolve()) if path.exists() else str(path)
                if key in seen:
                    continue
                seen.add(key)
                found.append(
                    {
                        "path": str(path),
                        "sizeBytes": st.st_size,
                        "mtime": time.strftime(
                            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime)
                        ),
                        "ageHours": round((time.time() - st.st_mtime) / 3600, 2),
                    }
                )
    found.sort(key=lambda x: x["mtime"], reverse=True)
    return found


def windows_localdumps_help() -> str:
    return """
Enable Windows LocalDumps once (elevated), then reproduce the crash:

  scripts\\debug\\study-debug.cmd enable-dumps
  # or: powershell -ExecutionPolicy Bypass -File scripts\\debug\\enable_local_dumps.ps1

That configures per-exe keys under
  HKLM\\...\\LocalDumps\\Holdem Study.exe
  HKLM\\...\\LocalDumps\\solver-engine.exe
Dump folder: %LOCALAPPDATA%\\CrashDumps (DumpType=2 full, DumpCount=10).

Packaged Study uses GUI subsystem — crashes will not show a console; dumps are
the primary evidence. Illegal-instruction (0xc000001d) often means AVX-512 build
on an older CPU — rebuild with -Dcpu=x86_64_v2.
""".strip()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--since-hours", type=float, default=168.0, help="Lookback window")
    ap.add_argument(
        "--dir",
        type=Path,
        action="append",
        default=[],
        help="Extra search directory (repeatable)",
    )
    ap.add_argument("--out", type=Path)
    ap.add_argument("--json-only", action="store_true")
    args = ap.parse_args()

    since = time.time() - args.since_hours * 3600
    roots = crash_dumps_dirs() + list(args.dir)
    # macOS diagnostic reports
    if platform.system() == "Darwin":
        roots.append(Path.home() / "Library" / "Logs" / "DiagnosticReports")

    dumps = _iter_candidates(roots, since)
    report = {
        "kind": "crash-dump-search",
        "timestamp": utc_now_iso(),
        "system": platform.system(),
        "sinceHours": args.since_hours,
        "searchRoots": [str(r) for r in roots],
        "dumps": dumps,
        "count": len(dumps),
    }
    if platform.system() == "Windows" and not dumps:
        report["enableLocalDumps"] = windows_localdumps_help()

    if args.out:
        write_json(args.out, report)

    if args.json_only:
        json.dump(report, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    print(f"searched {len(roots)} roots; found {len(dumps)} dump(s)")
    for d in dumps[:20]:
        print(f"  {d['mtime']}  {d['sizeBytes']:>10}  {d['path']}")
    if not dumps:
        print("No dumps in window.")
        if platform.system() == "Windows":
            print(windows_localdumps_help())
        elif platform.system() == "Linux":
            print(
                "Tips: ulimit -c unlimited; check coredumpctl list; "
                "apport /var/crash; or run under gdb."
            )
    if args.out:
        print(f"wrote: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

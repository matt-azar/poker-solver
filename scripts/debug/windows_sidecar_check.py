#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Check Windows solver-engine PE quirks that cause blank-console / hang myths.

Product rules (AGENT_LESSONS / #290 / #288):
  - solver-engine should be WINDOWS_GUI subsystem (2), not Console (3)
  - Tauri spawn passes CREATE_NO_WINDOW as defense in depth
  - stderr must be drained or Windows ready handshake can deadlock
  - pin -Dcpu=x86_64_v2 to avoid 0xc000001d illegal instruction

This script wraps scripts/zig/check-pe-subsystem.py when a .exe is present and
always prints the checklist (useful on Linux CI reviewing a Windows artifact).

Examples:
  python3 scripts/debug/windows_sidecar_check.py
  python3 scripts/debug/windows_sidecar_check.py --exe zig-out/bin/solver-engine.exe
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import ROOT, default_solver_engine, utc_now_iso, write_json  # noqa: E402

CHECKLIST = [
    {
        "id": "gui_subsystem",
        "expect": "OptionalHeader.Subsystem == 2 (WINDOWS_GUI)",
        "symptom": "Blank console window; closing it kills sidecar and bricks Study",
        "fix": "Link solver-engine with Windows GUI subsystem; keep CLI tools Console",
    },
    {
        "id": "create_no_window",
        "expect": "Tauri spawn uses CREATE_NO_WINDOW (0x08000000)",
        "symptom": "Console flash / attach surprises on older Console builds",
        "fix": "Defense in depth in solver_engine.rs — do not remove",
    },
    {
        "id": "stderr_drain",
        "expect": "Sidecar stderr piped + drained during spawn/ready",
        "symptom": "Ready handshake deadlock when parent redirects stderr",
        "fix": "Never inherit parent stderr for the packaged sidecar",
    },
    {
        "id": "cpu_x86_64_v2",
        "expect": "Build with -Dcpu=x86_64_v2 (or ZIG_CPU)",
        "symptom": "0xc000001d illegal instruction on older hosts (AVX-512 default)",
        "fix": "scripts/build.sh + CI pin; scripts/zig/check-no-avx512.py",
    },
    {
        "id": "timeout_kill_policy",
        "expect": "Single RPC timeout must not kill in-flight train",
        "symptom": "Solve aborted because values/status timed out once",
        "fix": "Kill only on write/Broken pipe/shutdown (ZR-151 / #289)",
    },
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--exe", type=Path, help="Path to solver-engine.exe")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--json-only", action="store_true")
    args = ap.parse_args()

    exe = args.exe
    if exe is None:
        cand = default_solver_engine()
        if cand.suffix.lower() == ".exe" or cand.name.endswith(".exe"):
            exe = cand
        else:
            alt = ROOT / "zig-out" / "bin" / "solver-engine.exe"
            exe = alt if alt.is_file() else None

    pe_check: dict | None = None
    rc = 0
    if exe is not None and exe.is_file():
        checker = ROOT / "scripts" / "zig" / "check-pe-subsystem.py"
        proc = subprocess.run(
            [sys.executable, str(checker), str(exe), "--expect", "2"],
            capture_output=True,
            text=True,
            errors="replace",
            check=False,
        )
        pe_check = {
            "exe": str(exe),
            "exitCode": proc.returncode,
            "stdout": proc.stdout.strip(),
            "stderr": proc.stderr.strip(),
            "ok": proc.returncode == 0,
        }
        if proc.returncode != 0:
            rc = 1
    else:
        pe_check = {
            "exe": str(exe) if exe else None,
            "ok": None,
            "note": "No .exe present — checklist only (build on Windows or copy artifact)",
        }

    report = {
        "kind": "windows-sidecar-check",
        "timestamp": utc_now_iso(),
        "peSubsystem": pe_check,
        "checklist": CHECKLIST,
    }
    if args.out:
        write_json(args.out, report)

    if args.json_only:
        json.dump(report, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return rc

    print("Windows sidecar checklist")
    for item in CHECKLIST:
        print(f"- [{item['id']}] expect: {item['expect']}")
        print(f"    symptom: {item['symptom']}")
    if pe_check:
        print(f"PE check: {pe_check}")
    if args.out:
        print(f"wrote: {args.out}")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())

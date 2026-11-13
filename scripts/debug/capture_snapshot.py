#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Capture a live process/resource snapshot of Study + solver-engine.

Use when the UI freezes, Solve looks stuck, or the sidecar may be dead while
the shell is still up. Prefer this over killing processes first — evidence first.

Examples:
  python3 scripts/debug/capture_snapshot.py
  python3 scripts/debug/capture_snapshot.py --out /tmp/study-snap.json
  python3 scripts/debug/capture_snapshot.py --cpu-interval 1.0
"""

from __future__ import annotations

import argparse
import json
import platform
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import (  # noqa: E402
    ROOT,
    diagnostics_dir,
    list_study_processes,
    process_tree_lines,
    sample_cpu_percents,
    utc_now_iso,
    write_json,
)


def _linux_loadavg() -> list[float] | None:
    try:
        return list(platform.getloadavg())  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        return None


def _meminfo_linux() -> dict | None:
    path = Path("/proc/meminfo")
    if not path.is_file():
        return None
    out: dict[str, int] = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if ":" not in line:
            continue
        key, rest = line.split(":", 1)
        parts = rest.split()
        if not parts:
            continue
        try:
            kib = int(parts[0])
        except ValueError:
            continue
        out[key] = kib * 1024
    keys = ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree")
    return {k: out[k] for k in keys if k in out} or None


def build_snapshot(cpu_interval: float) -> dict:
    procs = list_study_processes()
    cpu = sample_cpu_percents([p.pid for p in procs], interval_sec=cpu_interval)
    for p in procs:
        if p.pid in cpu:
            p.cpu_percent = cpu[p.pid]

    diag = diagnostics_dir()
    snap = {
        "kind": "study-live-snapshot",
        "timestamp": utc_now_iso(),
        "system": platform.system(),
        "platform": platform.platform(),
        "repoRoot": str(ROOT),
        "diagnosticsDir": str(diag),
        "diagnosticsDirExists": diag.is_dir(),
        "loadavg": _linux_loadavg(),
        "meminfo": _meminfo_linux(),
        "processCount": {
            "ui": sum(1 for p in procs if p.role == "ui"),
            "sidecar": sum(1 for p in procs if p.role == "sidecar"),
            "total": len(procs),
        },
        "processes": [p.to_dict() for p in procs],
        "tree": process_tree_lines(procs),
        "hints": _hints(procs, diag),
    }
    return snap


def _hints(procs, diag: Path) -> list[str]:
    hints: list[str] = []
    ui = [p for p in procs if p.role == "ui"]
    side = [p for p in procs if p.role == "sidecar"]
    if ui and not side:
        hints.append(
            "UI running without solver-engine — likely crash/kill of sidecar; "
            "check last-fault.json + engine.log (analyze_diagnostics.py)."
        )
    if side and not ui:
        hints.append(
            "Orphan solver-engine without Study UI — leftover after UI exit; "
            "safe to inspect stacks then kill if confirmed stale."
        )
    if not ui and not side:
        hints.append(
            "No Study/solver-engine processes found. Capture after repro, or "
            "analyze offline diagnostics / crash dumps instead."
        )
    if len(side) > 1:
        hints.append(
            f"Multiple solver-engine processes ({len(side)}) — unexpected; "
            "note PIDs before killing; may indicate failed ensure/reconnect."
        )
    for p in side:
        if p.state and p.state.lower() in ("stopped", "t", "ttin", "ttou"):
            hints.append(
                f"sidecar pid={p.pid} state={p.state} — job-control stop, not a "
                "CFR hang; check terminal/SIGSTOP."
            )
        if p.cpu_percent is not None and p.cpu_percent < 1.0 and ui:
            hints.append(
                f"sidecar pid={p.pid} near-idle CPU ({p.cpu_percent:.1f}%) while UI "
                "alive — possible IPC deadlock / wait on lock (sample stacks)."
            )
        if p.cpu_percent is not None and p.cpu_percent > 80:
            hints.append(
                f"sidecar pid={p.pid} hot CPU ({p.cpu_percent:.1f}%) — likely "
                "active train/compile, not a freeze; use train_freeze_probe / "
                "status progress to confirm."
            )
    if diag.is_dir() and (diag / "ui-hang-events.json").is_file():
        hints.append(
            "ui-hang-events.json present — soft timeouts/stalls may explain "
            "UI freezes without a hard crash."
        )
    return hints


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--out",
        type=Path,
        help="Write JSON snapshot to this path (also prints a short summary)",
    )
    ap.add_argument(
        "--cpu-interval",
        type=float,
        default=0.5,
        help="Seconds to sample CPU%% (requires psutil; default 0.5)",
    )
    ap.add_argument(
        "--json-only",
        action="store_true",
        help="Print only JSON to stdout",
    )
    args = ap.parse_args()

    snap = build_snapshot(args.cpu_interval)
    if args.out:
        write_json(args.out, snap)

    if args.json_only:
        json.dump(snap, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    print(f"timestamp: {snap['timestamp']}")
    print(f"diagnostics: {snap['diagnosticsDir']} (exists={snap['diagnosticsDirExists']})")
    counts = snap["processCount"]
    print(
        f"processes: ui={counts['ui']} sidecar={counts['sidecar']} "
        f"(matched={counts['total']})"
    )
    for line in snap["tree"]:
        print(line)
    if snap["hints"]:
        print("hints:")
        for h in snap["hints"]:
            print(f"  - {h}")
    if args.out:
        print(f"wrote: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

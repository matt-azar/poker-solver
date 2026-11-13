#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Smoke-test the debug suite without a running Study UI.

Validates imports, diagnostics analysis on a synthetic folder, dump search,
snapshot (may find zero procs), and windows checklist. Optionally runs
ipc_probe / train_freeze_probe when solver-engine is built.

Examples:
  python3 scripts/debug/smoke_selftest.py
  python3 scripts/debug/smoke_selftest.py --with-engine
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import default_solver_engine, eprint, write_json  # noqa: E402


def _synthetic_diag(dir_path: Path) -> None:
    dir_path.mkdir(parents=True, exist_ok=True)
    write_json(
        dir_path / "last-fault.json",
        {
            "reason": "solver-engine IPC read timed out",
            "exitReason": "session-dead",
            "lastOp": "status",
            "consecutiveStatusFailures": 3,
        },
    )
    write_json(
        dir_path / "ui-hang-events.json",
        [
            {"kind": "status-poll-timeout", "durationMs": 4000, "phase": "solving"},
            {"kind": "status-poll-hung", "durationMs": 12000, "phase": "solving"},
        ],
    )
    write_json(
        dir_path / "host-resources.json",
        {"snapshotKind": "fault", "sidecarPid": 1},
    )
    write_json(
        dir_path / "last-solve.json",
        {"snapshotKind": "pre-solve", "street": "river", "iterations": 100},
    )
    (dir_path / "engine.log").write_text("info: ready\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--with-engine",
        action="store_true",
        help="Also run ipc_probe + train_freeze_probe if binary exists",
    )
    args = ap.parse_args()
    failures: list[str] = []

    # Imports / basic calls
    from analyze_diagnostics import analyze_dir
    from capture_snapshot import build_snapshot
    from find_crash_dumps import _iter_candidates
    from _common import crash_dumps_dirs
    from windows_sidecar_check import CHECKLIST

    snap = build_snapshot(0.1)
    if snap.get("kind") != "study-live-snapshot":
        failures.append("capture_snapshot kind")

    with tempfile.TemporaryDirectory(prefix="study-debug-smoke-") as tmp:
        diag = Path(tmp) / "diagnostics"
        _synthetic_diag(diag)
        report = analyze_dir(diag)
        primary = report["classification"]["primary"]
        if primary not in {"hang", "crash", "timeout_or_soft_hang", "session_fault"}:
            # With session-dead + hung threshold we expect hang or crash-ish.
            if "hung_sidecar_threshold" not in report["classification"]["tags"]:
                failures.append(f"analyze_diagnostics unexpected primary={primary}")

        dumps = _iter_candidates(crash_dumps_dirs(), since=0)
        if not isinstance(dumps, list):
            failures.append("find_crash_dumps")

    if len(CHECKLIST) < 3:
        failures.append("windows checklist too short")

    # Front-door CLI routes to the same scripts (no rewrite).
    front = _HERE / "study_debug.py"
    if not front.is_file():
        failures.append("missing study_debug.py front door")
    else:
        help_rc = subprocess.call(
            [sys.executable, str(front), "--help"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if help_rc != 0:
            failures.append("study_debug --help")
        with tempfile.TemporaryDirectory(prefix="study-debug-cli-") as tmp2:
            diag2 = Path(tmp2) / "diagnostics"
            _synthetic_diag(diag2)
            out_json = Path(tmp2) / "analysis.json"
            cli_rc = subprocess.call(
                [
                    sys.executable,
                    str(front),
                    "analyze",
                    "--dir",
                    str(diag2),
                    "--out",
                    str(out_json),
                    "--json-only",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if cli_rc != 0 or not out_json.is_file():
                failures.append("study_debug analyze subcommand")
        # Mini-app file must exist; skip import if tkinter missing (headless CI).
        if not (_HERE / "study_debug_app.py").is_file():
            failures.append("missing study_debug_app.py")
        else:
            try:
                import tkinter  # noqa: F401
            except ImportError:
                eprint("note: tkinter unavailable — skipping study_debug_app import")
            else:
                try:
                    import study_debug_app  # noqa: F401
                except Exception as exc:  # noqa: BLE001
                    failures.append(f"study_debug_app import: {exc}")

    if args.with_engine:
        binary = default_solver_engine()
        if not binary.is_file():
            eprint(f"--with-engine requested but missing {binary}")
            failures.append("missing solver-engine")
        else:
            from ipc_probe import run_probe as run_ipc
            from train_freeze_probe import DEFAULT_CONFIG, run_probe as run_train

            ipc = run_ipc(binary, 8.0)
            if not ipc.get("ok"):
                failures.append(f"ipc_probe failed: {ipc.get('error') or ipc.get('checks')}")
            if DEFAULT_CONFIG.is_file():
                train = run_train(binary, DEFAULT_CONFIG, 20, 8.0, 3, 0.25)
                if not train.get("ok"):
                    failures.append(
                        f"train_freeze_probe failed: {train.get('error') or train.get('checks')}"
                    )

    if failures:
        print("FAIL")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("ok smoke_selftest")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

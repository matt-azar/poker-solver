#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Summarize Holdem Study diagnostics folder (crash vs hang triage).

Reads the same files the packaged app writes (ZR-160 / ZR-173):
  last-fault.json, ui-hang-events.json, last-solve.json, host-resources.json,
  session-meta.json, engine.log

Default path: HOLDEM_STUDY_DIAGNOSTICS_DIR or platform app-data diagnostics dir.
Also accepts a zip from Help → Copy diagnostics zip.

Examples:
  python3 scripts/debug/analyze_diagnostics.py
  python3 scripts/debug/analyze_diagnostics.py --dir ~/diag-copy
  python3 scripts/debug/analyze_diagnostics.py --zip ~/Desktop/holdem-study-diagnostics.zip
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import (  # noqa: E402
    DIAG_FILES,
    STATUS_POLL_DEAD_AFTER_FAILURES,
    diagnostics_dir,
    load_json_file,
    utc_now_iso,
    write_json,
)


HARD_EXIT_REASONS = {
    "session-dead",
    "kill",
    "pipe closed",
    "reconnect-ensure-fail",
    "solve-rpc-failed",
}
HANG_KINDS = {
    "status-poll-timeout",
    "status-poll-slow",
    "status-poll-hung",
    "main-thread-stall",
}


def _read_optional_json(path: Path) -> Any | None:
    if not path.is_file():
        return None
    try:
        return load_json_file(path)
    except (OSError, json.JSONDecodeError) as exc:
        return {"_error": str(exc)}


def _engine_log_tail(path: Path, max_lines: int = 40) -> list[str]:
    if not path.is_file():
        return []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    lines = [ln for ln in text.splitlines() if ln.strip()]
    return lines[-max_lines:]


def _classify(
    fault: Any | None,
    hangs: Any | None,
    host: Any | None,
    engine_tail: list[str],
) -> dict[str, Any]:
    """Heuristic crash vs hang vs train-busy classification."""
    verdicts: list[str] = []
    evidence: list[str] = []

    hang_events: list[dict] = []
    if isinstance(hangs, list):
        hang_events = [e for e in hangs if isinstance(e, dict)]
    elif isinstance(hangs, dict) and isinstance(hangs.get("events"), list):
        hang_events = [e for e in hangs["events"] if isinstance(e, dict)]

    hang_kinds = {str(e.get("kind", "")) for e in hang_events}
    hard_hangs = hang_kinds & {"status-poll-hung", "main-thread-stall"}
    soft_hangs = hang_kinds & {"status-poll-timeout", "status-poll-slow"}

    if isinstance(fault, dict) and not fault.get("_error"):
        reason = str(fault.get("reason") or fault.get("exitReason") or "")
        exit_reason = str(fault.get("exitReason") or "")
        evidence.append(
            f"last-fault exitReason={exit_reason!r} reason={reason[:120]!r}"
        )
        lower = f"{exit_reason} {reason}".lower()
        if any(x in lower for x in ("pipe closed", "session killed", "exited", "crash")):
            verdicts.append("crash_or_kill")
        elif "timeout" in lower or "timed out" in lower:
            verdicts.append("ipc_timeout")
        elif exit_reason in HARD_EXIT_REASONS or any(
            x in lower for x in HARD_EXIT_REASONS
        ):
            verdicts.append("session_fault")
        else:
            verdicts.append("fault_present")

        fails = fault.get("consecutiveStatusFailures")
        if isinstance(fails, int) and fails >= STATUS_POLL_DEAD_AFTER_FAILURES:
            evidence.append(
                f"consecutiveStatusFailures={fails} "
                f"(≥{STATUS_POLL_DEAD_AFTER_FAILURES} → hung-sidecar terminate path)"
            )
            verdicts.append("hung_sidecar_threshold")

    if hard_hangs:
        verdicts.append("ui_hang_hard")
        evidence.append(f"hard hang kinds: {sorted(hard_hangs)}")
    if soft_hangs and not hard_hangs:
        verdicts.append("ui_hang_soft")
        evidence.append(
            f"soft hang kinds only: {sorted(soft_hangs)} "
            "(may be GC/sleep; prefer clusters)"
        )
    if len(hang_events) >= 3:
        evidence.append(f"hang-event cluster size={len(hang_events)}")

    if isinstance(host, dict) and not host.get("_error"):
        kind = host.get("snapshotKind")
        evidence.append(f"host-resources snapshotKind={kind}")
        if kind == "pre-solve" and not (
            isinstance(fault, dict) and not fault.get("_error")
        ):
            verdicts.append("died_before_fault_write")
            evidence.append(
                "Only pre-solve host snapshot — process may have died before "
                "last-fault could write (hard crash candidate)."
            )

    panic_like = [
        ln
        for ln in engine_tail
        if any(
            tok in ln.lower()
            for tok in ("panic", "segfault", "sigsegv", "fatal", "assert", "abort")
        )
    ]
    if panic_like:
        verdicts.append("engine_stderr_fatal")
        evidence.append(f"engine.log fatal-ish lines: {len(panic_like)}")

    # Deduplicate while preserving order.
    seen: set[str] = set()
    ordered = []
    for v in verdicts:
        if v not in seen:
            seen.add(v)
            ordered.append(v)

    primary = "unknown"
    if "crash_or_kill" in ordered or "engine_stderr_fatal" in ordered:
        primary = "crash"
    elif "died_before_fault_write" in ordered and not hang_events:
        primary = "crash_suspect"
    elif "hung_sidecar_threshold" in ordered or "ui_hang_hard" in ordered:
        primary = "hang"
    elif "ipc_timeout" in ordered or "ui_hang_soft" in ordered:
        primary = "timeout_or_soft_hang"
    elif ordered:
        primary = ordered[0]

    return {
        "primary": primary,
        "tags": ordered,
        "evidence": evidence,
        "hangEventCount": len(hang_events),
        "interpretation": _interpret(primary),
    }


def _interpret(primary: str) -> str:
    return {
        "crash": (
            "Hard process death or kill. Look for minidumps/cores "
            "(find_crash_dumps.py), engine.log panic lines, and last-fault "
            "exitReason. Unsaved train progress is gone without a Save."
        ),
        "crash_suspect": (
            "Pre-solve snapshot exists without a later fault write — classic "
            "hard-crash window. Check CrashDumps / coredumps next."
        ),
        "hang": (
            "UI or status path reported hung/unresponsive. Sample stacks "
            "(stack_sample.py) while frozen; do not assume train should be "
            "killed for a single soft RPC timeout."
        ),
        "timeout_or_soft_hang": (
            "Soft IPC/status timeouts. Correlate with ui-hang-events kinds and "
            "whether the sidecar CPU is hot (active train) vs idle (deadlock)."
        ),
        "unknown": (
            "Insufficient evidence in the folder. Repro with Study open, then "
            "capture_snapshot.py + collect_bundle.py during the failure."
        ),
    }.get(primary, "See tags/evidence.")


def analyze_dir(dir_path: Path) -> dict[str, Any]:
    fault = _read_optional_json(dir_path / "last-fault.json")
    hangs = _read_optional_json(dir_path / "ui-hang-events.json")
    last_solve = _read_optional_json(dir_path / "last-solve.json")
    host = _read_optional_json(dir_path / "host-resources.json")
    meta = _read_optional_json(dir_path / "session-meta.json")
    engine_tail = _engine_log_tail(dir_path / "engine.log")

    present = [name for name in DIAG_FILES if (dir_path / name).is_file()]
    classification = _classify(fault, hangs, host, engine_tail)

    return {
        "kind": "diagnostics-analysis",
        "timestamp": utc_now_iso(),
        "diagnosticsDir": str(dir_path),
        "presentFiles": present,
        "classification": classification,
        "lastFault": fault,
        "uiHangEvents": hangs,
        "lastSolve": last_solve,
        "hostResources": host,
        "sessionMeta": meta,
        "engineLogTail": engine_tail,
    }


def _extract_zip(zip_path: Path) -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="study-diag-"))
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(tmp)
    # Zip may contain a single top-level folder.
    children = [p for p in tmp.iterdir() if not p.name.startswith(".")]
    if len(children) == 1 and children[0].is_dir():
        return children[0]
    return tmp


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dir", type=Path, help="Diagnostics directory")
    ap.add_argument("--zip", type=Path, help="Diagnostics zip from the app")
    ap.add_argument("--out", type=Path, help="Write full JSON analysis")
    ap.add_argument("--json-only", action="store_true")
    args = ap.parse_args()

    if args.zip:
        if not args.zip.is_file():
            print(f"missing zip: {args.zip}", file=sys.stderr)
            return 1
        target = _extract_zip(args.zip)
    else:
        target = diagnostics_dir(args.dir)

    if not target.is_dir():
        print(f"diagnostics dir missing: {target}", file=sys.stderr)
        print(
            "Set HOLDEM_STUDY_DIAGNOSTICS_DIR or pass --dir / --zip.",
            file=sys.stderr,
        )
        return 1

    report = analyze_dir(target)
    if args.out:
        write_json(args.out, report)

    if args.json_only:
        json.dump(report, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    c = report["classification"]
    print(f"diagnostics: {report['diagnosticsDir']}")
    print(f"files: {', '.join(report['presentFiles']) or '(none)'}")
    print(f"primary: {c['primary']}")
    if c["tags"]:
        print(f"tags: {', '.join(c['tags'])}")
    print(f"interpretation: {c['interpretation']}")
    if c["evidence"]:
        print("evidence:")
        for e in c["evidence"]:
            print(f"  - {e}")
    if report["engineLogTail"]:
        print("engine.log tail:")
        for ln in report["engineLogTail"][-15:]:
            print(f"  | {ln}")
    if args.out:
        print(f"wrote: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

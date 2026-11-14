#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Watch Study / solver-engine for hang-like process signals.

Samples RSS + CPU over time. Emits alerts when:
  - sidecar CPU stays near-zero while UI is alive (possible IPC deadlock)
  - sidecar CPU pegged with no RSS change for a long window (possible livelock;
    still may be legitimate train — correlate with status iterations)
  - process disappears (crash/kill)

Does not attach a debugger or kill processes. Pair with stack_sample.py when
an alert fires.

Examples:
  python3 scripts/debug/watch_hang.py
  python3 scripts/debug/watch_hang.py --interval 2 --duration 120
  python3 scripts/debug/watch_hang.py --pid 12345
  python3 scripts/debug/watch_hang.py --always --out-dir "%LOCALAPPDATA%\\Holdem Study\\debug-reports"
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import (  # noqa: E402
    list_study_processes,
    sample_cpu_percents,
    utc_now_iso,
    write_json,
)


def _default_always_dir() -> Path:
    env = os.environ.get("HOLDEM_STUDY_REPORT_SAVE_DIR", "").strip()
    if env:
        return Path(env).expanduser() / "hang-watch"
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA") or ""
        if local:
            return Path(local) / "Holdem Study" / "debug-reports" / "hang-watch"
    return Path.home() / ".holdem-study" / "debug-reports" / "hang-watch"


def _append_jsonl(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, sort_keys=True) + "\n")


def _track_targets(explicit_pid: int | None):
    if explicit_pid is not None:
        procs = list_study_processes()
        match = [p for p in procs if p.pid == explicit_pid]
        if match:
            return match
        # Still watch unknown PID via synthetic entry.
        from _common import ProcInfo

        return [
            ProcInfo(
                pid=explicit_pid,
                ppid=None,
                name=f"pid:{explicit_pid}",
                cmdline="",
                role="other",
            )
        ]
    return list_study_processes()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--interval", type=float, default=2.0, help="Sample period seconds")
    ap.add_argument(
        "--duration",
        type=float,
        default=60.0,
        help="Total watch seconds (0 = until Ctrl-C)",
    )
    ap.add_argument(
        "--always",
        action="store_true",
        help="Always-on mode: duration=0 + append JSONL under --out-dir",
    )
    ap.add_argument("--pid", type=int, help="Watch a single PID")
    ap.add_argument(
        "--idle-cpu",
        type=float,
        default=2.0,
        help="CPU%% below this counts as idle (default 2)",
    )
    ap.add_argument(
        "--idle-streak",
        type=int,
        default=5,
        help="Consecutive idle samples before idle-hang alert",
    )
    ap.add_argument("--out", type=Path, help="Write final JSON summary")
    ap.add_argument(
        "--out-dir",
        type=Path,
        help="Directory for always-on JSONL (hang-watch-events.jsonl)",
    )
    ap.add_argument(
        "--quiet",
        action="store_true",
        help="Only print ALERT/NOTE lines (for background launcher)",
    )
    args = ap.parse_args()

    if args.always:
        args.duration = 0.0
        out_dir = (args.out_dir or _default_always_dir()).expanduser()
        out_dir.mkdir(parents=True, exist_ok=True)
        jsonl_path = out_dir / "hang-watch-events.jsonl"
    else:
        jsonl_path = None
        if args.out_dir:
            out_dir = args.out_dir.expanduser()
            out_dir.mkdir(parents=True, exist_ok=True)
            jsonl_path = out_dir / "hang-watch-events.jsonl"

    events: list[dict] = []
    idle_streaks: dict[int, int] = {}
    last_rss: dict[int, int | None] = {}
    seen_pids: set[int] = set()
    start = time.monotonic()

    def emit(ev: dict, *, alert: bool = False, note: bool = False) -> None:
        events.append(ev)
        if jsonl_path is not None:
            _append_jsonl(jsonl_path, ev)
        kind = ev.get("kind", "")
        if alert:
            print(f"ALERT {kind} pid={ev.get('pid')}")
        elif note:
            print(f"NOTE {kind} pid={ev.get('pid')}")

    if not args.quiet:
        print(
            f"watching interval={args.interval}s duration="
            f"{'∞' if args.duration <= 0 else args.duration}s"
            + (f" jsonl={jsonl_path}" if jsonl_path else "")
        )
    elif jsonl_path:
        print(f"hang-watch always-on → {jsonl_path}", flush=True)

    try:
        while True:
            if args.duration > 0 and (time.monotonic() - start) >= args.duration:
                break
            procs = _track_targets(args.pid)
            pids = [p.pid for p in procs]
            cpu = sample_cpu_percents(pids, interval_sec=min(0.4, args.interval / 2))
            now = utc_now_iso()
            live = {p.pid for p in procs}

            for vanished in sorted(seen_pids - live):
                ev = {
                    "timestamp": now,
                    "kind": "process_exited",
                    "pid": vanished,
                    "note": "process gone — crash/kill/exit",
                }
                emit(ev, alert=True)
                idle_streaks.pop(vanished, None)
                last_rss.pop(vanished, None)
            seen_pids |= live

            if not procs:
                if not args.quiet:
                    print(f"{now} no matching processes")
            for p in procs:
                p.cpu_percent = cpu.get(p.pid)
                rss = p.rss_bytes
                prev = last_rss.get(p.pid)
                last_rss[p.pid] = rss
                if not args.quiet:
                    line = (
                        f"{now} [{p.role}] pid={p.pid} cpu={p.cpu_percent!s}% "
                        f"rss={rss} state={p.state}"
                    )
                    print(line)

                if (
                    p.role == "sidecar"
                    and p.cpu_percent is not None
                    and p.cpu_percent < args.idle_cpu
                ):
                    idle_streaks[p.pid] = idle_streaks.get(p.pid, 0) + 1
                    if idle_streaks[p.pid] == args.idle_streak:
                        ev = {
                            "timestamp": now,
                            "kind": "sidecar_idle_streak",
                            "pid": p.pid,
                            "streak": idle_streaks[p.pid],
                            "cpuPercent": p.cpu_percent,
                            "note": (
                                "sidecar idle while watched — possible IPC "
                                "deadlock; run stack_sample.py"
                            ),
                        }
                        emit(ev, alert=True)
                else:
                    idle_streaks[p.pid] = 0

                if (
                    p.role == "sidecar"
                    and p.cpu_percent is not None
                    and p.cpu_percent > 90
                    and prev is not None
                    and rss is not None
                    and prev == rss
                ):
                    ev = {
                        "timestamp": now,
                        "kind": "sidecar_hot_flat_rss",
                        "pid": p.pid,
                        "cpuPercent": p.cpu_percent,
                        "rssBytes": rss,
                        "note": (
                            "high CPU with unchanged RSS — may be train or "
                            "livelock; check status iterations"
                        ),
                    }
                    emit(ev, note=True)

            time.sleep(max(0.0, args.interval - min(0.4, args.interval / 2)))
    except KeyboardInterrupt:
        if not args.quiet:
            print("stopped.")

    summary = {
        "kind": "hang-watch",
        "timestamp": utc_now_iso(),
        "eventCount": len(events),
        "events": events,
        "jsonl": str(jsonl_path) if jsonl_path else None,
    }
    if args.out:
        write_json(args.out, summary)
        print(f"wrote: {args.out}")
    elif events and not args.always and not args.quiet:
        json.dump(summary, sys.stdout, indent=2)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

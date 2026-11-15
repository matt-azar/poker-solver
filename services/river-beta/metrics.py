# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Per-session CPU time and peak RSS for the river beta sidecar.

Document these before any turn/flop expansion. Linux uses /proc; other
platforms fall back to resource.getrusage when available.
"""

from __future__ import annotations

import os
import resource
import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class SessionMetrics:
    created_at: float = field(default_factory=time.time)
    cpu_user_sec: float = 0.0
    cpu_system_sec: float = 0.0
    peak_rss_bytes: int = 0
    last_rss_bytes: int = 0
    solve_wall_sec: float = 0.0
    solve_count: int = 0
    last_error: str | None = None
    samples: int = 0

    def sample_pid(self, pid: int | None) -> None:
        if pid is None:
            return
        snap = read_process_usage(pid)
        if snap is None:
            return
        self.cpu_user_sec = snap["cpu_user_sec"]
        self.cpu_system_sec = snap["cpu_system_sec"]
        self.last_rss_bytes = snap["rss_bytes"]
        if snap["rss_bytes"] > self.peak_rss_bytes:
            self.peak_rss_bytes = snap["rss_bytes"]
        self.samples += 1

    def note_solve_wall(self, seconds: float) -> None:
        self.solve_wall_sec += max(0.0, seconds)
        self.solve_count += 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "created_at": self.created_at,
            "cpu_user_sec": round(self.cpu_user_sec, 4),
            "cpu_system_sec": round(self.cpu_system_sec, 4),
            "cpu_total_sec": round(self.cpu_user_sec + self.cpu_system_sec, 4),
            "peak_rss_bytes": self.peak_rss_bytes,
            "last_rss_bytes": self.last_rss_bytes,
            "solve_wall_sec": round(self.solve_wall_sec, 4),
            "solve_count": self.solve_count,
            "samples": self.samples,
            "last_error": self.last_error,
        }


def read_process_usage(pid: int) -> dict[str, Any] | None:
    """Return cpu_user_sec, cpu_system_sec, rss_bytes for pid, or None."""
    if os.name == "posix" and Path_proc_exists(pid):
        try:
            return _read_proc_linux(pid)
        except OSError:
            pass
    # Fallback: calling-process rusage is wrong for the child; still try
    # wait4-style only when pid matches self (tests).
    if pid == os.getpid():
        usage = resource.getrusage(resource.RUSAGE_SELF)
        return {
            "cpu_user_sec": float(usage.ru_utime),
            "cpu_system_sec": float(usage.ru_stime),
            "rss_bytes": int(usage.ru_maxrss) * (1024 if os.uname().sysname != "Darwin" else 1),
        }
    return None


def Path_proc_exists(pid: int) -> bool:
    return os.path.exists(f"/proc/{pid}/stat")


def _read_proc_linux(pid: int) -> dict[str, Any]:
    # /proc/<pid>/stat: utime/stime are fields 14/15 (1-indexed), in ticks.
    with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as fh:
        stat = fh.read()
    # Comm may contain spaces/parens — split after last ')'.
    rparen = stat.rfind(")")
    fields = stat[rparen + 2 :].split()
    # After comm: state is fields[0]; utime is fields[11], stime fields[12].
    utime_ticks = int(fields[11])
    stime_ticks = int(fields[12])
    ticks = os.sysconf("SC_CLK_TCK") or 100
    with open(f"/proc/{pid}/status", "r", encoding="utf-8") as fh:
        status = fh.read()
    rss_bytes = 0
    for line in status.splitlines():
        if line.startswith("VmRSS:"):
            # kB
            parts = line.split()
            rss_bytes = int(parts[1]) * 1024
            break
    return {
        "cpu_user_sec": utime_ticks / float(ticks),
        "cpu_system_sec": stime_ticks / float(ticks),
        "rss_bytes": rss_bytes,
    }

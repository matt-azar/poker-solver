# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Shared helpers for Study / solver-engine crash & hang debug scripts."""

from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

ROOT = Path(__file__).resolve().parents[2]

# Process name fragments used to find Study UI + Zig sidecar.
UI_NAME_HINTS = (
    "holdem study",
    "holdem-study",
    "poker-solver-study",
    "poker_solver_study",
)
SIDECAR_NAME_HINTS = ("solver-engine",)

# App-written diagnostics (ZR-160 / ZR-173). Override: HOLDEM_STUDY_DIAGNOSTICS_DIR.
PRODUCT_DIR = "Holdem Study"
DIAGNOSTICS_SUBDIR = "diagnostics"
DIAG_FILES = (
    "engine.log",
    "last-fault.json",
    "last-solve.json",
    "host-resources.json",
    "ui-hang-events.json",
    "session-meta.json",
    "README.txt",
)

# Mirror desktop/src-tauri/src/solver_engine.rs timeout_for_op (seconds).
IPC_TIMEOUTS_SEC = {
    "ready": 8,
    "status": 8,
    "begin_config": 600,
    "solve": 2 * 60 * 60,
    "resolve_locked": 2 * 60 * 60,
    "default": 240,
}

# Mirror desktop JS status-poll budget (requestScope.ts).
STATUS_POLL_TIMEOUT_MS = 4_000
STATUS_RPC_TIMEOUT_S = 8.0
STATUS_POLL_DEAD_AFTER_FAILURES = 3


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def eprint(*args: Any, **kwargs: Any) -> None:
    print(*args, file=sys.stderr, **kwargs)


def default_solver_engine() -> Path:
    candidates = [
        ROOT / "zig-out" / "bin" / "solver-engine",
        ROOT / "zig-out" / "bin" / "solver-engine.exe",
    ]
    # Windows installed Study: allow HOLDEM_STUDY_SOLVER_ENGINE or sibling of UI.
    env_bin = os.environ.get("HOLDEM_STUDY_SOLVER_ENGINE")
    if env_bin:
        candidates.insert(0, Path(env_bin).expanduser())
    for path in candidates:
        if path.is_file():
            return path
    return candidates[0]


def diagnostics_dir(explicit: Optional[Path] = None) -> Path:
    if explicit is not None:
        return explicit.expanduser().resolve()
    env = os.environ.get("HOLDEM_STUDY_DIAGNOSTICS_DIR")
    if env:
        return Path(env).expanduser().resolve()
    system = platform.system()
    if system == "Windows":
        local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(local) / PRODUCT_DIR / DIAGNOSTICS_SUBDIR
    if system == "Darwin":
        return (
            Path.home()
            / "Library"
            / "Application Support"
            / PRODUCT_DIR
            / DIAGNOSTICS_SUBDIR
        )
    # Linux / other: XDG + fallback used by Tauri local data.
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg) / PRODUCT_DIR / DIAGNOSTICS_SUBDIR
    return Path.home() / ".local" / "share" / PRODUCT_DIR / DIAGNOSTICS_SUBDIR


def crash_dumps_dirs() -> list[Path]:
    system = platform.system()
    out: list[Path] = []
    if system == "Windows":
        local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        out.append(Path(local) / "CrashDumps")
    else:
        out.extend(
            [
                Path("/var/crash"),
                Path("/var/lib/systemd/coredump"),
                Path.cwd(),
                ROOT,
            ]
        )
    return out


@dataclass
class ProcInfo:
    pid: int
    ppid: Optional[int]
    name: str
    cmdline: str
    rss_bytes: Optional[int] = None
    cpu_percent: Optional[float] = None
    threads: Optional[int] = None
    state: Optional[str] = None
    create_time: Optional[float] = None
    role: str = "other"  # ui | sidecar | other

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _role_for(name: str, cmdline: str) -> str:
    blob = f"{name} {cmdline}".lower()
    if any(h in blob for h in SIDECAR_NAME_HINTS):
        return "sidecar"
    if any(h in blob for h in UI_NAME_HINTS):
        return "ui"
    return "other"


def _psutil_available() -> bool:
    try:
        import psutil  # noqa: F401

        return True
    except ImportError:
        return False


def list_study_processes() -> list[ProcInfo]:
    """Find Study UI + solver-engine processes (best-effort, no hard deps)."""
    if _psutil_available():
        return _list_with_psutil()
    return _list_with_ps_fallback()


def _list_with_psutil() -> list[ProcInfo]:
    import psutil

    found: list[ProcInfo] = []
    for proc in psutil.process_iter(
        ["pid", "ppid", "name", "cmdline", "memory_info", "num_threads", "create_time", "status"]
    ):
        try:
            info = proc.info
            name = info.get("name") or ""
            cmd_list = info.get("cmdline") or []
            cmdline = " ".join(cmd_list)
            role = _role_for(name, cmdline)
            if role == "other":
                continue
            mem = info.get("memory_info")
            found.append(
                ProcInfo(
                    pid=int(info["pid"]),
                    ppid=info.get("ppid"),
                    name=name,
                    cmdline=cmdline[:500],
                    rss_bytes=getattr(mem, "rss", None) if mem else None,
                    threads=info.get("num_threads"),
                    state=info.get("status"),
                    create_time=info.get("create_time"),
                    role=role,
                )
            )
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
    return sorted(found, key=lambda p: (p.role, p.pid))


def _list_with_ps_fallback() -> list[ProcInfo]:
    """POSIX `ps` fallback when psutil is not installed."""
    if platform.system() == "Windows":
        return _list_with_tasklist()
    try:
        out = subprocess.check_output(
            ["ps", "axo", "pid=,ppid=,rss=,nlwp=,state=,comm=,args="],
            text=True,
            errors="replace",
        )
    except (OSError, subprocess.CalledProcessError):
        return []
    found: list[ProcInfo] = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 6)
        if len(parts) < 7:
            continue
        pid_s, ppid_s, rss_s, nlwp_s, state, comm, args = parts
        role = _role_for(comm, args)
        if role == "other":
            continue
        try:
            rss_kib = int(rss_s)
        except ValueError:
            rss_kib = 0
        found.append(
            ProcInfo(
                pid=int(pid_s),
                ppid=int(ppid_s),
                name=comm,
                cmdline=args[:500],
                rss_bytes=rss_kib * 1024,
                threads=int(nlwp_s) if nlwp_s.isdigit() else None,
                state=state,
                role=role,
            )
        )
    return sorted(found, key=lambda p: (p.role, p.pid))


def _list_with_tasklist() -> list[ProcInfo]:
    try:
        out = subprocess.check_output(
            ["tasklist", "/FO", "CSV", "/NH"],
            text=True,
            errors="replace",
        )
    except (OSError, subprocess.CalledProcessError):
        return []
    found: list[ProcInfo] = []
    for line in out.splitlines():
        # "name","pid","session","session#","mem"
        cols = [c.strip().strip('"') for c in line.split(",")]
        if len(cols) < 2:
            continue
        name, pid_s = cols[0], cols[1]
        role = _role_for(name, name)
        if role == "other":
            continue
        try:
            pid = int(pid_s)
        except ValueError:
            continue
        found.append(ProcInfo(pid=pid, ppid=None, name=name, cmdline=name, role=role))
    return found


def process_tree_lines(procs: Iterable[ProcInfo]) -> list[str]:
    by_pid = {p.pid: p for p in procs}
    lines: list[str] = []
    for p in procs:
        parent = f" ppid={p.ppid}" if p.ppid is not None else ""
        rss = f" rss={_fmt_bytes(p.rss_bytes)}" if p.rss_bytes else ""
        thr = f" thr={p.threads}" if p.threads else ""
        st = f" state={p.state}" if p.state else ""
        orphan = ""
        if p.ppid is not None and p.ppid not in by_pid and p.role == "sidecar":
            # Sidecar orphaned from UI is a common post-crash / kill artifact.
            orphan = " [parent not in Study set]"
        lines.append(
            f"[{p.role}] pid={p.pid}{parent}{rss}{thr}{st} {p.name}{orphan}"
        )
        if p.cmdline and p.cmdline != p.name:
            lines.append(f"         cmd: {p.cmdline[:200]}")
    return lines


def _fmt_bytes(n: Optional[int]) -> str:
    if n is None:
        return "?"
    for unit, div in (("GiB", 1 << 30), ("MiB", 1 << 20), ("KiB", 1 << 10)):
        if n >= div:
            return f"{n / div:.1f}{unit}"
    return f"{n}B"


def sample_cpu_percents(pids: list[int], interval_sec: float = 0.5) -> dict[int, float]:
    """Best-effort CPU% over a short interval. Requires psutil for accuracy."""
    if not pids or not _psutil_available():
        return {}
    import psutil

    handles = []
    for pid in pids:
        try:
            handles.append(psutil.Process(pid))
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    for h in handles:
        try:
            h.cpu_percent(None)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    time.sleep(interval_sec)
    out: dict[int, float] = {}
    for h in handles:
        try:
            out[h.pid] = float(h.cpu_percent(None))
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return out


def load_json_file(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")


def which(cmd: str) -> Optional[str]:
    return shutil.which(cmd)


@dataclass
class BundleMeta:
    created_at: str = field(default_factory=utc_now_iso)
    host: str = field(default_factory=lambda: platform.node())
    system: str = field(default_factory=lambda: platform.system())
    platform: str = field(default_factory=platform.platform)
    python: str = field(default_factory=lambda: sys.version.split()[0])
    repo_root: str = field(default_factory=lambda: str(ROOT))

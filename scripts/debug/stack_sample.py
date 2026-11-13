#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Sample stack traces from Study / solver-engine without killing them.

Linux: prefers `eu-stack` / `gdb` / `pstack`.
macOS: `sample` or `lldb`.
Windows: prints guidance (ProcDump / Visual Studio / DebugDiag); optional
`cdb` if on PATH.

Examples:
  python3 scripts/debug/stack_sample.py
  python3 scripts/debug/stack_sample.py --pid 12345 --out /tmp/stacks.txt
"""

from __future__ import annotations

import argparse
import platform
import shutil
import subprocess
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import list_study_processes, utc_now_iso  # noqa: E402


def _run(cmd: list[str], timeout: float) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        return 127, f"command not found: {cmd[0]}\n"
    except subprocess.TimeoutExpired as exc:
        out = (exc.stdout or "") + (exc.stderr or "")
        return 124, out + f"\n(timeout after {timeout}s)\n"
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def sample_linux(pid: int, timeout: float) -> str:
    if shutil.which("eu-stack"):
        code, out = _run(["eu-stack", "-p", str(pid)], timeout)
        if code == 0 and out.strip():
            return f"## eu-stack -p {pid}\n{out}"
    if shutil.which("gdb"):
        code, out = _run(
            [
                "gdb",
                "-batch",
                "-ex",
                f"attach {pid}",
                "-ex",
                "thread apply all bt",
                "-ex",
                "detach",
                "-ex",
                "quit",
            ],
            timeout,
        )
        return f"## gdb bt pid={pid} exit={code}\n{out}"
    if shutil.which("pstack"):
        code, out = _run(["pstack", str(pid)], timeout)
        return f"## pstack {pid} exit={code}\n{out}"
    # /proc maps + wchan as last resort.
    wchan = Path(f"/proc/{pid}/wchan")
    stack = Path(f"/proc/{pid}/stack")
    bits = [f"## fallback /proc for pid={pid}"]
    if wchan.is_file():
        bits.append(f"wchan: {wchan.read_text(errors='replace').strip()}")
    if stack.is_file():
        try:
            bits.append(stack.read_text(errors="replace"))
        except OSError as exc:
            bits.append(f"(could not read stack: {exc})")
    bits.append(
        "Install elfutils (eu-stack) or gdb for full userspace backtraces."
    )
    return "\n".join(bits) + "\n"


def sample_macos(pid: int, timeout: float) -> str:
    if shutil.which("sample"):
        code, out = _run(["sample", str(pid), "1", "1"], timeout)
        return f"## sample {pid} exit={code}\n{out}"
    if shutil.which("lldb"):
        code, out = _run(
            [
                "lldb",
                "-p",
                str(pid),
                "-o",
                "bt all",
                "-o",
                "detach",
                "-o",
                "quit",
            ],
            timeout,
        )
        return f"## lldb bt pid={pid} exit={code}\n{out}"
    return "No sample/lldb on PATH.\n"


def sample_windows(pid: int, timeout: float) -> str:
    if shutil.which("cdb"):
        code, out = _run(
            ["cdb", "-p", str(pid), "-c", "~*k;q"],
            timeout,
        )
        return f"## cdb pid={pid} exit={code}\n{out}"
    return (
        f"## Windows stack guidance for pid={pid}\n"
        "No cdb on PATH. Options:\n"
        "  1) ProcDump -ma <pid> dump.dmp  then open in WinDbg/VS\n"
        "  2) Visual Studio → Debug → Attach to Process\n"
        "  3) Enable LocalDumps (see find_crash_dumps.py --help) for next crash\n"
        "Packaged Study uses GUI subsystem + CREATE_NO_WINDOW for solver-engine;\n"
        "there is no console to Ctrl-C — attach externally.\n"
    )


def sample_pid(pid: int, timeout: float) -> str:
    system = platform.system()
    if system == "Linux":
        return sample_linux(pid, timeout)
    if system == "Darwin":
        return sample_macos(pid, timeout)
    if system == "Windows":
        return sample_windows(pid, timeout)
    return f"unsupported OS {system}\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pid", type=int, action="append", help="PID(s) to sample")
    ap.add_argument("--timeout", type=float, default=15.0)
    ap.add_argument("--out", type=Path, help="Write combined stacks to file")
    args = ap.parse_args()

    if args.pid:
        pids = args.pid
        labels = {p: f"pid:{p}" for p in pids}
    else:
        procs = list_study_processes()
        if not procs:
            print("No Study/solver-engine processes found.", file=sys.stderr)
            return 1
        pids = [p.pid for p in procs]
        labels = {p.pid: f"{p.role}:{p.name}" for p in procs}

    chunks = [f"# stack sample {utc_now_iso()}\n"]
    for pid in pids:
        chunks.append(f"\n===== {labels.get(pid, pid)} (pid={pid}) =====\n")
        chunks.append(sample_pid(pid, args.timeout))

    text = "".join(chunks)
    if args.out:
        args.out.write_text(text, encoding="utf-8")
        print(f"wrote: {args.out}")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

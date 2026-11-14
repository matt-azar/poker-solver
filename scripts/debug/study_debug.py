#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Front door for the Study crash/hang debug suite.

Wraps the scripts in this folder with short subcommands and Windows-friendly
defaults. Does not replace the individual tools — it just routes to them.

  python scripts/debug/study_debug.py collect
  python scripts/debug/study_debug.py analyze --zip path\\to\\zip
  python scripts/debug/study_debug.py send --zip path\\to\\zip
  python scripts/debug/study_debug.py local-debug
  python scripts/debug/study_debug.py gui

Windows: double-click ``study-debug.cmd`` (mini-app) or
``study-debug-local.cmd`` (local receiver + mini-app, no Cloudflare).
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional, Sequence

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parents[1]

# Subcommand → script filename (relative to this directory).
_COMMANDS: dict[str, str] = {
    "collect": "collect_bundle.py",
    "analyze": "analyze_diagnostics.py",
    "dumps": "find_crash_dumps.py",
    "sidecar": "windows_sidecar_check.py",
    "probe": "ipc_probe.py",
    "freeze": "train_freeze_probe.py",
    "watch": "watch_hang.py",
    "snapshot": "capture_snapshot.py",
    "stacks": "stack_sample.py",
    "smoke": "smoke_selftest.py",
    "send": "send_report.py",
}

_ALIASES: dict[str, str] = {
    "bundle": "collect",
    "diag": "analyze",
    "diagnostics": "analyze",
    "dump": "dumps",
    "crash-dumps": "dumps",
    "ipc": "probe",
    "train": "freeze",
    "snap": "snapshot",
    "stack": "stacks",
    "app": "gui",
    "ui": "gui",
    "report": "send",
    "upload": "send",
    "gh-send": "send",
    "local": "local-debug",
    "local-receiver": "local-debug",
    "debug-local": "local-debug",
    "receiver": "local-debug",
    "enable-dumps": "enable-dumps",
    "localdumps": "enable-dumps",
    "dumps-enable": "enable-dumps",
    "diary": "diary",
    "repro-diary": "diary",
}


def _eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def _python() -> str:
    return sys.executable or "python3"


def _run_script(script_name: str, argv: Sequence[str]) -> int:
    script = _HERE / script_name
    if not script.is_file():
        _eprint(f"error: missing script {script}")
        return 2
    cmd = [_python(), str(script), *argv]
    return int(subprocess.call(cmd))


def _cmd_windows_collect(argv: Sequence[str]) -> int:
    """Delegate to windows_collect.ps1 when on Windows; else collect_bundle."""
    if sys.platform != "win32":
        _eprint("note: windows-collect is Windows-oriented; running collect --zip --stacks")
        return _run_script("collect_bundle.py", ["--zip", "--stacks", *argv])
    ps1 = _HERE / "windows_collect.ps1"
    cmd = [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(ps1),
        *argv,
    ]
    return int(subprocess.call(cmd))


def _cmd_gui(_argv: Sequence[str]) -> int:
    gui = _HERE / "study_debug_app.py"
    if not gui.is_file():
        _eprint(f"error: missing mini-app {gui}")
        return 2
    return int(subprocess.call([_python(), str(gui)]))


def _cmd_enable_dumps(argv: Sequence[str]) -> int:
    ps1 = _HERE / "enable_local_dumps.ps1"
    if not ps1.is_file():
        _eprint(f"error: missing {ps1}")
        return 2
    if sys.platform != "win32":
        _eprint("enable-dumps is Windows-only (LocalDumps registry).")
        _eprint(f"See script comments in {ps1}")
        return 2
    cmd = [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(ps1),
        *argv,
    ]
    return int(subprocess.call(cmd))


def _print_front_door() -> None:
    diag = os.environ.get("HOLDEM_STUDY_DIAGNOSTICS_DIR") or (
        r"%LOCALAPPDATA%\Holdem Study\diagnostics"
        if sys.platform == "win32"
        else "~/.local/share/Holdem Study/diagnostics"
    )
    print(
        """
Holdem Study crash/hang debug — front door
==========================================

Windows (from a clone of this repo):

  scripts\\debug\\study-debug.cmd              # opens mini-app
  scripts\\debug\\study-debug.cmd collect      # evidence zip while frozen
  scripts\\debug\\study-debug.cmd analyze --zip path\\to\\diagnostics.zip
  scripts\\debug\\study-debug-local.cmd   # local receiver + mini-app (no Cloudflare)
  scripts\\debug\\study-debug.cmd send --zip path\\to\\diagnostics.zip
  scripts\\debug\\study-debug.cmd dumps
  scripts\\debug\\study-debug.cmd sidecar --exe "C:\\Path\\To\\Install\\solver-engine.exe"

Or:
  python scripts\\debug\\study_debug.py <command> ...
  python scripts\\debug\\study_debug.py local-debug
  python scripts\\debug\\study_debug.py gui

Diagnostics folder: {diag}

Subcommands: collect, analyze, send, local-debug, enable-dumps, diary, dumps,
             sidecar, probe, freeze, watch, snapshot, stacks, smoke, gui,
             windows-collect
""".format(
            diag=diag
        ).strip()
    )


def _build_parser() -> argparse.ArgumentParser:
    epilog = """
examples (Windows installed Study):
  study_debug.py gui
  study_debug.py collect --zip --stacks
  study_debug.py analyze --zip %%USERPROFILE%%\\Desktop\\holdem-study-diagnostics.zip
  study_debug.py local-debug
  study_debug.py send --zip %%USERPROFILE%%\\Desktop\\holdem-study-diagnostics.zip
  study_debug.py dumps --since-hours 48
  study_debug.py sidecar --exe "C:\\Program Files\\Holdem Study\\solver-engine.exe"
  study_debug.py watch --duration 120
  study_debug.py probe --binary "C:\\Program Files\\Holdem Study\\solver-engine.exe"
""".strip()
    ap = argparse.ArgumentParser(
        prog="study_debug",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=epilog,
    )
    ap.add_argument(
        "command",
        nargs="?",
        help="collect | analyze | send | local-debug | enable-dumps | diary | "
        "dumps | sidecar | probe | freeze | watch | snapshot | stacks | smoke | "
        "gui | windows-collect",
    )
    ap.add_argument(
        "args",
        nargs=argparse.REMAINDER,
        help="Arguments forwarded to the underlying script",
    )
    return ap


def main(argv: Optional[Sequence[str]] = None) -> int:
    argv_list = list(sys.argv[1:] if argv is None else argv)
    # Allow `study_debug.py --help` without a subcommand.
    if argv_list in (["-h"], ["--help"]):
        _build_parser().print_help()
        return 0

    ap = _build_parser()
    ns = ap.parse_args(argv_list)
    command = ns.command
    rest = list(ns.args or [])
    # argparse.REMAINDER keeps a leading "--" if the user wrote one.
    if rest and rest[0] == "--":
        rest = rest[1:]

    if not command:
        _print_front_door()
        return 0

    command = _ALIASES.get(command, command)

    if command == "gui":
        return _cmd_gui(rest)
    if command in ("local-debug", "local_debug"):
        return _run_script("start_local_debug.py", rest)
    if command in ("enable-dumps", "enable_dumps"):
        return _cmd_enable_dumps(rest)
    if command == "diary":
        return _run_script("repro_diary.py", rest)
    if command in ("windows-collect", "win-collect", "wcollect"):
        return _cmd_windows_collect(rest)
    if command == "help":
        _print_front_door()
        _build_parser().print_help()
        return 0

    script = _COMMANDS.get(command)
    if not script:
        _eprint(f"unknown command: {command}")
        _print_front_door()
        return 2

    # Sensible defaults for the Windows "while frozen" path.
    # Front door always wants a zip + stacks unless the user already chose.
    if command == "collect":
        if "--zip" not in rest:
            rest = ["--zip", *rest]
        if "--stacks" not in rest:
            rest.append("--stacks")

    return _run_script(script, rest)


if __name__ == "__main__":
    # Ensure sibling imports work if someone runs tools that import _common
    # after being launched from an odd cwd — keep PATH for child scripts only.
    if str(_HERE) not in sys.path:
        sys.path.insert(0, str(_HERE))
    raise SystemExit(main())

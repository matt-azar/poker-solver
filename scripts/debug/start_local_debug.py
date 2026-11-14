#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Start a local Study debug report receiver (no Cloudflare).

Binds ``127.0.0.1``, saves incoming zips to disk, writes webhook config for
``send_report.py`` / the mini-app, and optionally opens the study-debug GUI.

Windows double-click::

  scripts\\debug\\study-debug-local.cmd

CLI::

  python scripts/debug/start_local_debug.py
  python scripts/debug/study_debug.py local-debug
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional, Sequence

_HERE = Path(__file__).resolve().parent
_RECEIVER = _HERE / "report-receiver" / "server.py"
_STUDY_DEBUG = _HERE / "study_debug.py"

# Import server helpers for config paths / secret (stdlib only).
if str(_HERE / "report-receiver") not in sys.path:
    sys.path.insert(0, str(_HERE / "report-receiver"))

from server import (  # noqa: E402
    DEFAULT_PORT,
    default_save_dir,
    ensure_shared_secret,
    holdem_study_config_dir,
)


def _eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def _find_free_port(preferred: int) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            s.bind(("127.0.0.1", 0))
            return int(s.getsockname()[1])


def _wait_health(url: str, timeout: float = 8.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=0.5) as resp:
                if resp.status == 200:
                    return True
        except (urllib.error.URLError, TimeoutError, OSError):
            time.sleep(0.1)
    return False


def write_webhook_config(*, url: str, secret: str, save_dir: Path) -> Path:
    cfg_dir = holdem_study_config_dir()
    cfg_dir.mkdir(parents=True, exist_ok=True)
    # Prefer ~/.holdem-study on all platforms for send_report discovery;
    # also mirror under LOCALAPPDATA Holdem Study on Windows.
    targets = [Path.home() / ".holdem-study" / "report-webhook.json"]
    if sys.platform == "win32":
        targets.append(cfg_dir / "report-webhook.json")
    payload = {
        "webhook_url": url,
        # Secret also in env; file helps mini-app / new shells. Do not commit.
        "secret": secret,
        "save_dir": str(save_dir),
        "local_disk": True,
        "note": "Written by start_local_debug.py — do not commit",
    }
    written = targets[0]
    for path in targets:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        try:
            path.chmod(0o600)
        except OSError:
            pass
        written = path
    return written


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", str(DEFAULT_PORT))),
    )
    ap.add_argument(
        "--save-dir",
        type=Path,
        default=None,
        help="Reports root (default: LOCALAPPDATA/Holdem Study/debug-reports "
        "or ~/.holdem-study/debug-reports)",
    )
    ap.add_argument(
        "--no-gui",
        action="store_true",
        help="Do not open study_debug mini-app",
    )
    ap.add_argument(
        "--open-folder",
        action="store_true",
        default=True,
        help="Open the reports folder in the file manager (default)",
    )
    ap.add_argument(
        "--no-open-folder",
        action="store_true",
        help="Do not open the reports folder",
    )
    ap.add_argument(
        "--github",
        action="store_true",
        help="Also create GitHub Issues when GITHUB_TOKEN / "
        "HOLDEM_STUDY_GITHUB_TOKEN is set in this environment",
    )
    ap.add_argument(
        "--watch",
        action="store_true",
        default=True,
        help="Start always-on hang watcher alongside the receiver (default)",
    )
    ap.add_argument(
        "--no-watch",
        action="store_true",
        help="Do not start watch_hang.py",
    )
    ap.add_argument(
        "--check-dumps",
        action="store_true",
        help="On Windows, print LocalDumps status (enable via enable-dumps)",
    )
    args = ap.parse_args(list(argv) if argv is not None else None)

    if not _RECEIVER.is_file():
        _eprint(f"error: missing receiver {_RECEIVER}")
        return 2

    port = _find_free_port(args.port)
    if port != args.port:
        _eprint(f"note: port {args.port} busy; using {port}")

    if args.save_dir is not None:
        os.environ["HOLDEM_STUDY_REPORT_SAVE_DIR"] = str(args.save_dir.expanduser())
    save_dir = default_save_dir()
    save_dir.mkdir(parents=True, exist_ok=True)

    secret = ensure_shared_secret(allow_generate=True)
    url = f"http://127.0.0.1:{port}/report"
    cfg_path = write_webhook_config(url=url, secret=secret, save_dir=save_dir)

    env = os.environ.copy()
    env["LOCAL_DISK"] = "1"
    env["REPORT_SHARED_SECRET"] = secret
    env["HOLDEM_STUDY_REPORT_WEBHOOK_URL"] = url
    env["HOLDEM_STUDY_REPORT_WEBHOOK_SECRET"] = secret
    env["HOLDEM_STUDY_REPORT_SAVE_DIR"] = str(save_dir)
    # Export for this process too (children inherit).
    os.environ.update(
        {
            "LOCAL_DISK": "1",
            "REPORT_SHARED_SECRET": secret,
            "HOLDEM_STUDY_REPORT_WEBHOOK_URL": url,
            "HOLDEM_STUDY_REPORT_WEBHOOK_SECRET": secret,
            "HOLDEM_STUDY_REPORT_SAVE_DIR": str(save_dir),
        }
    )

    if not args.github:
        # Disk-only unless user asked for GitHub; strip tokens from child so
        # accidental PATs on the machine do not force Issue create.
        env.pop("GITHUB_TOKEN", None)
        # Keep HOLDEM_STUDY_GITHUB_TOKEN only when --github.
        env.pop("HOLDEM_STUDY_GITHUB_TOKEN", None)

    cmd = [
        sys.executable,
        str(_RECEIVER),
        "--local-disk",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--save-dir",
        str(save_dir),
    ]
    _eprint("=== Holdem Study local debug receiver ===")
    _eprint(f"URL:       {url}")
    _eprint(f"Save dir:  {save_dir}")
    _eprint(f"Config:    {cfg_path}")
    _eprint("Bind:      127.0.0.1 only (not exposed to LAN)")
    _eprint("GitHub:    optional (pass --github + set a token)")
    _eprint("")
    _eprint("Use installed Study as usual. When you have a diagnostics zip:")
    _eprint("  study-debug.cmd send --zip path\\to\\zip --yes")
    _eprint("  or mini-app → Send report to GitHub (posts to localhost)")
    _eprint("Ctrl+C stops the receiver.")
    _eprint("")

    proc = subprocess.Popen(
        cmd,
        env=env,
        cwd=str(_HERE.parents[1]),
    )

    def _stop(*_args: object) -> None:
        if proc.poll() is None:
            proc.terminate()

    signal.signal(signal.SIGINT, _stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _stop)

    health = f"http://127.0.0.1:{port}/health"
    if not _wait_health(health):
        _eprint("error: receiver did not become healthy")
        _stop()
        return 1
    _eprint(f"health: ok ({health})")

    open_folder = args.open_folder and not args.no_open_folder
    if open_folder:
        try:
            if sys.platform == "win32":
                os.startfile(str(save_dir))  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(save_dir)])
            else:
                subprocess.Popen(["xdg-open", str(save_dir)])
        except OSError as exc:
            _eprint(f"note: could not open folder: {exc}")

    if args.check_dumps and sys.platform == "win32":
        dumps_ps1 = _HERE / "enable_local_dumps.ps1"
        if dumps_ps1.is_file():
            subprocess.call(
                [
                    "powershell",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(dumps_ps1),
                    "-StatusOnly",
                ]
            )
        _eprint(
            "Once: scripts\\debug\\study-debug.cmd enable-dumps  "
            "(elevated; enables LocalDumps for Study + solver-engine)"
        )

    watch_proc: Optional[subprocess.Popen[bytes]] = None
    do_watch = args.watch and not args.no_watch
    if do_watch:
        watch_script = _HERE / "watch_hang.py"
        if watch_script.is_file():
            watch_dir = save_dir / "hang-watch"
            watch_dir.mkdir(parents=True, exist_ok=True)
            try:
                watch_proc = subprocess.Popen(
                    [
                        sys.executable,
                        str(watch_script),
                        "--always",
                        "--quiet",
                        "--interval",
                        "2",
                        "--out-dir",
                        str(watch_dir),
                    ],
                    env=env,
                    cwd=str(_HERE.parents[1]),
                )
                _eprint(f"hang watcher → {watch_dir / 'hang-watch-events.jsonl'}")
            except OSError as exc:
                _eprint(f"note: could not start hang watcher: {exc}")

    gui_proc: Optional[subprocess.Popen[bytes]] = None
    if not args.no_gui and _STUDY_DEBUG.is_file():
        try:
            gui_proc = subprocess.Popen(
                [sys.executable, str(_STUDY_DEBUG), "gui"],
                env=env,
                cwd=str(_HERE.parents[1]),
            )
            _eprint("opened study-debug mini-app (Send report → localhost)")
        except OSError as exc:
            _eprint(f"note: could not open GUI: {exc}")

    code = proc.wait()
    for child in (watch_proc, gui_proc):
        if child and child.poll() is None:
            child.terminate()
    return int(code or 0)


if __name__ == "__main__":
    raise SystemExit(main())

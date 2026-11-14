#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Automated Windows Study crash/hang capture session.

Single entrypoint that:

1. Optionally ``git pull`` the clone onto latest ``main``
2. Ensures LocalDumps (idempotent; elevates once if needed)
3. Starts local receiver + hang watcher if not already healthy
4. Optionally launches installed Study when found
5. One-key ``collect`` → debug-reports + Cursor drop folder + summary.md

Windows::

  scripts\\debug\\study-debug-session.cmd
  scripts\\debug\\study-debug-session.cmd collect
  scripts\\debug\\study-debug-session.cmd handoff
  scripts\\debug\\study-debug-session.cmd install-startup

CLI::

  python scripts/debug/study_debug_session.py
  python scripts/debug/study_debug.py session
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional, Sequence

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parents[1]

if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
if str(_HERE / "report-receiver") not in sys.path:
    sys.path.insert(0, str(_HERE / "report-receiver"))

from _common import utc_now_iso, write_json  # noqa: E402
from server import default_save_dir, holdem_study_config_dir  # noqa: E402

# Known NSIS / side-by-side install locations for "Holdem Study.exe".
_STUDY_EXE_CANDIDATES = (
    Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Holdem Study" / "Holdem Study.exe",
    Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Holdem Study" / "Holdem Study.exe",
    Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
    / "Holdem Study"
    / "Holdem Study.exe",
    Path(os.environ.get("LOCALAPPDATA", "")) / "Holdem Study" / "Holdem Study.exe",
)

CURSOR_DROP_NAME = "CURSOR_DROP"
LATEST_POINTER_NAME = "LATEST.txt"
SUMMARY_NAME = "CURSOR_HANDOFF.md"
PID_FILE_NAME = "session-pids.json"


def _eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def _is_windows() -> bool:
    return sys.platform == "win32"


def reports_root(explicit: Optional[Path] = None) -> Path:
    if explicit is not None:
        return explicit.expanduser().resolve()
    env = os.environ.get("HOLDEM_STUDY_REPORT_SAVE_DIR", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    return default_save_dir().resolve()


def cursor_drop_dir(root: Optional[Path] = None) -> Path:
    return (root or reports_root()) / CURSOR_DROP_NAME


def webhook_config_paths() -> list[Path]:
    paths = [Path.home() / ".holdem-study" / "report-webhook.json"]
    if _is_windows():
        paths.append(holdem_study_config_dir() / "report-webhook.json")
    return paths


def load_webhook_config() -> Optional[dict[str, Any]]:
    for path in webhook_config_paths():
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and data.get("webhook_url"):
            return data
    return None


def _health_url_from_report_url(report_url: str) -> str:
    if report_url.rstrip("/").endswith("/report"):
        return report_url.rstrip("/")[: -len("/report")] + "/health"
    return report_url.rstrip("/") + "/health"


def receiver_healthy(timeout: float = 1.5) -> tuple[bool, Optional[str]]:
    cfg = load_webhook_config()
    if not cfg:
        return False, None
    url = str(cfg.get("webhook_url") or "")
    if not url:
        return False, None
    health = _health_url_from_report_url(url)
    try:
        with urllib.request.urlopen(health, timeout=timeout) as resp:
            if resp.status == 200:
                return True, url
    except (urllib.error.URLError, TimeoutError, OSError):
        pass
    return False, url


def ensure_git_pull(*, skip: bool = False, branch: str = "main") -> dict[str, Any]:
    result: dict[str, Any] = {"skipped": skip, "ok": True, "detail": ""}
    if skip:
        result["detail"] = "skipped by flag"
        return result
    git = shutil.which("git")
    if not git:
        result["ok"] = False
        result["detail"] = "git not on PATH"
        return result
    if not (_ROOT / ".git").exists():
        result["ok"] = False
        result["detail"] = f"not a git clone: {_ROOT}"
        return result

    def _run(args: list[str]) -> tuple[int, str]:
        proc = subprocess.run(
            [git, *args],
            cwd=str(_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        return int(proc.returncode), out.strip()

    # Stay non-destructive: fetch + ff-only pull when on the named branch.
    code, out = _run(["rev-parse", "--abbrev-ref", "HEAD"])
    if code != 0:
        result["ok"] = False
        result["detail"] = out or "rev-parse failed"
        return result
    current = out.strip()
    result["branch"] = current
    code, out = _run(["fetch", "origin", branch])
    if code != 0:
        result["ok"] = False
        result["detail"] = f"fetch failed: {out}"
        return result
    if current != branch:
        result["detail"] = (
            f"on branch {current!r} (not {branch}); fetched origin/{branch} only — "
            "no checkout/pull (avoid disrupting WIP)"
        )
        return result
    code, out = _run(["pull", "--ff-only", "origin", branch])
    if code != 0:
        result["ok"] = False
        result["detail"] = f"ff-only pull failed: {out}"
        return result
    result["detail"] = out or f"up to date with origin/{branch}"
    return result


def ensure_local_dumps(*, skip: bool = False, status_only: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {"skipped": skip, "ok": True, "detail": ""}
    if skip or not _is_windows():
        result["skipped"] = True
        result["detail"] = "skipped (non-Windows or flag)"
        return result
    ps1 = _HERE / "enable_local_dumps.ps1"
    if not ps1.is_file():
        result["ok"] = False
        result["detail"] = f"missing {ps1}"
        return result
    # Status-only first (no elevation).
    status_cmd = [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(ps1),
        "-StatusOnly",
    ]
    st = subprocess.run(status_cmd, capture_output=True, text=True, check=False)
    if st.returncode == 0:
        result["detail"] = "LocalDumps already configured"
        result["status_output"] = (st.stdout or "").strip()
        return result
    if status_only:
        result["ok"] = False
        result["detail"] = "LocalDumps incomplete (status-only)"
        result["status_output"] = (st.stdout or st.stderr or "").strip()
        return result
    _eprint("LocalDumps incomplete — enabling (may prompt UAC once)…")
    enable = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(ps1),
        ],
        check=False,
    )
    if enable.returncode != 0:
        result["ok"] = False
        result["detail"] = "enable_local_dumps failed or elevation cancelled"
        return result
    result["detail"] = "LocalDumps enabled"
    return result


def find_installed_study() -> Optional[Path]:
    env = os.environ.get("HOLDEM_STUDY_EXE", "").strip()
    if env:
        p = Path(env).expanduser()
        if p.is_file():
            return p
    for cand in _STUDY_EXE_CANDIDATES:
        try:
            if cand.is_file():
                return cand
        except OSError:
            continue
    if _is_windows():
        # Best-effort registry lookup (uninstall DisplayIcon / InstallLocation).
        try:
            import winreg  # type: ignore

            roots = [
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
                (
                    winreg.HKEY_LOCAL_MACHINE,
                    r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
                ),
                (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
            ]
            for hive, sub in roots:
                try:
                    with winreg.OpenKey(hive, sub) as key:
                        for i in range(0, 512):
                            try:
                                name = winreg.EnumKey(key, i)
                            except OSError:
                                break
                            try:
                                with winreg.OpenKey(key, name) as sk:
                                    try:
                                        display, _ = winreg.QueryValueEx(sk, "DisplayName")
                                    except OSError:
                                        continue
                                    if "holdem study" not in str(display).lower():
                                        continue
                                    for val_name in ("DisplayIcon", "InstallLocation"):
                                        try:
                                            val, _ = winreg.QueryValueEx(sk, val_name)
                                        except OSError:
                                            continue
                                        raw = str(val).strip().strip('"')
                                        if not raw:
                                            continue
                                        path = Path(raw.split(",")[0].strip())
                                        if path.is_file() and path.suffix.lower() == ".exe":
                                            return path
                                        cand = path / "Holdem Study.exe"
                                        if cand.is_file():
                                            return cand
                            except OSError:
                                continue
                except OSError:
                    continue
        except ImportError:
            pass
    return None


def study_already_running() -> bool:
    try:
        from _common import list_study_processes

        return any(p.role == "ui" for p in list_study_processes())
    except Exception:  # noqa: BLE001
        return False


def launch_study(*, skip: bool = False) -> dict[str, Any]:
    result: dict[str, Any] = {"skipped": skip, "ok": True, "detail": "", "path": None}
    if skip:
        result["detail"] = "skipped by flag"
        return result
    if study_already_running():
        result["detail"] = "Study UI already running"
        return result
    exe = find_installed_study()
    if exe is None:
        result["ok"] = False
        result["detail"] = (
            "installed Study not found under Program Files / LOCALAPPDATA; "
            "set HOLDEM_STUDY_EXE or launch manually"
        )
        return result
    result["path"] = str(exe)
    try:
        if _is_windows():
            os.startfile(str(exe))  # type: ignore[attr-defined]
        else:
            subprocess.Popen([str(exe)], cwd=str(exe.parent))
        result["detail"] = f"launched {exe}"
    except OSError as exc:
        result["ok"] = False
        result["detail"] = f"launch failed: {exc}"
    return result


def _pid_file(root: Path) -> Path:
    return root / PID_FILE_NAME


def _write_pids(root: Path, payload: dict[str, Any]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    write_json(_pid_file(root), payload)


def _read_pids(root: Path) -> dict[str, Any]:
    path = _pid_file(root)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    except AttributeError:
        # Windows without kill(0) semantics — fall through to tasklist-ish.
        pass
    if _is_windows():
        try:
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                capture_output=True,
                text=True,
                check=False,
            )
            return str(pid) in (out.stdout or "")
        except OSError:
            return False
    return True


def ensure_receiver_and_watch(
    *,
    save_dir: Path,
    no_gui: bool = False,
    no_watch: bool = False,
    no_open_folder: bool = False,
    check_dumps: bool = False,
) -> dict[str, Any]:
    """Start local-debug stack if receiver unhealthy; reuse when healthy."""
    result: dict[str, Any] = {
        "reused": False,
        "ok": True,
        "detail": "",
        "url": None,
        "save_dir": str(save_dir),
    }
    ok, url = receiver_healthy()
    if ok:
        result["reused"] = True
        result["url"] = url
        result["detail"] = f"receiver already healthy ({url})"
        # Ensure hang watcher if requested and not alive.
        if not no_watch:
            pids = _read_pids(save_dir)
            watch_pid = int(pids.get("watch_pid") or 0)
            if not _pid_alive(watch_pid):
                watch = _start_hang_watch(save_dir)
                pids["watch_pid"] = watch.get("pid")
                pids["updatedAt"] = utc_now_iso()
                _write_pids(save_dir, pids)
                result["detail"] += "; hang watcher (re)started"
            else:
                result["detail"] += f"; hang watcher pid={watch_pid}"
        if not no_gui:
            _start_gui()
        return result

    # Not healthy — start full local-debug (blocks until Ctrl+C when foreground).
    # For session start we prefer detaching so the interactive menu can continue.
    result["detail"] = "starting local receiver + hang watcher"
    env = os.environ.copy()
    env["HOLDEM_STUDY_REPORT_SAVE_DIR"] = str(save_dir)
    cmd = [
        sys.executable,
        str(_HERE / "start_local_debug.py"),
        "--save-dir",
        str(save_dir),
    ]
    if no_gui:
        cmd.append("--no-gui")
    if no_watch:
        cmd.append("--no-watch")
    if no_open_folder:
        cmd.append("--no-open-folder")
    if check_dumps:
        cmd.append("--check-dumps")

    # Detach: session owns the interactive loop; child owns receiver lifetime.
    creationflags = 0
    if _is_windows():
        # CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS-ish via CREATE_NEW_CONSOLE
        creationflags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)

    try:
        # New console shows receiver logs; avoid redirecting when detached.
        popen_kwargs: dict[str, Any] = {
            "cwd": str(_ROOT),
            "env": env,
            "creationflags": creationflags,
        }
        if creationflags == 0:
            popen_kwargs["stdout"] = subprocess.DEVNULL
            popen_kwargs["stderr"] = subprocess.DEVNULL
            popen_kwargs["start_new_session"] = True
        proc = subprocess.Popen(cmd, **popen_kwargs)
    except OSError as exc:
        result["ok"] = False
        result["detail"] = f"failed to start local-debug: {exc}"
        return result

    # Wait until healthy or timeout.
    deadline = time.time() + 20.0
    healthy = False
    while time.time() < deadline:
        ok, url = receiver_healthy(timeout=0.8)
        if ok:
            healthy = True
            result["url"] = url
            break
        if proc.poll() is not None:
            break
        time.sleep(0.25)

    pids = {
        "local_debug_pid": proc.pid,
        "startedAt": utc_now_iso(),
        "updatedAt": utc_now_iso(),
    }
    _write_pids(save_dir, pids)

    if not healthy:
        result["ok"] = False
        result["detail"] = (
            "local-debug started but receiver never became healthy — "
            "check Python / port conflict; try study-debug-local.cmd"
        )
        return result
    result["detail"] = f"started local-debug pid={proc.pid} url={result['url']}"
    return result


def _start_hang_watch(save_dir: Path) -> dict[str, Any]:
    watch_dir = save_dir / "hang-watch"
    watch_dir.mkdir(parents=True, exist_ok=True)
    creationflags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0) if _is_windows() else 0
    try:
        proc = subprocess.Popen(
            [
                sys.executable,
                str(_HERE / "watch_hang.py"),
                "--always",
                "--quiet",
                "--interval",
                "2",
                "--out-dir",
                str(watch_dir),
            ],
            cwd=str(_ROOT),
            creationflags=creationflags,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return {"ok": True, "pid": proc.pid, "out_dir": str(watch_dir)}
    except OSError as exc:
        return {"ok": False, "pid": None, "detail": str(exc)}


def _start_gui() -> None:
    try:
        creationflags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0) if _is_windows() else 0
        subprocess.Popen(
            [sys.executable, str(_HERE / "study_debug.py"), "gui"],
            cwd=str(_ROOT),
            creationflags=creationflags,
        )
    except OSError as exc:
        _eprint(f"note: could not open mini-app: {exc}")


def open_path(path: Path) -> None:
    try:
        if _is_windows():
            os.startfile(str(path))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except OSError as exc:
        _eprint(f"note: could not open {path}: {exc}")


def _latest_report_folder(root: Path) -> Optional[Path]:
    """Newest timestamped report / collect folder under debug-reports."""
    if not root.is_dir():
        return None
    candidates: list[Path] = []
    for child in root.iterdir():
        if not child.is_dir():
            continue
        name = child.name
        if name in {CURSOR_DROP_NAME, "hang-watch"}:
            continue
        if name.startswith(".") or name == "session-collect":
            continue
        # Prefer stamped folders (send reports + session collects).
        candidates.append(child)
    if not candidates:
        return None

    def _mtime(p: Path) -> float:
        try:
            return p.stat().st_mtime
        except OSError:
            return 0.0

    return max(candidates, key=_mtime)


def build_summary_md(
    *,
    report_dir: Path,
    primary_hint: Optional[str] = None,
    extra_notes: str = "",
) -> str:
    files = sorted(
        str(p.relative_to(report_dir)) for p in report_dir.rglob("*") if p.is_file()
    )
    dumps_note = ""
    crash = report_dir / "crash-dumps.json"
    if crash.is_file():
        try:
            data = json.loads(crash.read_text(encoding="utf-8"))
            dumps_note = f"Crash dump hits: {data.get('count', '?')}"
        except (OSError, json.JSONDecodeError):
            dumps_note = "Crash dump index present"
    diary = ""
    for name in ("repro-diary.md", "issue-body.md"):
        p = report_dir / name
        if p.is_file():
            diary = p.read_text(encoding="utf-8", errors="replace")[:4000]
            break
    hint = primary_hint or "(see diagnostics-analysis.json / INDEX.json)"
    lines = [
        "# Study debug handoff (paste / drag into Cursor)",
        "",
        f"- Captured: `{utc_now_iso()}`",
        f"- Report folder: `{report_dir}`",
        f"- Primary hint: **{hint}**",
        f"- Files: {len(files)}",
    ]
    if dumps_note:
        lines.append(f"- {dumps_note}")
    lines.extend(
        [
            "",
            "## What to attach",
            "",
            "1. This whole folder (preferred), **or**",
            "2. The `.zip` inside it + this summary + `repro-diary.md` if present",
            "3. Optional: matching `.dmp` under `%LOCALAPPDATA%\\CrashDumps\\`",
            "4. Optional: `hang-watch\\hang-watch-events.jsonl` sibling of reports",
            "",
            "## Drop location",
            "",
            f"`{cursor_drop_dir(report_dir.parent)}`",
            "",
            "No Cloudflare / `gh` auth required — disk only.",
            "",
        ]
    )
    if extra_notes.strip():
        lines.extend(["## Notes", "", extra_notes.strip(), ""])
    if diary.strip():
        lines.extend(["## Diary / issue body (excerpt)", "", diary.strip(), ""])
    lines.extend(
        [
            "## File list",
            "",
            *[f"- `{f}`" for f in files[:80]],
        ]
    )
    if len(files) > 80:
        lines.append(f"- … and {len(files) - 80} more")
    lines.append("")
    return "\n".join(lines)


def stage_cursor_drop(
    report_dir: Path,
    *,
    open_explorer: bool = True,
    primary_hint: Optional[str] = None,
    extra_notes: str = "",
) -> dict[str, Any]:
    """Stage CURSOR_DROP with summary + LATEST pointer for easy drag into Cursor."""
    root = report_dir.parent
    drop = cursor_drop_dir(root)
    drop.mkdir(parents=True, exist_ok=True)
    summary = build_summary_md(
        report_dir=report_dir,
        primary_hint=primary_hint,
        extra_notes=extra_notes,
    )
    summary_path = drop / SUMMARY_NAME
    summary_path.write_text(summary, encoding="utf-8")
    # Also place a copy next to the report for drag-one-folder workflows.
    report_summary = report_dir / SUMMARY_NAME
    report_summary.write_text(summary, encoding="utf-8")

    pointer = drop / LATEST_POINTER_NAME
    pointer.write_text(
        report_dir.as_posix() + "\n",
        encoding="utf-8",
    )

    # Refresh a "latest" staging copy of key pasteables (not the full dump zip —
    # keep sizes small; pointer + summary are enough; open Explorer on the report).
    for name in ("repro-diary.md", "issue-body.md", "INDEX.json", "diagnostics-analysis.json"):
        src = report_dir / name
        if src.is_file():
            shutil.copy2(src, drop / name)

    # Windows: update a junction named `latest-report` for Explorer convenience.
    junction = drop / "latest-report"
    if _is_windows():
        if junction.exists() or junction.is_symlink():
            try:
                if junction.is_dir() and not junction.is_symlink():
                    # junction — remove via rmdir
                    subprocess.run(
                        ["cmd", "/c", "rmdir", str(junction)],
                        check=False,
                        capture_output=True,
                    )
                else:
                    junction.unlink()
            except OSError:
                pass
        subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(junction), str(report_dir)],
            check=False,
            capture_output=True,
        )
    else:
        try:
            if junction.is_symlink() or junction.exists():
                if junction.is_dir() and not junction.is_symlink():
                    shutil.rmtree(junction)
                else:
                    junction.unlink()
            junction.symlink_to(report_dir, target_is_directory=True)
        except OSError as exc:
            _eprint(f"note: could not link latest-report: {exc}")

    write_json(
        drop / "handoff-meta.json",
        {
            "kind": "cursor-handoff",
            "timestamp": utc_now_iso(),
            "reportDir": str(report_dir),
            "summary": str(summary_path),
            "notify": {
                "cloudflare": False,
                "gh": False,
                "method": "disk drop folder + Explorer",
                "hint": (
                    "Drag CURSOR_HANDOFF.md or the latest-report folder into "
                    "Cursor chat / Debugging Suite Project"
                ),
            },
        },
    )

    if open_explorer:
        # Prefer the actual report folder so Matt sees the zip + diary.
        open_path(report_dir)
        open_path(drop)

    return {
        "ok": True,
        "drop_dir": str(drop),
        "summary": str(summary_path),
        "report_dir": str(report_dir),
        "pointer": str(pointer),
    }


def cmd_handoff(*, open_explorer: bool = True, report: Optional[Path] = None) -> int:
    root = reports_root()
    report_dir = report.expanduser().resolve() if report else _latest_report_folder(root)
    if report_dir is None or not report_dir.is_dir():
        _eprint(f"error: no report folders under {root}")
        _eprint("Run: study-debug-session.cmd collect   (or send a report first)")
        return 1
    primary = None
    for name in ("INDEX.json", "diagnostics-analysis.json"):
        p = report_dir / name
        if not p.is_file():
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            primary = data.get("primaryHint") or (
                (data.get("classification") or {}).get("primary")
            )
            if primary:
                break
        except (OSError, json.JSONDecodeError):
            continue
    staged = stage_cursor_drop(
        report_dir,
        open_explorer=open_explorer,
        primary_hint=str(primary) if primary else None,
    )
    print(f"handoff: {staged['drop_dir']}")
    print(f"summary: {staged['summary']}")
    print(f"report:  {staged['report_dir']}")
    print("Drag CURSOR_HANDOFF.md (or latest-report\\) into Cursor — no Cloudflare.")
    return 0


def cmd_collect(
    *,
    prompt_diary: bool = True,
    open_explorer: bool = True,
    stacks: bool = True,
    diary_args: Optional[dict[str, str]] = None,
) -> int:
    root = reports_root()
    root.mkdir(parents=True, exist_ok=True)
    stamp = utc_now_iso().replace(":", "")
    out = root / f"{stamp}_session-collect"
    cmd = [
        sys.executable,
        str(_HERE / "collect_bundle.py"),
        "--out",
        str(out),
        "--zip",
    ]
    if stacks:
        cmd.append("--stacks")
    if prompt_diary and sys.stdin.isatty():
        cmd.append("--prompt-diary")
    diary_args = diary_args or {}
    for key, flag in (
        ("symptom", "--diary-symptom"),
        ("clicked", "--diary-clicked"),
        ("street", "--diary-street"),
        ("notes", "--diary-notes"),
    ):
        val = (diary_args.get(key) or "").strip()
        if val:
            cmd.extend([flag, val])

    rc = int(subprocess.call(cmd, cwd=str(_ROOT)))
    if rc != 0:
        return rc
    if not out.is_dir():
        _eprint(f"error: collect did not create {out}")
        return 1

    primary = None
    index = out / "INDEX.json"
    if index.is_file():
        try:
            primary = json.loads(index.read_text(encoding="utf-8")).get("primaryHint")
        except (OSError, json.JSONDecodeError):
            pass

    staged = stage_cursor_drop(
        out,
        open_explorer=open_explorer,
        primary_hint=str(primary) if primary else None,
    )
    print(f"collect → {out}")
    print(f"Cursor drop → {staged['drop_dir']}")
    print(f"Paste/drag → {staged['summary']}")
    return 0


def install_startup(
    *,
    method: str = "startup-folder",
    with_study: bool = False,
    remove: bool = False,
) -> int:
    """Set-and-forget: start session tools at Windows login."""
    if not _is_windows():
        _eprint("install-startup is Windows-only")
        return 2

    session_cmd = _HERE / "study-debug-session.cmd"
    if not session_cmd.is_file():
        _eprint(f"error: missing {session_cmd}")
        return 2

    args = ["start", "--no-pull", "--no-gui", "--background"]
    if not with_study:
        args.append("--no-launch-study")

    if method == "startup-folder":
        startup = (
            Path(os.environ.get("APPDATA", ""))
            / "Microsoft"
            / "Windows"
            / "Start Menu"
            / "Programs"
            / "Startup"
        )
        startup.mkdir(parents=True, exist_ok=True)
        shortcut = startup / "HoldemStudy-DebugSession.cmd"
        if remove:
            if shortcut.is_file():
                shortcut.unlink()
                print(f"removed {shortcut}")
            else:
                print(f"nothing to remove at {shortcut}")
            return 0
        # Thin wrapper so Startup does not block on interactive menu.
        body = (
            "@echo off\r\n"
            f'REM Auto-start Study debug session tools (no Cloudflare)\r\n'
            f'cd /d "{_ROOT}"\r\n'
            f'call "{session_cmd}" {" ".join(args)}\r\n'
        )
        shortcut.write_text(body, encoding="utf-8")
        print(f"wrote Startup launcher: {shortcut}")
        print("Next login starts receiver + hang watcher (disk intake only).")
        print("Remove later: study-debug-session.cmd install-startup --remove")
        return 0

    if method == "schtasks":
        task_name = "HoldemStudyDebugSession"
        if remove:
            subprocess.run(
                ["schtasks", "/Delete", "/TN", task_name, "/F"],
                check=False,
            )
            print(f"removed scheduled task {task_name} (if it existed)")
            return 0
        # At logon for current user; no elevation needed for user task.
        tr = f'cmd /c "cd /d {_ROOT} && call {session_cmd} {" ".join(args)}"'
        cmd = [
            "schtasks",
            "/Create",
            "/TN",
            task_name,
            "/TR",
            tr,
            "/SC",
            "ONLOGON",
            "/RL",
            "LIMITED",
            "/F",
        ]
        rc = subprocess.call(cmd)
        if rc == 0:
            print(f"scheduled task {task_name} → on logon")
            print("Remove: study-debug-session.cmd install-startup --method schtasks --remove")
        return int(rc)

    _eprint(f"unknown method: {method} (use startup-folder|schtasks)")
    return 2


def interactive_menu() -> int:
    print("")
    print("Study debug session ready.")
    print("  [C] Collect now (snapshot + stacks + diary → CURSOR_DROP)")
    print("  [H] Handoff latest report to CURSOR_DROP / Explorer")
    print("  [O] Open debug-reports folder")
    print("  [G] Open mini-app")
    print("  [Q] Quit (receiver keeps running in its own window)")
    print("")
    while True:
        try:
            choice = input("Key (C/H/O/G/Q): ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("")
            return 0
        if choice in {"q", "quit", "exit"}:
            return 0
        if choice in {"c", "collect"}:
            cmd_collect(prompt_diary=True, open_explorer=True)
            continue
        if choice in {"h", "handoff"}:
            cmd_handoff(open_explorer=True)
            continue
        if choice in {"o", "open"}:
            open_path(reports_root())
            continue
        if choice in {"g", "gui"}:
            _start_gui()
            continue
        print("Unknown key — use C / H / O / G / Q")


def cmd_start(args: argparse.Namespace) -> int:
    save_dir = reports_root(Path(args.save_dir) if args.save_dir else None)
    save_dir.mkdir(parents=True, exist_ok=True)
    os.environ["HOLDEM_STUDY_REPORT_SAVE_DIR"] = str(save_dir)

    print("=== Holdem Study debug session ===")
    print(f"Reports:  {save_dir}")
    print(f"Drop:     {cursor_drop_dir(save_dir)}")
    print("")

    pull = ensure_git_pull(skip=args.no_pull)
    print(f"[git]  {'ok' if pull['ok'] else 'WARN'} — {pull['detail']}")

    dumps = ensure_local_dumps(skip=args.no_dumps or args.background)
    print(f"[dumps] {'ok' if dumps['ok'] else 'WARN'} — {dumps['detail']}")

    recv = ensure_receiver_and_watch(
        save_dir=save_dir,
        no_gui=args.no_gui or args.background,
        no_watch=args.no_watch,
        no_open_folder=args.no_open_folder or args.background,
        check_dumps=False,
    )
    print(f"[recv]  {'ok' if recv['ok'] else 'FAIL'} — {recv['detail']}")
    if not recv["ok"]:
        return 1

    launch = launch_study(skip=args.no_launch_study or args.background)
    status = "ok" if launch["ok"] or launch["skipped"] else "note"
    print(f"[study] {status} — {launch['detail']}")

    print("")
    print("Installed Study can crash/hang freely — leave it open if frozen.")
    print("Then press C here, or: study-debug-session.cmd collect")
    print("Drag CURSOR_DROP\\CURSOR_HANDOFF.md into Cursor when done.")
    print("")

    if args.background:
        print("background: receiver/watcher left running; exiting session UI")
        return 0
    if args.no_menu:
        return 0
    return interactive_menu()


def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "action",
        nargs="?",
        default="start",
        choices=(
            "start",
            "collect",
            "handoff",
            "install-startup",
            "status",
            "help",
        ),
        help="start (default) | collect | handoff | install-startup | status",
    )
    ap.add_argument("--save-dir", type=Path, default=None)
    ap.add_argument("--no-pull", action="store_true", help="Skip git fetch/pull")
    ap.add_argument("--no-dumps", action="store_true", help="Skip LocalDumps ensure")
    ap.add_argument("--no-launch-study", action="store_true")
    ap.add_argument("--no-gui", action="store_true")
    ap.add_argument("--no-watch", action="store_true")
    ap.add_argument("--no-open-folder", action="store_true")
    ap.add_argument("--no-menu", action="store_true", help="Bootstrap only; no key loop")
    ap.add_argument(
        "--background",
        action="store_true",
        help="Startup-friendly: no menu/GUI/Study/pull elevation UX",
    )
    ap.add_argument("--no-stacks", action="store_true", help="collect without stacks")
    ap.add_argument("--no-diary-prompt", action="store_true")
    ap.add_argument("--report", type=Path, help="handoff: specific report folder")
    ap.add_argument(
        "--method",
        choices=("startup-folder", "schtasks"),
        default="startup-folder",
        help="install-startup method",
    )
    ap.add_argument(
        "--with-study",
        action="store_true",
        help="install-startup: also launch Study at login",
    )
    ap.add_argument("--remove", action="store_true", help="install-startup: remove")
    ap.add_argument("--diary-symptom", default="")
    ap.add_argument("--diary-clicked", default="")
    ap.add_argument("--diary-street", default="")
    ap.add_argument("--diary-notes", default="")
    return ap


def cmd_status() -> int:
    root = reports_root()
    ok, url = receiver_healthy()
    print(f"reports:   {root}")
    print(f"drop:      {cursor_drop_dir(root)}")
    print(f"receiver:  {'healthy' if ok else 'down'} {url or ''}")
    pids = _read_pids(root)
    if pids:
        print(f"pids:      {json.dumps(pids)}")
    latest = _latest_report_folder(root)
    print(f"latest:    {latest or '(none)'}")
    study = find_installed_study()
    print(f"study.exe: {study or '(not found)'}")
    if _is_windows():
        dumps = ensure_local_dumps(status_only=True)
        print(f"dumps:     {dumps['detail']}")
    return 0 if ok else 1


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = _build_parser()
    args = ap.parse_args(list(argv) if argv is not None else None)
    if args.action == "help":
        ap.print_help()
        return 0
    if args.save_dir is not None:
        os.environ["HOLDEM_STUDY_REPORT_SAVE_DIR"] = str(args.save_dir.expanduser())

    if args.action == "status":
        return cmd_status()
    if args.action == "collect":
        return cmd_collect(
            prompt_diary=not args.no_diary_prompt,
            open_explorer=not args.no_open_folder,
            stacks=not args.no_stacks,
            diary_args={
                "symptom": args.diary_symptom,
                "clicked": args.diary_clicked,
                "street": args.diary_street,
                "notes": args.diary_notes,
            },
        )
    if args.action == "handoff":
        return cmd_handoff(
            open_explorer=not args.no_open_folder,
            report=args.report,
        )
    if args.action == "install-startup":
        return install_startup(
            method=args.method,
            with_study=args.with_study,
            remove=args.remove,
        )
    return cmd_start(args)


if __name__ == "__main__":
    raise SystemExit(main())

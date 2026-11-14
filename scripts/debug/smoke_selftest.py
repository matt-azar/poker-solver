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
import os
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

    # send_report dry-run (no credentials / no network create required).
    send_script = _HERE / "send_report.py"
    if not send_script.is_file():
        failures.append("missing send_report.py")
    else:
        with tempfile.TemporaryDirectory(prefix="study-debug-send-smoke-") as tmp_send:
            diag_send = Path(tmp_send) / "diagnostics"
            _synthetic_diag(diag_send)
            import zipfile

            zpath = Path(tmp_send) / "diag.zip"
            with zipfile.ZipFile(zpath, "w") as zf:
                for p in diag_send.iterdir():
                    if p.is_file():
                        zf.write(p, arcname=p.name)
            body_out = Path(tmp_send) / "body.md"
            json_out = Path(tmp_send) / "send.json"
            send_rc = subprocess.call(
                [
                    sys.executable,
                    str(send_script),
                    "--zip",
                    str(zpath),
                    "--dry-run",
                    "--out-body",
                    str(body_out),
                    "--json-out",
                    str(json_out),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if send_rc != 0 or not body_out.is_file() or not json_out.is_file():
                failures.append("send_report --dry-run")
            else:
                body_txt = body_out.read_text(encoding="utf-8")
                if "study-debug-report" not in body_txt:
                    failures.append("send_report body missing marker")
            auth_rc = subprocess.call(
                [sys.executable, str(send_script), "--auth-check"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            # auth-check may return 1 when unauthenticated — that is still a valid run.
            if auth_rc not in (0, 1):
                failures.append(f"send_report --auth-check rc={auth_rc}")

            # Webhook path against local dry-run receiver (no live GitHub).
            receiver = _HERE / "report-receiver" / "server.py"
            if not receiver.is_file():
                failures.append("missing report-receiver/server.py")
            else:
                import socket
                import time

                sock = socket.socket()
                sock.bind(("127.0.0.1", 0))
                port = int(sock.getsockname()[1])
                sock.close()
                secret = "smoke-webhook-secret"
                env = os.environ.copy()
                env["REPORT_SHARED_SECRET"] = secret
                env["DRY_RUN"] = "1"
                # Clear client GitHub tokens so auth is via webhook only.
                for k in (
                    "HOLDEM_STUDY_GITHUB_TOKEN",
                    "GH_TOKEN",
                    "GITHUB_TOKEN",
                    "HOLDEM_STUDY_REPORT_WEBHOOK_URL",
                    "HOLDEM_STUDY_REPORT_WEBHOOK_SECRET",
                ):
                    env.pop(k, None)
                proc = subprocess.Popen(
                    [
                        sys.executable,
                        str(receiver),
                        "--host",
                        "127.0.0.1",
                        "--port",
                        str(port),
                        "--dry-run",
                    ],
                    env=env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                try:
                    ready = False
                    for _ in range(50):
                        if proc.poll() is not None:
                            break
                        try:
                            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                                ready = True
                                break
                        except OSError:
                            time.sleep(0.05)
                    if not ready:
                        err = ""
                        if proc.stderr:
                            try:
                                err = proc.stderr.read(500)
                            except OSError:
                                pass
                        failures.append(f"report-receiver failed to start: {err}")
                    else:
                        wh_json = Path(tmp_send) / "webhook-send.json"
                        wh_env = env.copy()
                        wh_env["HOLDEM_STUDY_REPORT_WEBHOOK_URL"] = (
                            f"http://127.0.0.1:{port}/report"
                        )
                        wh_env["HOLDEM_STUDY_REPORT_WEBHOOK_SECRET"] = secret
                        wh_rc = subprocess.call(
                            [
                                sys.executable,
                                str(send_script),
                                "--zip",
                                str(zpath),
                                "--yes",
                                "--webhook-dry-run",
                                "--json-out",
                                str(wh_json),
                            ],
                            env=wh_env,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                        )
                        if wh_rc != 0 or not wh_json.is_file():
                            failures.append("send_report webhook dry-run")
                        else:
                            import json as _json

                            try:
                                payload = _json.loads(
                                    wh_json.read_text(encoding="utf-8")
                                )
                            except _json.JSONDecodeError:
                                failures.append("webhook dry-run bad json")
                            else:
                                if not payload.get("ok") or not payload.get(
                                    "webhook_dry_run"
                                ):
                                    failures.append("webhook dry-run payload")
                        auth2 = subprocess.call(
                            [sys.executable, str(send_script), "--auth-check"],
                            env=wh_env,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                        )
                        if auth2 != 0:
                            failures.append("webhook --auth-check expected ok")
                finally:
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()

                # Local-disk receiver (primary no-Cloudflare path).
                sock2 = socket.socket()
                sock2.bind(("127.0.0.1", 0))
                port2 = int(sock2.getsockname()[1])
                sock2.close()
                save_root = Path(tmp_send) / "local-reports"
                secret2 = "smoke-local-disk-secret"
                env2 = os.environ.copy()
                env2["REPORT_SHARED_SECRET"] = secret2
                env2["LOCAL_DISK"] = "1"
                env2["HOLDEM_STUDY_REPORT_SAVE_DIR"] = str(save_root)
                for k in (
                    "HOLDEM_STUDY_GITHUB_TOKEN",
                    "GH_TOKEN",
                    "GITHUB_TOKEN",
                    "HOLDEM_STUDY_REPORT_WEBHOOK_URL",
                    "HOLDEM_STUDY_REPORT_WEBHOOK_SECRET",
                    "DRY_RUN",
                ):
                    env2.pop(k, None)
                proc2 = subprocess.Popen(
                    [
                        sys.executable,
                        str(receiver),
                        "--local-disk",
                        "--host",
                        "127.0.0.1",
                        "--port",
                        str(port2),
                        "--save-dir",
                        str(save_root),
                    ],
                    env=env2,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                try:
                    ready2 = False
                    for _ in range(50):
                        if proc2.poll() is not None:
                            break
                        try:
                            with socket.create_connection(
                                ("127.0.0.1", port2), timeout=0.2
                            ):
                                ready2 = True
                                break
                        except OSError:
                            time.sleep(0.05)
                    if not ready2:
                        failures.append("local-disk receiver failed to start")
                    else:
                        ld_json = Path(tmp_send) / "local-disk-send.json"
                        ld_env = env2.copy()
                        ld_env["HOLDEM_STUDY_REPORT_WEBHOOK_URL"] = (
                            f"http://127.0.0.1:{port2}/report"
                        )
                        ld_env["HOLDEM_STUDY_REPORT_WEBHOOK_SECRET"] = secret2
                        ld_rc = subprocess.call(
                            [
                                sys.executable,
                                str(send_script),
                                "--zip",
                                str(zpath),
                                "--yes",
                                "--json-out",
                                str(ld_json),
                            ],
                            env=ld_env,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                        )
                        if ld_rc != 0 or not ld_json.is_file():
                            failures.append("send_report local-disk")
                        else:
                            import json as _json2

                            try:
                                ld_payload = _json2.loads(
                                    ld_json.read_text(encoding="utf-8")
                                )
                            except _json2.JSONDecodeError:
                                failures.append("local-disk bad json")
                            else:
                                if not ld_payload.get("ok") or not ld_payload.get(
                                    "saved_dir"
                                ):
                                    failures.append(
                                        "local-disk payload missing saved_dir"
                                    )
                                elif not Path(str(ld_payload["saved_dir"])).is_dir():
                                    failures.append(
                                        "local-disk saved_dir missing on disk"
                                    )
                        sld = _HERE / "start_local_debug.py"
                        if not sld.is_file():
                            failures.append("missing start_local_debug.py")
                        else:
                            help_rc = subprocess.call(
                                [sys.executable, str(sld), "--help"],
                                stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL,
                            )
                        if help_rc != 0:
                            failures.append("start_local_debug --help")
                        diary_script = _HERE / "repro_diary.py"
                        if not diary_script.is_file():
                            failures.append("missing repro_diary.py")
                        else:
                            d_out = Path(tmp_send) / "diary.md"
                            d_rc = subprocess.call(
                                [
                                    sys.executable,
                                    str(diary_script),
                                    "--symptom",
                                    "hang",
                                    "--clicked",
                                    "Solve",
                                    "--street-state",
                                    "river",
                                    "--notes",
                                    "smoke",
                                    "--out",
                                    str(d_out),
                                ],
                                stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL,
                            )
                            if d_rc != 0 or not d_out.is_file():
                                failures.append("repro_diary write")
                            elif "Study repro diary" not in d_out.read_text(
                                encoding="utf-8"
                            ):
                                failures.append("repro_diary content")
                        if not (_HERE / "enable_local_dumps.ps1").is_file():
                            failures.append("missing enable_local_dumps.ps1")
                        if not (_HERE / "repro_diary_template.md").is_file():
                            failures.append("missing repro_diary_template.md")
                        watch_script = _HERE / "watch_hang.py"
                        wh_dir = Path(tmp_send) / "hang-watch"
                        wh_rc = subprocess.call(
                            [
                                sys.executable,
                                str(watch_script),
                                "--duration",
                                "0.2",
                                "--interval",
                                "0.1",
                                "--out-dir",
                                str(wh_dir),
                                "--quiet",
                            ],
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                        )
                        if wh_rc != 0:
                            failures.append("watch_hang short run")
                        elif not (wh_dir / "hang-watch-events.jsonl").exists():
                            # empty file may not exist if no events — create ok if dir exists
                            if not wh_dir.is_dir():
                                failures.append("watch_hang out-dir")
                finally:
                    proc2.terminate()
                    try:
                        proc2.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc2.kill()

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
            send_help = subprocess.call(
                [sys.executable, str(front), "send", "--help"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if send_help != 0:
                failures.append("study_debug send --help")
            local_help = subprocess.call(
                [sys.executable, str(front), "local-debug", "--help"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if local_help != 0:
                failures.append("study_debug local-debug --help")
            session_help = subprocess.call(
                [sys.executable, str(front), "session", "help"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if session_help != 0:
                failures.append("study_debug session help")
        # Session automation: handoff staging + summary (no live Study / receiver).
        session_script = _HERE / "study_debug_session.py"
        if not session_script.is_file():
            failures.append("missing study_debug_session.py")
        else:
            sess_help = subprocess.call(
                [sys.executable, str(session_script), "help"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if sess_help != 0:
                failures.append("study_debug_session help")
            for name in (
                "study-debug-session.cmd",
                "study-debug-session.ps1",
            ):
                if not (_HERE / name).is_file():
                    failures.append(f"missing {name}")
            with tempfile.TemporaryDirectory(prefix="study-debug-session-") as tmp_s:
                root = Path(tmp_s) / "debug-reports"
                report = root / "20260101T000000Z_session-collect"
                report.mkdir(parents=True)
                write_json(
                    report / "INDEX.json",
                    {
                        "createdAt": "2026-01-01T00:00:00Z",
                        "primaryHint": "hang",
                        "files": ["INDEX.json"],
                    },
                )
                (report / "repro-diary.md").write_text(
                    "# Study repro diary\n\n- Symptom: hang\n",
                    encoding="utf-8",
                )
                hand_rc = subprocess.call(
                    [
                        sys.executable,
                        str(session_script),
                        "handoff",
                        "--save-dir",
                        str(root),
                        "--report",
                        str(report),
                        "--no-open-folder",
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                drop = root / "CURSOR_DROP"
                summary = drop / "CURSOR_HANDOFF.md"
                if hand_rc != 0 or not summary.is_file():
                    failures.append("session handoff staging")
                elif "paste / drag into Cursor" not in summary.read_text(
                    encoding="utf-8"
                ):
                    failures.append("session handoff summary content")
                elif not (drop / "LATEST.txt").is_file():
                    failures.append("session LATEST pointer")
                # collect into save-dir without diary prompt / stacks (fast).
                col_rc = subprocess.call(
                    [
                        sys.executable,
                        str(session_script),
                        "collect",
                        "--save-dir",
                        str(root),
                        "--no-diary-prompt",
                        "--no-stacks",
                        "--no-open-folder",
                        "--diary-symptom",
                        "hang",
                        "--diary-notes",
                        "smoke",
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                if col_rc != 0:
                    failures.append("session collect")
                else:
                    stamped = [
                        p
                        for p in root.iterdir()
                        if p.is_dir() and p.name.endswith("_session-collect")
                    ]
                    if not stamped:
                        failures.append("session collect out dir")
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

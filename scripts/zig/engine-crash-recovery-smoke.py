#!/usr/bin/env python3
"""Real-sidecar engine crash recovery smoke (ZR-143).

Proves on Linux cloud (no Windows installer / ma1pc):
  1) Kill/die of solver-engine mid-session leaves a cold process with no
     published solution — restart alone cannot restore unsaved progress.
  2) Opening the last saved checkpoint restores only what was on disk
     (saved iteration count), not later unsaved train work.

Flow:
  ready → begin_config → solve 10 → save .psol → continue +5 (unsaved=15)
  → kill sidecar → spawn fresh → status has no solution_id
  → open saved path → iterations == 10 (not 15)

Uses river_gate_smoke. Wall bound defaults to 45s.
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "benchmarks/study/configs/river_gate_smoke.txt"
DEFAULT_BINARY = ROOT / "zig-out/bin/solver-engine"
if os.name == "nt" and not DEFAULT_BINARY.is_file():
    DEFAULT_BINARY = ROOT / "zig-out/bin/solver-engine.exe"


class SmokeError(RuntimeError):
    pass


def encode(op: str, body: Any, request_id: str, job_id: str | None = None) -> bytes:
    envelope = {
        "v": 2,
        "kind": "request",
        "request_id": request_id,
        "job_id": job_id,
        "op": op,
        "body": body,
    }
    payload = json.dumps(envelope, separators=(",", ":")).encode()
    return struct.pack("<I", len(payload)) + payload


def read_frame(stdout) -> dict:
    hdr = stdout.read(4)
    if not hdr or len(hdr) < 4:
        raise SmokeError("solver-engine pipe closed (no length prefix)")
    (n,) = struct.unpack("<I", hdr)
    payload = stdout.read(n)
    if not payload or len(payload) < n:
        raise SmokeError("solver-engine pipe closed (truncated payload)")
    env = json.loads(payload)
    if env.get("kind") == "progress":
        return read_frame(stdout)
    if env.get("kind") != "reply":
        raise SmokeError(f"unexpected kind: {env!r}")
    return env


def write_req(
    proc: subprocess.Popen,
    op: str,
    body: Any,
    request_id: str,
    job_id: str | None = None,
) -> None:
    assert proc.stdin is not None
    proc.stdin.write(encode(op, body, request_id, job_id))
    proc.stdin.flush()


def body_dict(env: dict) -> dict:
    body = env.get("body")
    if body is None:
        return {}
    if isinstance(body, dict):
        return body
    if isinstance(body, str):
        return json.loads(body)
    raise SmokeError(f"unexpected body type: {type(body)}")


def require(cond: bool, msg: str) -> None:
    if not cond:
        raise SmokeError(msg)


def kill_proc(proc: subprocess.Popen | None) -> None:
    if proc is None:
        return
    try:
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=5)
    except Exception:  # noqa: BLE001 — best-effort teardown
        pass


class ReplyInbox:
    def __init__(self, stdout) -> None:
        self.stdout = stdout
        self.pending: list[dict] = []

    def _pull(self) -> dict:
        env = read_frame(self.stdout)
        self.pending.append(env)
        return env

    def take(self, op: str, *, timeout_s: float) -> dict:
        deadline = time.perf_counter() + timeout_s
        while True:
            for i, env in enumerate(self.pending):
                if env.get("op") == op:
                    return self.pending.pop(i)
            if time.perf_counter() >= deadline:
                ops = [e.get("op") for e in self.pending]
                raise SmokeError(f"timeout waiting for op={op!r}; pending={ops}")
            self._pull()

    def rpc(
        self,
        proc: subprocess.Popen,
        op: str,
        body: Any,
        request_id: str,
        job_id: str | None = None,
        *,
        expect_ok: bool = True,
        timeout_s: float = 30.0,
    ) -> dict:
        write_req(proc, op, body, request_id, job_id)
        env = self.take(op, timeout_s=timeout_s)
        if expect_ok and not env.get("ok", False):
            raise SmokeError(
                f"{env.get('error_code')}: {env.get('error_message')} ({env.get('op')})"
            )
        return env


def spawn_engine(binary: Path, launch_id: str) -> subprocess.Popen:
    return subprocess.Popen(
        [str(binary), "--launch-id", launch_id],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def admit_solve(
    inbox: ReplyInbox,
    proc: subprocess.Popen,
    iterations: int,
    request_id: str,
    job_id: str,
) -> dict:
    write_req(proc, "solve", {"iterations": iterations}, request_id, job_id=job_id)
    env = inbox.take("solve", timeout_s=15.0)
    require(env.get("ok"), f"solve admit failed: {env}")
    body = body_dict(env)
    require(body.get("accepted") is True, f"admit accepted: {body}")
    require(body.get("running") is True, f"admit running: {body}")
    return body


def wait_until_idle(
    inbox: ReplyInbox,
    proc: subprocess.Popen,
    label: str,
    *,
    timeout_s: float = 30.0,
) -> dict:
    deadline = time.perf_counter() + timeout_s
    n = 0
    last: dict = {}
    while time.perf_counter() < deadline:
        last = body_dict(
            inbox.rpc(proc, "status", None, f"zr143-idle-{label}-{n}", timeout_s=5.0)
        )
        n += 1
        if last.get("running") is False:
            return last
        time.sleep(0.002)
    raise SmokeError(f"{label}: timed out waiting for idle; last={last}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "binary",
        nargs="?",
        type=Path,
        default=DEFAULT_BINARY,
        help="Path to solver-engine (or .exe)",
    )
    ap.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG,
        help="street-config fixture (default: river_gate_smoke)",
    )
    ap.add_argument(
        "--overall-timeout",
        type=float,
        default=45.0,
        help="hard wall for the whole smoke; kill sidecar on exceed",
    )
    args = ap.parse_args()

    binary: Path = args.binary
    config_path: Path = args.config
    if not binary.is_file():
        print(f"BLOCKER: missing binary {binary}", file=sys.stderr)
        return 2
    if not config_path.is_file():
        print(f"BLOCKER: missing config {config_path}", file=sys.stderr)
        return 2

    config_text = config_path.read_text(encoding="utf-8")
    if not config_text.endswith("\n"):
        config_text += "\n"

    timed_out = {"hit": False}
    result: dict[str, Any] = {
        "ok": False,
        "fixture": str(config_path),
        "binary": str(binary),
        "smoke": "zr143-engine-crash-recovery",
    }
    t0 = time.perf_counter()
    proc: subprocess.Popen | None = None
    proc2: subprocess.Popen | None = None
    tmp_path: str | None = None

    def _hard_kill() -> None:
        timed_out["hit"] = True
        kill_proc(proc)
        kill_proc(proc2)

    timer = threading.Timer(args.overall_timeout, _hard_kill)
    timer.daemon = True
    timer.start()

    try:
        stages: dict[str, Any] = {}

        # --- session A: train, save, unsaved continue, then die ---
        proc = spawn_engine(binary, "zr143-crash-a")
        assert proc.stdout is not None
        inbox = ReplyInbox(proc.stdout)

        ready = body_dict(inbox.rpc(proc, "ready", None, "zr143-ready"))
        require(ready.get("protocol") == 2, f"bad protocol: {ready}")
        inbox.rpc(proc, "begin_config", {"config_text": config_text}, "zr143-begin")
        admit_solve(inbox, proc, 10, "zr143-solve-10", "j-zr143-10")
        saved_status = wait_until_idle(inbox, proc, "save-10")
        require(
            int(saved_status.get("iterations") or -1) == 10,
            f"pre-save iterations!=10: {saved_status}",
        )
        require(saved_status.get("solution_id"), f"missing solution before save: {saved_status}")

        fd, tmp_path = tempfile.mkstemp(prefix="zr143-", suffix=".psol")
        os.close(fd)
        save_env = inbox.rpc(proc, "save", {"path": tmp_path}, "zr143-save")
        require(body_dict(save_env).get("saved") is True, f"save: {save_env}")
        stages["saved"] = {
            "path": tmp_path,
            "iterations": saved_status.get("iterations"),
            "solution_id": saved_status.get("solution_id"),
        }

        # Unsaved progress: continue past the checkpoint without Save.
        # After open of the saved file we must see 10, never these 15.
        admit_solve(inbox, proc, 5, "zr143-unsaved-5", "j-zr143-unsaved")
        unsaved = wait_until_idle(inbox, proc, "unsaved-15")
        require(
            int(unsaved.get("iterations") or -1) == 15,
            f"unsaved continue iterations!=15: {unsaved}",
        )
        stages["unsaved_before_kill"] = {
            "iterations": unsaved.get("iterations"),
            "phase": unsaved.get("phase"),
            "solution_id": unsaved.get("solution_id"),
        }

        # Die: SIGKILL the sidecar (pipe death). Desktop is a separate process.
        kill_proc(proc)
        proc = None
        stages["killed"] = {"ok": True}

        # --- session B: restart alone cannot restore unsaved progress ---
        proc2 = spawn_engine(binary, "zr143-crash-b")
        assert proc2.stdout is not None
        inbox2 = ReplyInbox(proc2.stdout)
        ready2 = body_dict(inbox2.rpc(proc2, "ready", None, "zr143-ready-b"))
        require(ready2.get("protocol") == 2, f"bad protocol B: {ready2}")
        cold = body_dict(inbox2.rpc(proc2, "status", None, "zr143-cold"))
        require(
            cold.get("solution_id") in (None, "", False),
            f"restart alone restored solution_id: {cold}",
        )
        require(
            cold.get("running") is False,
            f"cold status running: {cold}",
        )
        require(
            int(cold.get("iterations") or 0) == 0,
            f"cold status leaked iterations from dead session: {cold}",
        )
        stages["cold_restart"] = {
            "solution_id": cold.get("solution_id"),
            "iterations": cold.get("iterations"),
            "phase": cold.get("phase"),
            "note": "restart alone does not restore unsaved progress",
        }

        # Reopen last valid checkpoint — only saved iters (10), not unsaved mid-train.
        open_env = inbox2.rpc(proc2, "open", {"path": tmp_path}, "zr143-open")
        open_body = body_dict(open_env)
        require(open_body.get("solution_id"), f"open missing solution_id: {open_body}")
        require(
            open_body.get("can_continue") is True,
            f"open can_continue: {open_body}",
        )
        require(
            open_body.get("has_training") is True,
            f"open has_training: {open_body}",
        )
        # Open reply may embed status fields; also poll status for iterations.
        after_open = body_dict(inbox2.rpc(proc2, "status", None, "zr143-after-open"))
        opened_iters = int(
            after_open.get("iterations")
            if after_open.get("iterations") is not None
            else open_body.get("iterations")
            if open_body.get("iterations") is not None
            else -1
        )
        require(
            opened_iters == 10,
            f"open restored unsaved progress (want 10, got {opened_iters}): "
            f"open={open_body} status={after_open}",
        )
        require(
            after_open.get("solution_id"),
            f"status after open missing solution_id: {after_open}",
        )
        stages["reopen_checkpoint"] = {
            "iterations": opened_iters,
            "solution_id": after_open.get("solution_id"),
            "can_continue": open_body.get("can_continue"),
            "note": "only last saved checkpoint restored; unsaved continue discarded",
        }

        require(not timed_out["hit"], "overall timeout hit")
        wall_s = round(time.perf_counter() - t0, 4)
        result.update({"ok": True, "wall_s": wall_s, "stages": stages})
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except Exception as exc:  # noqa: BLE001 — surface as smoke failure
        result["ok"] = False
        result["error"] = str(exc)
        result["wall_s"] = round(time.perf_counter() - t0, 4)
        result["timed_out"] = timed_out["hit"]
        print(json.dumps(result, separators=(",", ":")), file=sys.stderr)
        print(f"engine-crash-recovery-smoke FAILED: {exc}", file=sys.stderr)
        return 1
    finally:
        timer.cancel()
        if tmp_path and os.path.isfile(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        kill_proc(proc)
        kill_proc(proc2)


if __name__ == "__main__":
    raise SystemExit(main())

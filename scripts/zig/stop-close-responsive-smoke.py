#!/usr/bin/env python3
"""ZR-151: Stop/status stay live during values; compile cancel; slow EV ≠ kill train.

Real-sidecar Linux smoke (cloud VM). Exercises:
  1. After a published river solve, enqueue `values` then immediately `status`
     and `cancel` — both control ops must reply while values may still run.
  2. A cancelled begin_config (Stop during compile) must not wipe a prior
     published solution when stop is observed before install.
  3. After cancel, train is cancelled; a slow/lingering values reply must not
     leave the session unable to admit a fresh solve.

No Accuracy walls. Overall wall bound defaults to 90s.
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
    envelope: dict[str, Any] = {
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
    if n == 0 or n > 16 * 1024 * 1024:
        raise SmokeError(f"invalid frame length {n}")
    payload = stdout.read(n)
    if not payload or len(payload) < n:
        raise SmokeError("solver-engine pipe closed (truncated payload)")
    return json.loads(payload)


class Inbox:
    def __init__(self, proc: subprocess.Popen) -> None:
        self._proc = proc
        self._by_id: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        self._error: Exception | None = None
        assert proc.stdout is not None
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        try:
            while True:
                env = read_frame(self._proc.stdout)
                if env.get("kind") == "progress":
                    continue
                rid = env.get("request_id")
                if not isinstance(rid, str):
                    continue
                with self._cv:
                    self._by_id[rid] = env
                    self._cv.notify_all()
        except Exception as exc:  # noqa: BLE001 — surface to waiters
            with self._cv:
                self._error = exc
                self._cv.notify_all()

    def take(self, request_id: str, timeout_s: float) -> dict:
        deadline = time.monotonic() + timeout_s
        with self._cv:
            while request_id not in self._by_id:
                if self._error is not None:
                    raise SmokeError(f"inbox reader failed: {self._error}")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise SmokeError(f"timeout waiting for {request_id}")
                self._cv.wait(timeout=remaining)
            return self._by_id.pop(request_id)


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
    if isinstance(body, dict):
        return body
    if isinstance(body, str):
        return json.loads(body)
    return {}


def require(cond: bool, msg: str) -> None:
    if not cond:
        raise SmokeError(msg)


def wait_until_idle(inbox: Inbox, proc: subprocess.Popen, label: str, timeout_s: float = 30.0) -> dict:
    deadline = time.monotonic() + timeout_s
    last: dict = {}
    n = 0
    while time.monotonic() < deadline:
        n += 1
        rid = f"status-{label}-{n}"
        write_req(proc, "status", None, rid)
        env = inbox.take(rid, timeout_s=5.0)
        require(env.get("ok"), f"status failed ({label}): {env}")
        last = body_dict(env)
        if not last.get("running"):
            return last
        time.sleep(0.05)
    raise SmokeError(f"still running after {timeout_s}s ({label}): {last}")


def wait_until_training(
    inbox: Inbox,
    proc: subprocess.Popen,
    label: str,
    *,
    timeout_s: float = 5.0,
) -> dict:
    """Wait until train is live with progress so job-scoped Stop can match."""
    deadline = time.monotonic() + timeout_s
    n = 0
    while time.monotonic() < deadline:
        n += 1
        rid = f"wait-train-{label}-{n}"
        write_req(proc, "status", None, rid)
        env = inbox.take(rid, timeout_s=5.0)
        require(env.get("ok"), f"status failed ({label}): {env}")
        st = body_dict(env)
        rev = int(st.get("policy_revision") or 0)
        iters = int(st.get("iterations") or 0)
        if st.get("phase") == "training" and (rev > 0 or iters > 0):
            return st
        if st.get("running") is False and st.get("phase") != "paused":
            raise SmokeError(f"{label}: left running before phase=training: {st}")
        time.sleep(0.001)
    raise SmokeError(f"{label}: phase never became training with progress")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", nargs="?", default=str(DEFAULT_BINARY))
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--overall-timeout", type=float, default=90.0)
    args = parser.parse_args()

    binary = Path(args.binary)
    config_path = Path(args.config)
    require(binary.is_file(), f"missing binary: {binary}")
    require(config_path.is_file(), f"missing config: {config_path}")
    config_text = config_path.read_text()

    stages: dict[str, Any] = {}
    t0 = time.monotonic()
    timer = threading.Timer(args.overall_timeout, lambda: os._exit(2))
    timer.daemon = True
    timer.start()

    proc = subprocess.Popen(
        [str(binary), "--launch-id", "zr151-smoke"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )
    inbox = Inbox(proc)
    try:
        write_req(proc, "ready", None, "ready-1")
        ready = inbox.take("ready-1", timeout_s=10.0)
        require(ready.get("ok"), f"ready failed: {ready}")

        # --- publish a small solution ---
        write_req(proc, "begin_config", {"config_text": config_text}, "begin-1")
        begin = inbox.take("begin-1", timeout_s=30.0)
        require(begin.get("ok"), f"begin failed: {begin}")

        write_req(
            proc,
            "solve",
            {"iterations": 8},
            "solve-1",
            job_id="j-zr151-train",
        )
        admit = inbox.take("solve-1", timeout_s=10.0)
        require(admit.get("ok"), f"solve admit failed: {admit}")
        status_done = wait_until_idle(inbox, proc, "after-train")
        require(
            int(status_done.get("policy_revision") or 0) >= 1,
            f"expected published policy: {status_done}",
        )
        stages["published"] = {
            "policy_revision": status_done.get("policy_revision"),
            "iterations": status_done.get("iterations"),
        }

        # --- long train + overlapping values; Stop/status must reply fast ---
        # #373: cancel must match the live active_job_id. Tiny river ReleaseFast
        # can finish a few hundred iters before Stop lands — use a long job and
        # wait until training is observed (same pattern as study-contract-smoke).
        long_iters = 2_000_000
        write_req(
            proc,
            "solve",
            {"iterations": long_iters},
            "solve-long",
            job_id="j-zr151-long",
        )
        admit_long = inbox.take("solve-long", timeout_s=10.0)
        require(admit_long.get("ok"), f"long admit failed: {admit_long}")
        wait_until_training(inbox, proc, "long")

        write_req(proc, "values", {"node_index": 0}, "values-live")
        t_status = time.monotonic()
        write_req(proc, "status", None, "status-during-values")
        status_env = inbox.take("status-during-values", timeout_s=2.0)
        status_ms = (time.monotonic() - t_status) * 1000.0
        require(status_env.get("ok"), f"status during values failed: {status_env}")
        require(
            status_ms < 1500.0,
            f"status during values too slow: {status_ms:.1f}ms",
        )

        t_cancel = time.monotonic()
        write_req(proc, "cancel", None, "cancel-long", job_id="j-zr151-long")
        cancel_env = inbox.take("cancel-long", timeout_s=2.0)
        cancel_ms = (time.monotonic() - t_cancel) * 1000.0
        require(cancel_env.get("ok"), f"cancel during values failed: {cancel_env}")
        require(
            body_dict(cancel_env).get("cancelled") is True,
            f"cancel body: {cancel_env}",
        )
        require(
            cancel_ms < 1500.0,
            f"cancel during values too slow: {cancel_ms:.1f}ms",
        )

        status_stopped = wait_until_idle(inbox, proc, "after-cancel")
        require(
            status_stopped.get("terminal_reason") == "cancelled"
            or status_stopped.get("cancelled") is True
            or not status_stopped.get("running"),
            f"expected cancelled/idle after stop: {status_stopped}",
        )

        # values may complete ok, superseded, or fail — must not kill the session.
        values_env = inbox.take("values-live", timeout_s=60.0)
        stages["control_during_values"] = {
            "status_ms": round(status_ms, 2),
            "cancel_ms": round(cancel_ms, 2),
            "status_ok": bool(status_env.get("ok")),
            "cancel_ok": bool(cancel_env.get("ok")),
            "values_ok": bool(values_env.get("ok")),
            "values_error": values_env.get("error_code"),
            "terminal": status_stopped.get("terminal_reason"),
        }

        # Fresh solve after Stop proves slow EV did not tear down training capability.
        write_req(
            proc,
            "solve",
            {"iterations": 2},
            "solve-fresh",
            job_id="j-zr151-fresh",
        )
        admit_fresh = inbox.take("solve-fresh", timeout_s=10.0)
        require(admit_fresh.get("ok"), f"fresh solve after values/cancel failed: {admit_fresh}")
        status_fresh = wait_until_idle(inbox, proc, "fresh")
        require(
            int(status_fresh.get("policy_revision") or 0) >= 1,
            f"fresh solve did not publish: {status_fresh}",
        )
        stages["fresh_after_slow_ev"] = {
            "terminal_reason": status_fresh.get("terminal_reason"),
            "policy_revision": status_fresh.get("policy_revision"),
        }

        # --- compile cancel: Stop before/during begin keeps prior solution ---
        # #373: begin must register the same job_id Stop will match.
        prior_id = status_fresh.get("solution_id")
        write_req(
            proc,
            "begin_config",
            {"config_text": config_text},
            "begin-cancel",
            job_id="j-zr151-begin",
        )
        # Immediately request stop so begin observes Cancelled at a stage boundary.
        write_req(proc, "cancel", None, "cancel-begin", job_id="j-zr151-begin")
        cancel_begin = inbox.take("cancel-begin", timeout_s=5.0)
        require(cancel_begin.get("ok"), f"cancel during begin failed: {cancel_begin}")
        cancel_begin_body = body_dict(cancel_begin)
        # Tiny fixtures may finish before Stop matches — not_running is ok then.
        begin_stop_latched = cancel_begin_body.get("cancelled") is True
        begin_cancel = inbox.take("begin-cancel", timeout_s=30.0)
        # begin may finish before cancel lands on tiny fixtures (ok), or return cancelled.
        begin_cancelled = (not begin_cancel.get("ok")) and begin_cancel.get(
            "error_code"
        ) == "cancelled"
        status_after_begin = wait_until_idle(inbox, proc, "after-begin-cancel")
        if begin_cancelled:
            require(
                status_after_begin.get("solution_id") == prior_id,
                f"cancelled begin wiped prior solution: {status_after_begin}",
            )
            require(
                begin_stop_latched,
                f"compile cancel should match live begin job: {cancel_begin}",
            )
        stages["compile_cancel"] = {
            "begin_cancelled": begin_cancelled,
            "begin_stop_latched": begin_stop_latched,
            "begin_ok": bool(begin_cancel.get("ok")),
            "error_code": begin_cancel.get("error_code"),
            "solution_id": status_after_begin.get("solution_id"),
            "prior_solution_id": prior_id,
            "cancel_body": body_dict(cancel_begin),
        }

        # Coalesce needs a published policy. A completed begin installs paused /
        # unpublished — re-publish with a tiny solve before overlapping values.
        if int(status_after_begin.get("policy_revision") or 0) < 1:
            write_req(
                proc,
                "solve",
                {"iterations": 2},
                "solve-for-coalesce",
                job_id="j-zr151-coalesce",
            )
            admit_c = inbox.take("solve-for-coalesce", timeout_s=10.0)
            require(admit_c.get("ok"), f"coalesce setup solve failed: {admit_c}")
            status_after_begin = wait_until_idle(inbox, proc, "coalesce-setup")
            require(
                int(status_after_begin.get("policy_revision") or 0) >= 1,
                f"coalesce setup did not publish: {status_after_begin}",
            )

        # Coalesce: two rapid values — later request should win; older may supersede.
        write_req(proc, "values", {"node_index": 0}, "values-old")
        write_req(proc, "values", {"node_index": 0}, "values-new")
        old_env = inbox.take("values-old", timeout_s=60.0)
        new_env = inbox.take("values-new", timeout_s=60.0)
        # Latest must succeed; older may be ok or superseded (coalesce).
        require(new_env.get("ok"), f"latest values failed: {new_env}")
        old_ok = bool(old_env.get("ok"))
        old_superseded = old_env.get("error_code") == "superseded"
        require(
            old_ok or old_superseded,
            f"older values neither ok nor superseded: {old_env}",
        )
        stages["coalesce"] = {
            "old_ok": old_ok,
            "old_superseded": old_superseded,
            "old_error": old_env.get("error_code"),
            "new_ok": bool(new_env.get("ok")),
        }

        wall_s = time.monotonic() - t0
        result = {
            "ok": True,
            "fixture": str(config_path),
            "binary": str(binary),
            "wall_s": round(wall_s, 4),
            "stages": stages,
        }
        print(json.dumps(result, separators=(",", ":")))
        return 0
    finally:
        timer.cancel()
        try:
            if proc.stdin:
                proc.stdin.close()
        except Exception:
            pass
        proc.kill()
        try:
            proc.wait(timeout=5)
        except Exception:
            pass


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SmokeError as err:
        print(json.dumps({"ok": False, "error": str(err)}), file=sys.stderr)
        raise SystemExit(1)

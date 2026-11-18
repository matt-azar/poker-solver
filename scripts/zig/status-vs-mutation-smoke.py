#!/usr/bin/env python3
"""Status availability under locked re-solve / Compare / bulk analysis (audit Track 2/4).

Real-sidecar Linux smoke. Queues Status while:
  1. resolve_locked preparation + admit is in flight
  2. dual-session Compare is packing
  3. a bulk `values` reply is computing / writing

Pass bar (product path, not a synthetic bench):
  - Status completes with bounded latency (< STATUS_BOUND_MS) in each case
  - Status RTT stays near the idle baseline (not inflated to the heavy-op
    duration), proving it is not blocked behind the mutation/analysis reply
  - When the heavy op is still pending at Status completion, that is recorded
    as stronger evidence (tiny river fixtures may finish Compare/values first)

Uses river_gate_smoke. No Accuracy walls. Default overall wall 90s.
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "benchmarks/study/configs/river_gate_smoke.txt"
DEFAULT_BINARY = ROOT / "zig-out/bin/solver-engine"
if os.name == "nt" and not DEFAULT_BINARY.is_file():
    DEFAULT_BINARY = ROOT / "zig-out/bin/solver-engine.exe"

# Same control bound as ZR-151 stop-close smoke; product Status must stay usable.
STATUS_BOUND_MS = 1500.0
# Status under mutation load must stay near idle RTT (not the heavy-op duration).
STATUS_NEAR_IDLE_FACTOR = 50.0
STATUS_NEAR_IDLE_FLOOR_MS = 100.0


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
        self._raw_bytes: dict[str, int] = {}
        assert proc.stdout is not None
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        try:
            while True:
                assert self._proc.stdout is not None
                hdr = self._proc.stdout.read(4)
                if not hdr or len(hdr) < 4:
                    raise SmokeError("solver-engine pipe closed (no length prefix)")
                (n,) = struct.unpack("<I", hdr)
                if n == 0 or n > 16 * 1024 * 1024:
                    raise SmokeError(f"invalid frame length {n}")
                payload = self._proc.stdout.read(n)
                if not payload or len(payload) < n:
                    raise SmokeError("solver-engine pipe closed (truncated payload)")
                env = json.loads(payload)
                if env.get("kind") == "progress":
                    continue
                rid = env.get("request_id")
                if not isinstance(rid, str):
                    continue
                with self._cv:
                    self._by_id[rid] = env
                    self._raw_bytes[rid] = n
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

    def payload_bytes(self, request_id: str) -> int:
        with self._cv:
            return int(self._raw_bytes.get(request_id, 0))

    def has(self, request_id: str) -> bool:
        with self._cv:
            return request_id in self._by_id


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
    return {}


def require(cond: bool, msg: str) -> None:
    if not cond:
        raise SmokeError(msg)


def require_status_near_idle(status_ms: float, idle_ms: float, label: str) -> None:
    ceiling = max(STATUS_NEAR_IDLE_FLOOR_MS, idle_ms * STATUS_NEAR_IDLE_FACTOR)
    require(
        status_ms < STATUS_BOUND_MS,
        f"{label}: status too slow vs hard bound: {status_ms:.1f}ms",
    )
    require(
        status_ms <= ceiling,
        f"{label}: status {status_ms:.1f}ms exceeds near-idle ceiling {ceiling:.1f}ms "
        f"(idle={idle_ms:.1f}ms) — likely blocked behind mutation/analysis reply",
    )


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
    timer = threading.Timer(args.overall_timeout, lambda: os._exit(2))
    timer.daemon = True
    timer.start()

    proc = subprocess.Popen(
        [str(binary), "--launch-id", "status-vs-mutation"],
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

        write_req(proc, "begin_config", {"config_text": config_text}, "begin-1")
        begin = inbox.take("begin-1", timeout_s=30.0)
        require(begin.get("ok"), f"begin failed: {begin}")
        # begin_running clears in the worker defer after the admit reply — wait
        # until Status shows idle before train admission (same race as Study).
        wait_until_idle(inbox, proc, "after-begin", timeout_s=10.0)

        write_req(
            proc,
            "solve",
            {"iterations": 8},
            "solve-1",
            job_id="j-svm-train",
        )
        admit = inbox.take("solve-1", timeout_s=10.0)
        require(admit.get("ok"), f"solve admit failed: {admit}")
        status_done = wait_until_idle(inbox, proc, "after-train")
        require(
            int(status_done.get("policy_revision") or 0) >= 1,
            f"expected published policy: {status_done}",
        )
        baseline_id = status_done.get("solution_id")
        root_id = status_done.get("root_node_id") or "p0.t-1.r-1"
        require(isinstance(baseline_id, str) and baseline_id.startswith("s"), f"solution_id: {baseline_id}")

        # Idle Status baseline RTT (no mutation in flight).
        t_idle = time.monotonic()
        write_req(proc, "status", None, "status-idle")
        idle_env = inbox.take("status-idle", timeout_s=2.0)
        idle_ms = (time.monotonic() - t_idle) * 1000.0
        require(idle_env.get("ok"), f"idle status failed: {idle_env}")
        stages["idle_status_ms"] = round(idle_ms, 3)

        # Lock root for resolve_locked (force first action).
        write_req(proc, "node", {"node_id": root_id}, "node-root")
        node_env = inbox.take("node-root", timeout_s=10.0)
        require(node_env.get("ok"), f"node failed: {node_env}")
        actions = body_dict(node_env).get("actions") or []
        require(len(actions) >= 1, f"root has no actions: {node_env}")
        probs = [0.0] * len(actions)
        probs[0] = 1.0
        write_req(
            proc,
            "put_lock",
            {
                "node_id": root_id,
                "kind": "full",
                "scope": "node",
                "probs": probs,
            },
            "put-lock-1",
        )
        put = inbox.take("put-lock-1", timeout_s=10.0)
        require(put.get("ok"), f"put_lock failed: {put}")

        # --- 1) Status during resolve_locked prepare + admit ---
        write_req(
            proc,
            "resolve_locked",
            {"iterations": 4, "warm_start": 0},
            "resolve-1",
            job_id="j-svm-resolve",
        )
        t_status_rl = time.monotonic()
        write_req(proc, "status", None, "status-during-resolve")
        status_rl_env = inbox.take("status-during-resolve", timeout_s=2.0)
        status_rl_ms = (time.monotonic() - t_status_rl) * 1000.0
        require(status_rl_env.get("ok"), f"status during resolve failed: {status_rl_env}")
        require_status_near_idle(status_rl_ms, idle_ms, "resolve_locked")
        resolve_still_pending = not inbox.has("resolve-1")
        resolve_admit = inbox.take("resolve-1", timeout_s=30.0)
        require(resolve_admit.get("ok"), f"resolve_locked admit failed: {resolve_admit}")
        status_after_resolve = wait_until_idle(inbox, proc, "after-resolve")
        scenario_id = status_after_resolve.get("solution_id")
        require(
            isinstance(scenario_id, str) and scenario_id != baseline_id,
            f"expected new scenario id after resolve: {scenario_id} vs {baseline_id}",
        )
        stages["resolve_locked"] = {
            "status_ms": round(status_rl_ms, 3),
            "status_before_admit": resolve_still_pending,
            "baseline_solution_id": baseline_id,
            "scenario_solution_id": scenario_id,
            "status_bound_ms": STATUS_BOUND_MS,
        }

        # --- 2) Status during Compare ---
        write_req(
            proc,
            "compare",
            {
                "baseline": baseline_id,
                "scenario": scenario_id,
                "node_id": root_id,
            },
            "compare-1",
        )
        t_status_cmp = time.monotonic()
        write_req(proc, "status", None, "status-during-compare")
        status_cmp_env = inbox.take("status-during-compare", timeout_s=2.0)
        status_cmp_ms = (time.monotonic() - t_status_cmp) * 1000.0
        require(status_cmp_env.get("ok"), f"status during compare failed: {status_cmp_env}")
        require_status_near_idle(status_cmp_ms, idle_ms, "compare")
        compare_still_pending = not inbox.has("compare-1")
        compare_env = inbox.take("compare-1", timeout_s=30.0)
        require(compare_env.get("ok"), f"compare failed: {compare_env}")
        compare_bytes = inbox.payload_bytes("compare-1")
        stages["compare"] = {
            "status_ms": round(status_cmp_ms, 3),
            "status_before_compare_reply": compare_still_pending,
            "compare_reply_bytes": compare_bytes,
            "status_bound_ms": STATUS_BOUND_MS,
        }

        # --- 3) Status during bulk values ---
        write_req(proc, "values", {"node_id": root_id}, "values-1")
        t_status_val = time.monotonic()
        write_req(proc, "status", None, "status-during-values")
        status_val_env = inbox.take("status-during-values", timeout_s=2.0)
        status_val_ms = (time.monotonic() - t_status_val) * 1000.0
        require(status_val_env.get("ok"), f"status during values failed: {status_val_env}")
        require_status_near_idle(status_val_ms, idle_ms, "bulk_values")
        values_still_pending = not inbox.has("values-1")
        values_env = inbox.take("values-1", timeout_s=60.0)
        require(values_env.get("ok"), f"values failed: {values_env}")
        values_bytes = inbox.payload_bytes("values-1")
        stages["bulk_values"] = {
            "status_ms": round(status_val_ms, 3),
            "status_before_values_reply": values_still_pending,
            "values_reply_bytes": values_bytes,
            "status_bound_ms": STATUS_BOUND_MS,
        }

        print(json.dumps({"ok": True, "stages": stages}, indent=2, sort_keys=True))
        return 0
    except SmokeError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        print(json.dumps({"ok": False, "stages": stages, "error": str(exc)}, indent=2), file=sys.stderr)
        return 1
    finally:
        timer.cancel()
        try:
            if proc.stdin:
                proc.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())

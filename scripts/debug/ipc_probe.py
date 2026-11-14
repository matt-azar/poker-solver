#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Probe solver-engine typed IPC for demux / timeout / hang behavior.

Spawns a real sidecar (protocol 2 length-prefixed JSON) and checks:
  1) ready handshake
  2) concurrent request_id demux (two overlapping ops)
  3) status reply within the short Study-like budget
  4) that a timed-out waiter does not imply the process died

This is an *external* observation harness — it does not touch Tauri or HTTP.
Requires a built zig-out/bin/solver-engine (or --binary).

Examples:
  python3 scripts/debug/ipc_probe.py
  python3 scripts/debug/ipc_probe.py --binary ./zig-out/bin/solver-engine
"""

from __future__ import annotations

import argparse
import json
import struct
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import (  # noqa: E402
    IPC_TIMEOUTS_SEC,
    STATUS_POLL_TIMEOUT_MS,
    STATUS_RPC_TIMEOUT_S,
    default_solver_engine,
    eprint,
    utc_now_iso,
    write_json,
)


class ProbeError(RuntimeError):
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
        raise ProbeError("pipe closed (no length prefix)")
    (n,) = struct.unpack("<I", hdr)
    if n == 0 or n > 16 * 1024 * 1024:
        raise ProbeError(f"invalid frame length {n}")
    payload = stdout.read(n)
    if not payload or len(payload) < n:
        raise ProbeError("pipe closed (truncated payload)")
    return json.loads(payload)


class Inbox:
    def __init__(self, proc: subprocess.Popen) -> None:
        self._proc = proc
        self._by_id: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        self._error: Exception | None = None
        self.frames: list[dict] = []
        assert proc.stdout is not None
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        try:
            while True:
                env = read_frame(self._proc.stdout)
                with self._cv:
                    self.frames.append(env)
                    rid = env.get("request_id")
                    if env.get("kind") == "reply" and isinstance(rid, str):
                        self._by_id[rid] = env
                        self._cv.notify_all()
                    elif env.get("kind") == "progress":
                        pass
                    else:
                        # Unexpected kinds still recorded.
                        self._cv.notify_all()
        except Exception as exc:  # noqa: BLE001 — surface to waiters
            with self._cv:
                self._error = exc
                self._cv.notify_all()

    def wait(self, request_id: str, timeout: float) -> dict:
        deadline = time.monotonic() + timeout
        with self._cv:
            while request_id not in self._by_id:
                if self._error is not None:
                    raise ProbeError(f"reader died: {self._error}")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ProbeError(
                        f"IPC read timed out waiting for request_id={request_id}"
                    )
                self._cv.wait(timeout=remaining)
            return self._by_id[request_id]


def write_req(
    proc: subprocess.Popen, op: str, body: Any, request_id: str, job_id=None
) -> None:
    assert proc.stdin is not None
    proc.stdin.write(encode(op, body, request_id, job_id))
    proc.stdin.flush()


def spawn(binary: Path) -> subprocess.Popen:
    return subprocess.Popen(
        [str(binary)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )


def drain_stderr(proc: subprocess.Popen, sink: list[str]) -> threading.Thread:
    def _run() -> None:
        assert proc.stderr is not None
        for line in iter(proc.stderr.readline, b""):
            sink.append(line.decode("utf-8", errors="replace").rstrip())

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t


def run_probe(binary: Path, status_budget_sec: float) -> dict[str, Any]:
    results: dict[str, Any] = {
        "kind": "ipc-probe",
        "timestamp": utc_now_iso(),
        "binary": str(binary),
        "timeoutsSec": IPC_TIMEOUTS_SEC,
        "statusBudgetSec": status_budget_sec,
        "checks": {},
        "ok": True,
    }
    stderr_lines: list[str] = []
    proc = spawn(binary)
    drain_stderr(proc, stderr_lines)
    inbox = Inbox(proc)
    try:
        # 1) ready
        rid = f"ready-{uuid.uuid4().hex[:8]}"
        t0 = time.monotonic()
        write_req(proc, "ready", None, rid)
        env = inbox.wait(rid, timeout=IPC_TIMEOUTS_SEC["ready"])
        results["checks"]["ready"] = {
            "ok": bool(env.get("ok", False)),
            "ms": round((time.monotonic() - t0) * 1000, 1),
            "protocol": (env.get("body") or {}).get("protocol")
            if isinstance(env.get("body"), dict)
            else env.get("protocol"),
        }
        if not env.get("ok", False):
            results["ok"] = False

        # 2) demux: fire two status ops without waiting between writes
        rid_a = f"st-a-{uuid.uuid4().hex[:8]}"
        rid_b = f"st-b-{uuid.uuid4().hex[:8]}"
        t0 = time.monotonic()
        write_req(proc, "status", None, rid_a)
        write_req(proc, "status", None, rid_b)
        env_a = inbox.wait(rid_a, timeout=status_budget_sec)
        env_b = inbox.wait(rid_b, timeout=status_budget_sec)
        demux_ok = (
            env_a.get("request_id") == rid_a
            and env_b.get("request_id") == rid_b
            and env_a.get("kind") == "reply"
            and env_b.get("kind") == "reply"
        )
        results["checks"]["demux"] = {
            "ok": demux_ok,
            "ms": round((time.monotonic() - t0) * 1000, 1),
            "a_ok": bool(env_a.get("ok", False)),
            "b_ok": bool(env_b.get("ok", False)),
        }
        if not demux_ok:
            results["ok"] = False

        # 3) status within Study-like short budget
        rid_s = f"st-budget-{uuid.uuid4().hex[:8]}"
        t0 = time.monotonic()
        write_req(proc, "status", None, rid_s)
        env_s = inbox.wait(rid_s, timeout=status_budget_sec)
        elapsed = time.monotonic() - t0
        results["checks"]["status_budget"] = {
            "ok": elapsed <= status_budget_sec and env_s.get("kind") == "reply",
            "ms": round(elapsed * 1000, 1),
            "budgetMs": int(status_budget_sec * 1000),
            "note": (
                "Study JS aborts status at 8s idle / 15s active; Rust "
                "STATUS_RPC_TIMEOUT is 20s. Soft timeouts during build/train "
                "must not hung-kill a hot sidecar."
            ),
        }
        if not results["checks"]["status_budget"]["ok"]:
            results["ok"] = False

        # 4) process still alive after waits
        alive = proc.poll() is None
        results["checks"]["alive_after"] = {
            "ok": alive,
            "returncode": proc.poll(),
            "note": (
                "A single RPC timeout must not kill train/session "
                "(AGENT_LESSONS / ZR-151). This probe never kills on timeout."
            ),
        }
        if not alive:
            results["ok"] = False
    except ProbeError as exc:
        results["ok"] = False
        results["error"] = str(exc)
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
        results["stderrTail"] = stderr_lines[-30:]
    return results


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--binary",
        type=Path,
        default=None,
        help="solver-engine path (default: zig-out/bin/solver-engine)",
    )
    ap.add_argument(
        "--status-budget",
        type=float,
        default=max(STATUS_POLL_TIMEOUT_MS / 1000.0, STATUS_RPC_TIMEOUT_S),
        help="Seconds to wait for status (default max(idle JS, Rust STATUS_RPC))",
    )
    ap.add_argument("--out", type=Path)
    ap.add_argument("--json-only", action="store_true")
    args = ap.parse_args()

    binary = args.binary or default_solver_engine()
    if not binary.is_file():
        eprint(f"missing solver-engine: {binary}")
        eprint("Build with: zig build -Dcpu=x86_64_v2")
        return 2

    report = run_probe(binary, args.status_budget)
    if args.out:
        write_json(args.out, report)

    if args.json_only:
        json.dump(report, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print(f"binary: {report['binary']}")
        print(f"ok: {report['ok']}")
        for name, check in report.get("checks", {}).items():
            print(f"  {name}: {check}")
        if report.get("error"):
            print(f"error: {report['error']}")
        if args.out:
            print(f"wrote: {args.out}")

    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

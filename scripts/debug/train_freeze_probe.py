#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Detect train freezes: status/values must stay live during solve.

Mirrors the product invariant (AGENT_LESSONS / ZR-151 / async host cutover):
  - solve runs without monopolizing stdin forever after admit
  - status and values should reply while train is in flight
  - a slow values wait must not require killing the sidecar

Flow:
  ready → begin_config → async solve → interleaved status (+ optional values)
  Fail if status never replies within budget, or iterations never advance when
  the process is alive and CPU-hot expectation is train progress.

Examples:
  python3 scripts/debug/train_freeze_probe.py
  python3 scripts/debug/train_freeze_probe.py --config benchmarks/study/configs/river_gate_smoke.txt
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
from typing import Any, Optional

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import (  # noqa: E402
    ROOT,
    default_solver_engine,
    eprint,
    utc_now_iso,
    write_json,
)


class ProbeError(RuntimeError):
    pass


DEFAULT_CONFIG = ROOT / "benchmarks/study/configs/river_gate_smoke.txt"


def encode(op: str, body: Any, request_id: str, job_id: Optional[str] = None) -> bytes:
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
        self.progress: list[dict] = []
        assert proc.stdout is not None
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        try:
            while True:
                env = read_frame(self._proc.stdout)
                with self._cv:
                    if env.get("kind") == "progress":
                        self.progress.append(env)
                        self._cv.notify_all()
                        continue
                    rid = env.get("request_id")
                    if env.get("kind") == "reply" and isinstance(rid, str):
                        self._by_id[rid] = env
                        self._cv.notify_all()
        except Exception as exc:  # noqa: BLE001
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
                    raise ProbeError(f"timeout waiting for {request_id}")
                self._cv.wait(timeout=remaining)
            return self._by_id[request_id]


def write_req(proc, op, body, request_id, job_id=None) -> None:
    assert proc.stdin is not None
    proc.stdin.write(encode(op, body, request_id, job_id))
    proc.stdin.flush()


def _iters_from_status_body(body: Any) -> Optional[int]:
    if not isinstance(body, dict):
        return None
    for key in ("iterations", "iters", "iteration"):
        val = body.get(key)
        if isinstance(val, int):
            return val
        if isinstance(val, float):
            return int(val)
    # Nested status shapes
    for nest in ("solve", "train", "progress"):
        sub = body.get(nest)
        if isinstance(sub, dict):
            got = _iters_from_status_body(sub)
            if got is not None:
                return got
    return None


def run_probe(
    binary: Path,
    config_path: Path,
    solve_iters: int,
    status_budget: float,
    poll_count: int,
    poll_gap: float,
) -> dict[str, Any]:
    report: dict[str, Any] = {
        "kind": "train-freeze-probe",
        "timestamp": utc_now_iso(),
        "binary": str(binary),
        "config": str(config_path),
        "solveIters": solve_iters,
        "checks": {},
        "statusSamples": [],
        "ok": True,
    }
    config_text = config_path.read_text(encoding="utf-8")
    proc = subprocess.Popen(
        [str(binary)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )
    stderr: list[str] = []

    def _drain() -> None:
        assert proc.stderr is not None
        for line in iter(proc.stderr.readline, b""):
            stderr.append(line.decode("utf-8", errors="replace").rstrip())

    threading.Thread(target=_drain, daemon=True).start()
    inbox = Inbox(proc)
    job_id = f"job-{uuid.uuid4().hex[:8]}"

    try:
        rid = f"ready-{uuid.uuid4().hex[:8]}"
        write_req(proc, "ready", None, rid)
        ready = inbox.wait(rid, 8)
        report["checks"]["ready"] = {"ok": bool(ready.get("ok", False))}
        if not ready.get("ok", False):
            raise ProbeError(f"ready failed: {ready}")

        rid = f"cfg-{uuid.uuid4().hex[:8]}"
        write_req(proc, "begin_config", {"config_text": config_text}, rid)
        cfg = inbox.wait(rid, 120)
        report["checks"]["begin_config"] = {
            "ok": bool(cfg.get("ok", False)),
            "error": cfg.get("error_message"),
        }
        if not cfg.get("ok", False):
            raise ProbeError(f"begin_config failed: {cfg.get('error_message')}")

        # Fire solve (may admit quickly; completion later).
        rid_solve = f"solve-{uuid.uuid4().hex[:8]}"
        write_req(
            proc,
            "solve",
            {"iterations": solve_iters},
            rid_solve,
            job_id=job_id,
        )
        report["checks"]["solve_submitted"] = {"ok": True, "request_id": rid_solve}

        # Immediately poll status — must not hang for the whole train.
        status_ok = 0
        status_fail = 0
        iters_seen: list[int] = []
        for i in range(poll_count):
            rid_s = f"status-{i}-{uuid.uuid4().hex[:8]}"
            t0 = time.monotonic()
            try:
                write_req(proc, "status", None, rid_s)
                env = inbox.wait(rid_s, status_budget)
                ms = round((time.monotonic() - t0) * 1000, 1)
                body = env.get("body")
                it = _iters_from_status_body(body)
                sample = {
                    "i": i,
                    "ok": bool(env.get("ok", False)),
                    "ms": ms,
                    "iterations": it,
                    "timedOut": False,
                }
                if env.get("ok", False):
                    status_ok += 1
                else:
                    status_fail += 1
                if it is not None:
                    iters_seen.append(it)
            except ProbeError as exc:
                status_fail += 1
                sample = {
                    "i": i,
                    "ok": False,
                    "ms": round((time.monotonic() - t0) * 1000, 1),
                    "iterations": None,
                    "timedOut": "timeout" in str(exc).lower(),
                    "error": str(exc),
                }
            report["statusSamples"].append(sample)
            time.sleep(poll_gap)

        live_under_train = status_ok > 0 and status_fail == 0
        # Soft pass: majority status OK even if one blip.
        soft_ok = status_ok >= max(1, poll_count // 2)
        report["checks"]["status_live_under_train"] = {
            "ok": soft_ok,
            "strictAllOk": live_under_train,
            "statusOk": status_ok,
            "statusFail": status_fail,
            "note": (
                "If all status polls time out while solver-engine is alive, "
                "stdin may be blocked or demux stuck — classic train freeze."
            ),
        }
        if not soft_ok:
            report["ok"] = False

        progressed = len(iters_seen) >= 2 and max(iters_seen) > min(iters_seen)
        report["checks"]["iterations_progress"] = {
            "ok": progressed or status_ok == 0,
            "itersSeen": iters_seen,
            "note": (
                "When status works but iterations never move, host may be "
                "stuck in compile or not publishing progress (ZR-120)."
            ),
        }
        # Only fail progress check if we had live status but flat iters across polls.
        if status_ok >= 2 and iters_seen and not progressed:
            # River smoke with few iters can finish before second poll — tolerate.
            if max(iters_seen) == 0:
                report["checks"]["iterations_progress"]["ok"] = False
                report["ok"] = False

        # Optional: wait briefly for solve reply (admit or completion).
        try:
            solve_env = inbox.wait(rid_solve, timeout=30)
            report["checks"]["solve_reply"] = {
                "ok": True,
                "replyOk": bool(solve_env.get("ok", False)),
                "error": solve_env.get("error_message"),
            }
        except ProbeError:
            report["checks"]["solve_reply"] = {
                "ok": True,
                "pending": True,
                "note": "solve still in flight after polls — acceptable if status lived",
            }

        report["checks"]["process_alive"] = {"ok": proc.poll() is None}
        if proc.poll() is not None:
            report["ok"] = False
    except ProbeError as exc:
        report["ok"] = False
        report["error"] = str(exc)
    finally:
        if proc.poll() is None:
            try:
                write_req(proc, "cancel", None, f"cancel-{uuid.uuid4().hex[:8]}", job_id)
            except Exception:  # noqa: BLE001
                pass
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        report["stderrTail"] = stderr[-40:]
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--binary", type=Path, default=None)
    ap.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    ap.add_argument("--iters", type=int, default=50)
    ap.add_argument("--status-budget", type=float, default=8.0)
    ap.add_argument("--polls", type=int, default=5)
    ap.add_argument("--poll-gap", type=float, default=0.4)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--json-only", action="store_true")
    args = ap.parse_args()

    binary = args.binary or default_solver_engine()
    if not binary.is_file():
        eprint(f"missing solver-engine: {binary}")
        return 2
    if not args.config.is_file():
        eprint(f"missing config: {args.config}")
        return 2

    report = run_probe(
        binary,
        args.config,
        args.iters,
        args.status_budget,
        args.polls,
        args.poll_gap,
    )
    if args.out:
        write_json(args.out, report)

    if args.json_only:
        json.dump(report, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print(f"ok: {report['ok']}")
        for k, v in report.get("checks", {}).items():
            print(f"  {k}: {v}")
        if report.get("error"):
            print(f"error: {report['error']}")
        if args.out:
            print(f"wrote: {args.out}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

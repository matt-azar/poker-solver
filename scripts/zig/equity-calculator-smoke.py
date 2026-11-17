#!/usr/bin/env python3
"""Smoke host IPC Equity Calculator jobs (ZR-84 / product path).

start_equity_job → poll get_equity_job → completed result.
Distinct from Study node `equity` (scripts/zig/equity-smoke.py).
"""
from __future__ import annotations

import json
import struct
import subprocess
import sys
import time
from pathlib import Path


def encode(op: str, body, request_id: str, job_id=None) -> bytes:
    payload = json.dumps(
        {
            "v": 2,
            "kind": "request",
            "request_id": request_id,
            "job_id": job_id,
            "op": op,
            "body": body,
        },
        separators=(",", ":"),
    ).encode()
    return struct.pack("<I", len(payload)) + payload


def read_frame(stdout) -> dict:
    hdr = stdout.read(4)
    if not hdr or len(hdr) < 4:
        raise RuntimeError("solver-engine pipe closed (no length prefix)")
    (n,) = struct.unpack("<I", hdr)
    payload = stdout.read(n)
    if not payload or len(payload) < n:
        raise RuntimeError("solver-engine pipe closed (truncated payload)")
    env = json.loads(payload)
    if env.get("kind") == "progress":
        return read_frame(stdout)
    if env.get("kind") != "reply":
        raise RuntimeError(f"unexpected kind: {env!r}")
    if not env.get("ok", False):
        raise RuntimeError(
            f"{env.get('error_code')}: {env.get('error_message')} ({env.get('op')})"
        )
    return env


def rpc(proc: subprocess.Popen, op: str, body, request_id: str, job_id=None) -> dict:
    assert proc.stdin is not None and proc.stdout is not None
    proc.stdin.write(encode(op, body, request_id, job_id))
    proc.stdin.flush()
    return read_frame(proc.stdout)


def wait_job(proc: subprocess.Popen, job_id: str, prefix: str, attempts: int = 400) -> dict:
    for i in range(attempts):
        time.sleep(0.01)
        st = rpc(proc, "get_equity_job", {"job_id": job_id}, f"{prefix}{i}")
        body = st.get("body") or {}
        state = body.get("state")
        if state in ("completed", "stopped", "failed", "cancelled"):
            return body
    raise RuntimeError(f"equity job {job_id} did not finish")


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    binary = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "zig-out/bin/solver-engine"
    if not binary.is_file():
        print(f"BLOCKER: missing binary {binary}", file=sys.stderr)
        return 2

    proc = subprocess.Popen(
        [str(binary), "--launch-id", "equity-calculator-smoke"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        rpc(proc, "ready", None, "r0")

        # Exact river: AA vs KK on a board → AA wins 100%.
        start = rpc(
            proc,
            "start_equity_job",
            {
                "version": 1,
                "client_revision": "calc-smoke",
                "method": "exact",
                "target_samples": 1000,
                "seed": 1,
                "board": ["2c", "3d", "7h", "9s", "Jc"],
                "dead_cards": [],
                "players": [
                    {"id": "p1", "range": "AsAd"},
                    {"id": "p2", "range": "KcKd"},
                ],
            },
            "r1",
        )
        job_id = (start.get("body") or {}).get("job_id")
        if not job_id:
            raise RuntimeError(f"missing job_id: {start!r}")
        done = wait_job(proc, job_id, "g")
        if done.get("state") != "completed":
            raise RuntimeError(f"expected completed: {done!r}")
        result = done.get("result") or {}
        players = {p["id"]: p for p in (result.get("players") or [])}
        if abs(float(players["p1"]["equity"]) - 1.0) > 1e-9:
            raise RuntimeError(f"p1 equity expected 1: {players!r}")
        if abs(float(players["p2"]["equity"]) - 0.0) > 1e-9:
            raise RuntimeError(f"p2 equity expected 0: {players!r}")
        if result.get("model") != "check-down":
            raise RuntimeError(f"bad model: {result!r}")

        # Cancel a queued/running Monte Carlo job (no Study session).
        start_mc = rpc(
            proc,
            "start_equity_job",
            {
                "version": 1,
                "client_revision": "calc-smoke-mc",
                "method": "monte_carlo",
                "target_samples": 5_000_000,
                "max_attempts": 50_000_000,
                "seed": 1,
                "board": [],
                "dead_cards": [],
                "players": [
                    {"id": "p1", "range": "AA"},
                    {"id": "p2", "range": "KK"},
                ],
            },
            "r2",
        )
        job_mc = (start_mc.get("body") or {}).get("job_id")
        if not job_mc:
            raise RuntimeError(f"missing mc job_id: {start_mc!r}")
        cancel = rpc(proc, "cancel_equity_job", {"job_id": job_mc}, "r3")
        cancel_body = cancel.get("body") or {}
        if cancel_body.get("state") not in ("cancelled", "stopping", "stopped"):
            raise RuntimeError(f"cancel did not take: {cancel_body!r}")

        print(
            json.dumps(
                {
                    "ok": True,
                    "exact_job": job_id,
                    "p1_equity": players["p1"]["equity"],
                    "p2_equity": players["p2"]["equity"],
                    "cancelled_job": job_mc,
                    "cancel_state": cancel_body.get("state"),
                },
                separators=(",", ":"),
            )
        )
        return 0
    finally:
        if proc.stdin:
            proc.stdin.close()
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Smoke host IPC `equity` on river_gate_smoke (ZR-65 Slice B).

begin_config → solve → equity; asserts Study-shaped body fields.
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


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    binary = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "zig-out/bin/solver-engine"
    config = root / "benchmarks/study/configs/river_gate_smoke.txt"
    if not binary.is_file():
        print(f"BLOCKER: missing binary {binary}", file=sys.stderr)
        return 2
    config_text = config.read_text(encoding="utf-8")
    if not config_text.endswith("\n"):
        config_text += "\n"

    proc = subprocess.Popen(
        [str(binary), "--launch-id", "equity-smoke"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        rpc(proc, "ready", None, "r0")
        rpc(proc, "begin_config", {"config_text": config_text}, "r1")
        t0 = time.perf_counter()
        solve = rpc(proc, "solve", {"iterations": 2}, "r2", job_id="j-eq")
        train_s = time.perf_counter() - t0
        t1 = time.perf_counter()
        eq = rpc(proc, "equity", {"node_id": "p0.t-1.r-1"}, "r3")
        equity_s = time.perf_counter() - t1
        body = eq.get("body") or {}
        required = [
            "kind",
            "model",
            "units",
            "defined",
            "oop_equity",
            "ip_equity",
            "equity_distribution",
            "ip_equity_distribution",
            "oop_hands",
            "ip_hands",
            "engine",
        ]
        missing = [k for k in required if k not in body]
        if missing:
            raise RuntimeError(f"missing fields: {missing}; body={body!r}")
        if body.get("kind") != "equity" or body.get("model") != "check-down":
            raise RuntimeError(f"bad kind/model: {body!r}")
        if body.get("defined") is not True:
            raise RuntimeError(f"expected defined equity: {body!r}")
        if len(body.get("equity_distribution") or []) != 10:
            raise RuntimeError("expected 10 OOP buckets")
        if len(body.get("ip_equity_distribution") or []) != 10:
            raise RuntimeError("expected 10 IP buckets")
        if not body.get("oop_hands") or not body.get("ip_hands"):
            raise RuntimeError("expected compact hand rows")
        oop = float(body["oop_equity"])
        ip = float(body["ip_equity"])
        if abs(oop + ip - 1.0) > 1e-6:
            raise RuntimeError(f"oop+ip equity not ~1: {oop}+{ip}")
        print(
            json.dumps(
                {
                    "ok": True,
                    "fixture": str(config),
                    "train_s": round(train_s, 4),
                    "equity_s": round(equity_s, 4),
                    "solve": solve.get("body"),
                    "oop_equity": oop,
                    "ip_equity": ip,
                    "oop_hands": len(body["oop_hands"]),
                    "ip_hands": len(body["ip_hands"]),
                    "engine": body.get("engine"),
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

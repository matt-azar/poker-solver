#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Controllable protocol-2 sidecar for async IPC acceptance tests.

Speaks the same length-prefixed JSON frames as solver-engine, but:
  - Answers ready / status / cancel immediately.
  - Withholds the first values (and equity) reply forever while continuing to
    read stdin and serve other ops.

Used by:
  - Rust connection-supervisor concurrency tests (spawn this script)
  - Packaged Windows WebView → Tauri → pipe acceptance
    (STUDY_SOLVER_ENGINE pointing at a small wrapper exe, or python launcher)
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from typing import Any


def read_frame(stdin) -> dict[str, Any]:
    hdr = stdin.buffer.read(4)
    if not hdr or len(hdr) < 4:
        raise EOFError("stdin closed")
    (n,) = struct.unpack("<I", hdr)
    if n == 0 or n > 16 * 1024 * 1024:
        raise ValueError(f"bad frame length {n}")
    payload = stdin.buffer.read(n)
    if not payload or len(payload) < n:
        raise EOFError("stdin closed mid-frame")
    return json.loads(payload)


def write_frame(stdout, envelope: dict[str, Any]) -> None:
    payload = json.dumps(envelope, separators=(",", ":")).encode()
    stdout.buffer.write(struct.pack("<I", len(payload)))
    stdout.buffer.write(payload)
    stdout.buffer.flush()


def reply_ok(request_id: str, op: str, job_id: str | None, body: Any) -> dict[str, Any]:
    return {
        "v": 2,
        "kind": "reply",
        "request_id": request_id,
        "job_id": job_id,
        "op": op,
        "ok": True,
        "body": body,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="IPC test sidecar (protocol 2)")
    parser.add_argument("--launch-id", default="local")
    args = parser.parse_args()
    launch_id = args.launch_id
    withheld_values = False

    # Line-buffer stderr so Tauri drain sees withhold notices promptly.
    try:
        sys.stderr.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
    except Exception:
        pass

    while True:
        try:
            req = read_frame(sys.stdin)
        except EOFError:
            break
        if req.get("kind") != "request":
            continue
        op = str(req.get("op") or "")
        request_id = str(req.get("request_id") or "")
        job_id = req.get("job_id")
        if isinstance(job_id, str) and not job_id:
            job_id = None

        if op == "ready":
            body: Any = {
                "protocol": 2,
                "sidecar": "ipc-test-sidecar",
                "launch_id": launch_id,
                "workers": 1,
            }
        elif op == "status":
            body = {
                "phase": "idle",
                "solving": False,
                "iterations": 0,
                "iterations_requested": 0,
                "solution_id": 1,
                "held_values": withheld_values,
            }
        elif op == "cancel":
            body = {"cancelled": True, "reason": "test-sidecar-ack"}
        elif op == "pause":
            body = {"paused": True}
        elif op in ("values", "equity"):
            if not withheld_values:
                withheld_values = True
                print(
                    f"ipc-test-sidecar: withholding {op} reply for {request_id} (still reading)",
                    file=sys.stderr,
                )
                continue
            body = {"ok": True, "actions": [], "note": "late-or-second-values"}
        else:
            body = {"echo_op": op}

        write_frame(sys.stdout, reply_ok(request_id, op, job_id, body))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

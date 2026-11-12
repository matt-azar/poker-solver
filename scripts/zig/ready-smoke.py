#!/usr/bin/env python3
"""Length-prefixed protocol-2 ready smoke against solver-engine."""
from __future__ import annotations

import argparse
import json
import struct
import subprocess
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "binary",
        nargs="?",
        default="./zig-out/bin/solver-engine",
        help="Path to solver-engine (or .exe)",
    )
    args = ap.parse_args()

    payload = json.dumps(
        {
            "v": 2,
            "kind": "request",
            "request_id": "smoke",
            "job_id": None,
            "op": "ready",
            "body": None,
        },
        separators=(",", ":"),
    ).encode()
    frame = struct.pack("<I", len(payload)) + payload

    proc = subprocess.run(
        [args.binary],
        input=frame,
        capture_output=True,
        timeout=30,
        check=False,
    )
    if len(proc.stdout) < 4:
        sys.stderr.write(proc.stderr.decode(errors="replace"))
        print("ready-smoke: no framed reply", file=sys.stderr)
        return 1
    (n,) = struct.unpack("<I", proc.stdout[:4])
    body = proc.stdout[4 : 4 + n]
    try:
        env = json.loads(body)
    except json.JSONDecodeError as exc:
        print(f"ready-smoke: bad JSON: {exc}", file=sys.stderr)
        return 1
    if env.get("kind") != "reply" or env.get("op") != "ready" or not env.get("ok"):
        print(f"ready-smoke: unexpected envelope: {env}", file=sys.stderr)
        return 1
    reply_body = env.get("body") or {}
    if reply_body.get("protocol") != 2 or reply_body.get("sidecar") != "solver-engine":
        print(f"ready-smoke: unexpected body: {reply_body}", file=sys.stderr)
        return 1
    print("ready-smoke ok:", json.dumps(reply_body, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

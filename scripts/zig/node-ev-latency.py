#!/usr/bin/env python3
"""Measure solver-engine node-EV IPC latency on a locked fixture (D12).

Uses one long-lived `solver-engine` process (stdin/stdout frames). Train and
values each have wall budgets — prefer short iteration counts for agent digs.

Example:
  ./scripts/zig/node-ev-latency.py \\
      --binary ./zig-out/bin/solver-engine \\
      --config benchmarks/study/configs/flop_srp_one_size.txt \\
      --iterations 1 --train-timeout 180 --values-timeout 60
"""
from __future__ import annotations

import argparse
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
    if n == 0 or n > 16 * 1024 * 1024:
        raise RuntimeError(f"invalid frame length {n}")
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
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--binary", type=Path, default=Path("./zig-out/bin/solver-engine"))
    ap.add_argument(
        "--config",
        type=Path,
        default=Path("benchmarks/study/configs/flop_srp_one_size.txt"),
    )
    ap.add_argument("--iterations", type=int, default=1)
    ap.add_argument("--node-index", type=int, default=0)
    ap.add_argument("--train-timeout", type=float, default=180.0)
    ap.add_argument("--values-timeout", type=float, default=60.0)
    args = ap.parse_args()

    if not args.binary.is_file():
        print(f"BLOCKER: missing binary {args.binary}", file=sys.stderr)
        return 2
    if not args.config.is_file():
        print(f"BLOCKER: missing config {args.config}", file=sys.stderr)
        return 2

    config_text = args.config.read_text(encoding="utf-8")
    if not config_text.endswith("\n"):
        config_text += "\n"

    print(
        json.dumps(
            {
                "fixture": str(args.config),
                "binary": str(args.binary),
                "iterations": args.iterations,
                "train_timeout_s": args.train_timeout,
                "values_timeout_s": args.values_timeout,
            },
            separators=(",", ":"),
        )
    )

    # Hard wall for the whole dig (train + values). Prefs: no absurd hangs.
    overall_timeout = args.train_timeout + args.values_timeout + 5.0
    proc = subprocess.Popen(
        [str(args.binary), "--launch-id", "latency-dig"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        import threading

        timed_out = {"hit": False}

        def _kill_on_wall() -> None:
            timed_out["hit"] = True
            try:
                proc.kill()
            except OSError:
                pass

        timer = threading.Timer(overall_timeout, _kill_on_wall)
        timer.daemon = True
        timer.start()
        try:
            rpc(proc, "ready", None, "lat-ready")

            t_train = time.perf_counter()
            try:
                rpc(proc, "begin_config", {"config_text": config_text}, "lat-begin")
                solve_env = rpc(
                    proc,
                    "solve",
                    {"iterations": args.iterations},
                    "lat-solve",
                    job_id="j-latency",
                )
            except Exception as exc:  # noqa: BLE001
                if timed_out["hit"]:
                    print(
                        f"BLOCKER: train/compile exceeded {args.train_timeout}s "
                        f"overall wall on {args.config.name}",
                        file=sys.stderr,
                    )
                    return 3
                print(f"BLOCKER: train/compile failed: {exc}", file=sys.stderr)
                err = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
                if err:
                    sys.stderr.write(err)
                return 3
            train_s = time.perf_counter() - t_train
            if train_s > args.train_timeout:
                print(
                    f"BLOCKER: train/compile took {train_s:.1f}s "
                    f"(budget {args.train_timeout}s) on {args.config.name}",
                    file=sys.stderr,
                )
                return 3
            print(
                json.dumps(
                    {
                        "stage": "train",
                        "wall_s": round(train_s, 3),
                        "body": solve_env.get("body"),
                    },
                    separators=(",", ":"),
                )
            )

            t_values = time.perf_counter()
            try:
                values_env = rpc(
                    proc,
                    "values",
                    {"node_index": args.node_index},
                    "lat-values",
                )
            except Exception as exc:  # noqa: BLE001
                if timed_out["hit"]:
                    print(
                        f"BLOCKER: values exceeded wall on {args.config.name}",
                        file=sys.stderr,
                    )
                    return 4
                print(f"BLOCKER: values failed: {exc}", file=sys.stderr)
                err = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
                if err:
                    sys.stderr.write(err)
                return 4
            values_s = time.perf_counter() - t_values
            if values_s > args.values_timeout:
                print(
                    f"BLOCKER: values took {values_s:.1f}s "
                    f"(budget {args.values_timeout}s) on {args.config.name}",
                    file=sys.stderr,
                )
                return 4

            body = values_env.get("body") or {}
            host_ms = body.get("elapsed_ms")
            print(
                json.dumps(
                    {
                        "stage": "values",
                        "fixture": args.config.name,
                        "node_index": args.node_index,
                        "ipc_round_trip_ms": round(values_s * 1000.0, 3),
                        "host_values_elapsed_ms": host_ms,
                        "body": body,
                    },
                    separators=(",", ":"),
                )
            )
            if host_ms is None:
                print(
                    "BLOCKER: values reply missing elapsed_ms",
                    file=sys.stderr,
                )
                return 5
            print(
                json.dumps(
                    {
                        "ok": True,
                        "metric": "node_ev_latency",
                        "fixture": args.config.name,
                        "ipc_round_trip_ms": round(values_s * 1000.0, 3),
                        "host_values_elapsed_ms": host_ms,
                    },
                    separators=(",", ":"),
                )
            )
            return 0
        finally:
            timer.cancel()
    finally:
        try:
            if proc.stdin:
                proc.stdin.close()
        except OSError:
            pass
        proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Measure Study node-EV latency under active train (D12 live gate / R10).

After async host cutover:
  `solve` runs on a background thread; stdin stays free for `values`.
  Mid-train publish installs a coherent average after each completed iteration;
  `values` takes a reader lease (waits briefly if nothing published yet).

Harness:
  1. CONCURRENCY_PROBE — write multi-iter `solve`, immediately write `values`.
     Expect `values` reply before `solve` completes (overlap_observed=true).
  2. INTERLEAVED_PROXY — N× (1-iter solve → values) baseline on one sidecar.

Example:
  ./scripts/zig/run-gate-bounded.sh 120 python3 scripts/zig/node-ev-live-under-train.py \\
      --binary ./zig-out/bin/solver-engine \\
      --config benchmarks/study/configs/flop_srp_one_size.txt \\
      --probe-iters 2 --interleave-cycles 1 --overall-timeout 110
"""
from __future__ import annotations

import argparse
import json
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Optional


def encode(op: str, body: Any, request_id: str, job_id: Optional[str] = None) -> bytes:
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


def read_frame(stdout, skip_progress: bool = True) -> dict:
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
    if skip_progress and env.get("kind") == "progress":
        return read_frame(stdout, skip_progress=True)
    return env


def write_req(proc: subprocess.Popen, op: str, body: Any, request_id: str, job_id=None) -> None:
    assert proc.stdin is not None
    proc.stdin.write(encode(op, body, request_id, job_id))
    proc.stdin.flush()


def rpc(proc: subprocess.Popen, op: str, body: Any, request_id: str, job_id=None) -> dict:
    write_req(proc, op, body, request_id, job_id)
    env = read_frame(proc.stdout)
    if env.get("kind") != "reply":
        raise RuntimeError(f"unexpected kind: {env!r}")
    if not env.get("ok", False):
        raise RuntimeError(
            f"{env.get('error_code')}: {env.get('error_message')} ({env.get('op')})"
        )
    return env


def body_dict(env: dict) -> dict:
    body = env.get("body")
    if isinstance(body, dict):
        return body
    if isinstance(body, str):
        try:
            parsed = json.loads(body)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def kill_proc(proc: subprocess.Popen) -> None:
    try:
        proc.kill()
    except OSError:
        pass


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--binary", type=Path, default=Path("./zig-out/bin/solver-engine"))
    ap.add_argument(
        "--config",
        type=Path,
        default=Path("benchmarks/study/configs/flop_srp_one_size.txt"),
    )
    ap.add_argument("--node-index", type=int, default=0)
    ap.add_argument(
        "--probe-iters",
        type=int,
        default=2,
        help="iterations for the concurrency probe solve (multi-iter preferred)",
    )
    ap.add_argument(
        "--interleave-cycles",
        type=int,
        default=1,
        help="number of (1-iter solve → values) cycles for the interleaved proxy",
    )
    ap.add_argument(
        "--overall-timeout",
        type=float,
        default=120.0,
        help="hard wall for the whole dig; kill sidecar on exceed",
    )
    ap.add_argument(
        "--skip-probe",
        action="store_true",
        help="skip concurrency probe (interleaved proxy only)",
    )
    ap.add_argument(
        "--skip-interleave",
        action="store_true",
        help="skip interleaved proxy (concurrency probe only)",
    )
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

    meta = {
        "fixture": str(args.config),
        "binary": str(args.binary),
        "probe_iters": args.probe_iters,
        "interleave_cycles": args.interleave_cycles,
        "overall_timeout_s": args.overall_timeout,
        "architectural_note": (
            "async solve thread + mid-train publish + reader lease; "
            "values may reply before solve completes"
        ),
    }
    print(json.dumps({"stage": "meta", **meta}, separators=(",", ":")))

    proc = subprocess.Popen(
        [str(args.binary), "--launch-id", "live-under-train"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    timed_out = {"hit": False}

    def _on_wall() -> None:
        timed_out["hit"] = True
        kill_proc(proc)

    timer = threading.Timer(args.overall_timeout, _on_wall)
    timer.daemon = True
    timer.start()

    result: dict[str, Any] = {
        "ok": False,
        "metric": "live_node_ev_under_train",
        "fixture": args.config.name,
        "overlap_possible": True,
    }

    try:
        try:
            rpc(proc, "ready", None, "live-ready")

            # ---- 1) Concurrency probe (expect values before solve) ----
            if not args.skip_probe:
                rpc(
                    proc,
                    "begin_config",
                    {"config_text": config_text},
                    "live-begin-probe",
                )
                t_send = time.perf_counter()
                write_req(
                    proc,
                    "solve",
                    {"iterations": args.probe_iters},
                    "live-solve-probe",
                    job_id="j-live-probe",
                )
                write_req(
                    proc,
                    "values",
                    {"node_index": args.node_index},
                    "live-values-probe",
                )
                t_values_enqueued = time.perf_counter()

                first = read_frame(proc.stdout)
                t_first = time.perf_counter()
                second = read_frame(proc.stdout)
                t_second = time.perf_counter()

                first_op = first.get("op")
                second_op = second.get("op")
                values_first = first_op == "values" and second_op == "solve"
                solve_first = first_op == "solve" and second_op == "values"
                values_env = first if first_op == "values" else second
                solve_env = first if first_op == "solve" else second
                values_body = body_dict(values_env)
                solve_body = body_dict(solve_env)
                values_wait_ms = (
                    (t_first if first_op == "values" else t_second) - t_values_enqueued
                ) * 1000.0
                solve_wall_ms = (
                    (t_first if first_op == "solve" else t_second) - t_send
                ) * 1000.0
                host_ms = values_body.get("elapsed_ms")
                live_flag = bool(values_body.get("live_under_train"))
                overlap = values_first and bool(values_env.get("ok")) and bool(
                    solve_env.get("ok")
                )

                probe = {
                    "stage": "concurrency_probe",
                    "probe_iters": args.probe_iters,
                    "first_reply_op": first_op,
                    "second_reply_op": second_op,
                    "values_before_solve": values_first,
                    "ordered_solve_then_values": solve_first,
                    "first_ok": bool(first.get("ok")),
                    "second_ok": bool(second.get("ok")),
                    "solve_wall_ms": round(solve_wall_ms, 3),
                    "values_wait_from_enqueue_ms": round(values_wait_ms, 3),
                    "host_values_elapsed_ms": host_ms,
                    "node_ev": values_body.get("node_ev"),
                    "policy_revision": values_body.get("policy_revision"),
                    "live_under_train": live_flag,
                    "solve_trained": solve_body.get("trained"),
                    "overlap_observed": overlap,
                    "conclusion": (
                        "ASYNC_OVERLAP: values replied before solve completed"
                        if overlap
                        else (
                            "SYNC_ORDER: values still after solve — async gap remains"
                            if solve_first
                            else "UNEXPECTED_ORDER: investigate host dispatch"
                        )
                    ),
                }
                print(json.dumps(probe, separators=(",", ":")))
                result["concurrency_probe"] = probe
                result["overlap_possible"] = overlap

                if timed_out["hit"]:
                    print(
                        f"BLOCKER: concurrency probe exceeded {args.overall_timeout}s wall",
                        file=sys.stderr,
                    )
                    result["error"] = "probe_timeout"
                    print(json.dumps(result, separators=(",", ":")))
                    return 3
                if not overlap:
                    print(
                        f"BLOCKER: concurrency probe did not observe overlap: {probe}",
                        file=sys.stderr,
                    )
                    result["error"] = "no_overlap"
                    print(json.dumps(result, separators=(",", ":")))
                    return 4

            # ---- 2) Interleaved proxy (1-iter solve → values)×N ----
            if not args.skip_interleave:
                rpc(
                    proc,
                    "begin_config",
                    {"config_text": config_text},
                    "live-begin-interleave",
                )
                cycles = []
                for i in range(args.interleave_cycles):
                    if timed_out["hit"]:
                        break
                    t_train = time.perf_counter()
                    solve_env = rpc(
                        proc,
                        "solve",
                        {"iterations": 1},
                        f"live-solve-{i}",
                        job_id=f"j-live-{i}",
                    )
                    train_s = time.perf_counter() - t_train
                    t_values = time.perf_counter()
                    values_env = rpc(
                        proc,
                        "values",
                        {"node_index": args.node_index},
                        f"live-values-{i}",
                    )
                    values_s = time.perf_counter() - t_values
                    body = body_dict(values_env)
                    sb = body_dict(solve_env)
                    cycle = {
                        "cycle": i,
                        "train_wall_s": round(train_s, 3),
                        "values_ipc_ms": round(values_s * 1000.0, 3),
                        "host_values_elapsed_ms": body.get("elapsed_ms"),
                        "node_ev": body.get("node_ev"),
                        "policy_revision": sb.get("policy_revision"),
                        "engine": body.get("engine"),
                    }
                    cycles.append(cycle)
                    print(json.dumps({"stage": "interleave_cycle", **cycle}, separators=(",", ":")))

                if timed_out["hit"]:
                    print(
                        f"BLOCKER: interleaved proxy exceeded {args.overall_timeout}s wall",
                        file=sys.stderr,
                    )
                    result["interleave_cycles"] = cycles
                    result["error"] = "interleave_timeout"
                    print(json.dumps(result, separators=(",", ":")))
                    return 5
                if len(cycles) != args.interleave_cycles:
                    result["interleave_cycles"] = cycles
                    result["error"] = "interleave_incomplete"
                    print(json.dumps(result, separators=(",", ":")))
                    return 5
                if any(c.get("host_values_elapsed_ms") is None for c in cycles):
                    result["interleave_cycles"] = cycles
                    result["error"] = "missing_elapsed_ms"
                    print(json.dumps(result, separators=(",", ":")))
                    return 6

                result["interleave_proxy"] = {"cycles": cycles}

            result["ok"] = True
            print(json.dumps(result, separators=(",", ":")))
            return 0
        except Exception as exc:  # noqa: BLE001
            if timed_out["hit"]:
                print(
                    f"BLOCKER: exceeded {args.overall_timeout}s overall wall: {exc}",
                    file=sys.stderr,
                )
                result["error"] = "overall_timeout"
            else:
                print(f"BLOCKER: live-under-train dig failed: {exc}", file=sys.stderr)
                err = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
                if err:
                    sys.stderr.write(err[-8000:])
                result["error"] = str(exc)
            print(json.dumps(result, separators=(",", ":")))
            return 7
    finally:
        timer.cancel()
        try:
            if proc.stdin:
                proc.stdin.close()
        except OSError:
            pass
        kill_proc(proc)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


if __name__ == "__main__":
    raise SystemExit(main())

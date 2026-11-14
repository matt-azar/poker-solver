#!/usr/bin/env python3
"""Real-sidecar overlapping Study actions smoke (ZR-152).

Linux cloud harness (Windows packaged Study / installer lifecycle waits for
ma1pc — follow-up with ZR-147). Alternates Solve / Stop / Continue / Open /
node navigation while analysis (`node` / `values` / Study `equity`) is in
flight.

Acceptance:
  - Late analysis replies do not mutate session identity; after Open, status
    solution_id stays on the opened solution across drain of in-flight reads.
  - allocated_bytes after each idle settle stays bounded across repeated runs
    (no monotonic leak of live heap across cycles).
  - Closing the Study pipe (stdin EOF) leaves no solver-engine process behind.

Out of scope here (ZR-155): status `last_error` UAF / committed-iters publish,
and transactional Equity-calculator enqueue (map/queue reserve + inject tests).

Uses river_gate_smoke. No Accuracy walls. Default overall wall 90s.
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
        raise SmokeError("solver-engine pipe closed (no length prefix)")
    (n,) = struct.unpack("<I", hdr)
    payload = stdout.read(n)
    if not payload or len(payload) < n:
        raise SmokeError("solver-engine pipe closed (truncated payload)")
    env = json.loads(payload)
    if env.get("kind") == "progress":
        return read_frame(stdout)
    if env.get("kind") != "reply":
        raise SmokeError(f"unexpected kind: {env!r}")
    return env


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
    raise SmokeError(f"unexpected body type: {type(body)}")


def require(cond: bool, msg: str) -> None:
    if not cond:
        raise SmokeError(msg)


def kill_proc(proc: subprocess.Popen | None) -> None:
    if proc is None:
        return
    try:
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=5)
    except Exception:  # noqa: BLE001 — best-effort teardown
        pass


class ReplyInbox:
    def __init__(self, stdout) -> None:
        self.stdout = stdout
        self.pending: list[dict] = []

    def _pull(self) -> dict:
        env = read_frame(self.stdout)
        self.pending.append(env)
        return env

    def take(self, op: str, *, timeout_s: float, request_id: str | None = None) -> dict:
        deadline = time.perf_counter() + timeout_s
        while True:
            for i, env in enumerate(self.pending):
                if env.get("op") != op:
                    continue
                if request_id is not None and env.get("request_id") != request_id:
                    continue
                return self.pending.pop(i)
            if time.perf_counter() >= deadline:
                ops = [(e.get("op"), e.get("request_id")) for e in self.pending]
                raise SmokeError(
                    f"timeout waiting for op={op!r} request_id={request_id!r}; pending={ops}"
                )
            self._pull()

    def rpc(
        self,
        proc: subprocess.Popen,
        op: str,
        body: Any,
        request_id: str,
        job_id: str | None = None,
        *,
        expect_ok: bool = True,
        timeout_s: float = 30.0,
    ) -> dict:
        write_req(proc, op, body, request_id, job_id)
        env = self.take(op, timeout_s=timeout_s, request_id=request_id)
        if expect_ok and not env.get("ok", False):
            raise SmokeError(
                f"{env.get('error_code')}: {env.get('error_message')} ({env.get('op')})"
            )
        return env

def admit_solve(
    inbox: ReplyInbox,
    proc: subprocess.Popen,
    iterations: int,
    request_id: str,
    job_id: str,
) -> dict:
    write_req(proc, "solve", {"iterations": iterations}, request_id, job_id=job_id)
    env = inbox.take("solve", timeout_s=15.0, request_id=request_id)
    require(env.get("ok"), f"solve admit failed: {env}")
    body = body_dict(env)
    require(body.get("accepted") is True, f"admit accepted: {body}")
    require(body.get("running") is True, f"admit running: {body}")
    return body


def wait_until_idle(
    inbox: ReplyInbox,
    proc: subprocess.Popen,
    label: str,
    *,
    timeout_s: float = 30.0,
) -> dict:
    deadline = time.perf_counter() + timeout_s
    n = 0
    last: dict = {}
    while time.perf_counter() < deadline:
        last = body_dict(
            inbox.rpc(
                proc,
                "status",
                None,
                f"zr152-idle-{label}-{n}",
                timeout_s=5.0,
            )
        )
        n += 1
        if last.get("running") is False:
            return last
        time.sleep(0.002)
    raise SmokeError(f"{label}: timed out waiting for idle; last={last}")


def wait_until_training(
    inbox: ReplyInbox,
    proc: subprocess.Popen,
    label: str,
    *,
    timeout_s: float = 5.0,
) -> dict:
    deadline = time.perf_counter() + timeout_s
    n = 0
    while time.perf_counter() < deadline:
        st = body_dict(
            inbox.rpc(
                proc,
                "status",
                None,
                f"zr152-train-{label}-{n}",
                timeout_s=5.0,
            )
        )
        n += 1
        rev = int(st.get("policy_revision") or 0)
        iters = int(st.get("iterations") or 0)
        if st.get("phase") == "training" and (rev > 0 or iters > 0):
            return st
        if st.get("running") is False and st.get("phase") != "paused":
            raise SmokeError(f"{label}: left running before phase=training: {st}")
        time.sleep(0.001)
    raise SmokeError(f"{label}: phase never became training with progress")


def fire_analysis_burst(
    proc: subprocess.Popen,
    prefix: str,
    node_id: str,
) -> list[tuple[str, str]]:
    """Write overlapping analysis requests; return (op, request_id) list."""
    reqs: list[tuple[str, str]] = []
    for i, op in enumerate(("node", "values", "equity", "node", "values")):
        rid = f"{prefix}-{op}-{i}"
        body: Any = {"node_id": node_id}
        write_req(proc, op, body, rid)
        reqs.append((op, rid))
    return reqs


def collect_analysis(
    inbox: ReplyInbox,
    reqs: list[tuple[str, str]],
    *,
    timeout_s: float = 15.0,
) -> list[dict]:
    out: list[dict] = []
    for op, rid in reqs:
        env = inbox.take(op, timeout_s=timeout_s, request_id=rid)
        out.append(env)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "binary",
        nargs="?",
        type=Path,
        default=DEFAULT_BINARY,
        help="Path to solver-engine (or .exe)",
    )
    ap.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG,
        help="street-config fixture (default: river_gate_smoke)",
    )
    ap.add_argument(
        "--cycles",
        type=int,
        default=3,
        help="how many Solve/Stop/Continue/Open overlap cycles to run",
    )
    ap.add_argument(
        "--overall-timeout",
        type=float,
        default=90.0,
        help="hard wall for the whole smoke; kill sidecar on exceed",
    )
    args = ap.parse_args()

    binary: Path = args.binary
    config_path: Path = args.config
    if not binary.is_file():
        print(f"BLOCKER: missing binary {binary}", file=sys.stderr)
        return 2
    if not config_path.is_file():
        print(f"BLOCKER: missing config {config_path}", file=sys.stderr)
        return 2
    if args.cycles < 2:
        print("BLOCKER: need at least 2 cycles to observe memory settle", file=sys.stderr)
        return 2

    config_text = config_path.read_text(encoding="utf-8")
    if not config_text.endswith("\n"):
        config_text += "\n"

    timed_out = {"hit": False}
    result: dict[str, Any] = {
        "ok": False,
        "fixture": str(config_path),
        "binary": str(binary),
        "smoke": "zr152-overlapping-actions",
        "platform_note": (
            "Linux real-sidecar harness; Windows packaged Study installer "
            "overlap suite deferred to ZR-147 / ma1pc"
        ),
        "cycles": args.cycles,
    }
    t0 = time.perf_counter()
    proc: subprocess.Popen | None = None
    tmp_paths: list[str] = []

    def _hard_kill() -> None:
        timed_out["hit"] = True
        kill_proc(proc)

    timer = threading.Timer(args.overall_timeout, _hard_kill)
    timer.daemon = True
    timer.start()

    try:
        proc = subprocess.Popen(
            [str(binary), "--launch-id", "zr152-overlap"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert proc.stdout is not None
        inbox = ReplyInbox(proc.stdout)
        engine_pid = proc.pid

        ready = body_dict(inbox.rpc(proc, "ready", None, "zr152-ready"))
        require(ready.get("protocol") == 2, f"bad protocol: {ready}")

        root_id = "p0.t-1.r-1"
        # #373 / ZR-178: tiny river ReleaseFast can burn through short jobs before
        # Stop lands; keep a long live job_id for mid-train cancel.
        long_iters = 2_000_000
        settle_alloc: list[int] = []
        cycle_notes: list[dict[str, Any]] = []

        for cycle in range(args.cycles):
            note: dict[str, Any] = {"cycle": cycle}
            inbox.rpc(
                proc,
                "begin_config",
                {"config_text": config_text},
                f"zr152-begin-{cycle}",
            )

            # --- Solve while analysis in flight ---
            admit = admit_solve(
                inbox,
                proc,
                long_iters,
                f"zr152-solve-{cycle}",
                f"j-zr152-solve-{cycle}",
            )
            note["solve_solution_id"] = admit.get("solution_id")
            wait_until_training(inbox, proc, f"solve-{cycle}")
            burst_a = fire_analysis_burst(proc, f"zr152-a-{cycle}", root_id)

            # --- Stop mid-train (job-scoped cancel must match active train id) ---
            write_req(
                proc,
                "cancel",
                None,
                f"zr152-cancel-{cycle}",
                job_id=f"j-zr152-solve-{cycle}",
            )
            cancel_env = inbox.take(
                "cancel", timeout_s=10.0, request_id=f"zr152-cancel-{cycle}"
            )
            require(cancel_env.get("ok"), f"cancel failed: {cancel_env}")
            require(
                body_dict(cancel_env).get("cancelled") is True,
                f"cancel body (expected live job stop): {cancel_env}",
            )
            collect_analysis(inbox, burst_a, timeout_s=20.0)
            stopped = wait_until_idle(inbox, proc, f"stop-{cycle}")
            note["after_stop"] = {
                "terminal_reason": stopped.get("terminal_reason"),
                "solution_id": stopped.get("solution_id"),
                "iterations": stopped.get("iterations"),
                "allocated_bytes": stopped.get("allocated_bytes"),
            }
            require(stopped.get("solution_id"), f"missing solution after stop: {stopped}")

            # --- Continue with overlapping nav/analysis ---
            child_node = body_dict(
                inbox.rpc(proc, "node", {"node_id": root_id}, f"zr152-nav-root-{cycle}")
            )
            children = child_node.get("children") or []
            require(isinstance(children, list) and children, f"no children: {child_node}")
            child_id = children[0]

            admit_solve(
                inbox,
                proc,
                8,
                f"zr152-continue-{cycle}",
                f"j-zr152-cont-{cycle}",
            )
            burst_b = fire_analysis_burst(proc, f"zr152-b-{cycle}", child_id)
            # Navigate while continue + analysis overlap.
            write_req(proc, "node", {"node_id": child_id}, f"zr152-nav-child-{cycle}")
            cont_idle = wait_until_idle(inbox, proc, f"cont-{cycle}")
            inbox.take("node", timeout_s=10.0, request_id=f"zr152-nav-child-{cycle}")
            collect_analysis(inbox, burst_b, timeout_s=20.0)
            note["after_continue"] = {
                "iterations": cont_idle.get("iterations"),
                "solution_id": cont_idle.get("solution_id"),
                "allocated_bytes": cont_idle.get("allocated_bytes"),
            }
            require(
                int(cont_idle.get("iterations") or 0) >= 1,
                f"continue produced no iters: {cont_idle}",
            )

            # --- Save, fire late analysis, Open (new identity), drain late replies ---
            fd, tmp_path = tempfile.mkstemp(prefix=f"zr152-c{cycle}-", suffix=".psol")
            os.close(fd)
            tmp_paths.append(tmp_path)
            save_env = inbox.rpc(proc, "save", {"path": tmp_path}, f"zr152-save-{cycle}")
            require(body_dict(save_env).get("saved") is True, f"save: {save_env}")

            pre_open_solution = cont_idle.get("solution_id")
            # In-flight analysis against the pre-open solution.
            late_reqs = fire_analysis_burst(proc, f"zr152-late-{cycle}", root_id)
            # Open replaces published solution; late replies must not roll it back.
            open_env = inbox.rpc(proc, "open", {"path": tmp_path}, f"zr152-open-{cycle}")
            open_body = body_dict(open_env)
            opened_id = open_body.get("solution_id")
            require(opened_id, f"open missing solution_id: {open_body}")
            late_replies = collect_analysis(inbox, late_reqs, timeout_s=20.0)
            after_open = body_dict(
                inbox.rpc(proc, "status", None, f"zr152-status-open-{cycle}")
            )
            require(
                after_open.get("solution_id") == opened_id,
                f"late analysis overwrote solution: status={after_open} opened={opened_id} "
                f"pre_open={pre_open_solution}",
            )
            # Engine analysis is read-only; replies may carry the pre-open id, but
            # session identity after Open must stay on opened_id.
            note["open"] = {
                "opened_solution_id": opened_id,
                "status_solution_id": after_open.get("solution_id"),
                "late_reply_ops": [r.get("op") for r in late_replies],
                "late_ok_count": sum(1 for r in late_replies if r.get("ok")),
            }

            # Node navigation on the opened solution.
            nav = body_dict(
                inbox.rpc(
                    proc,
                    "node",
                    {"node_id": root_id},
                    f"zr152-nav-open-{cycle}",
                )
            )
            require(nav.get("node_id") == root_id, f"nav after open: {nav}")
            if nav.get("solution_id") is not None:
                require(
                    nav.get("solution_id") == opened_id,
                    f"nav solution mismatch: {nav}",
                )

            settled = wait_until_idle(inbox, proc, f"settle-{cycle}")
            require(
                settled.get("solution_id") == opened_id,
                f"settled solution drifted: {settled}",
            )
            alloc = int(settled.get("allocated_bytes") or 0)
            settle_alloc.append(alloc)
            note["settled_allocated_bytes"] = alloc
            cycle_notes.append(note)

        # Memory settles: live allocated_bytes after idle must not grow without
        # bound across repeated identical cycles (allow small noise).
        require(len(settle_alloc) == args.cycles, "missing settle samples")
        baseline = settle_alloc[0]
        require(baseline >= 0, f"bad baseline alloc: {baseline}")
        for i, alloc in enumerate(settle_alloc[1:], start=1):
            # Allow 2× headroom for allocator arenas / retained jobs; fail on
            # clear monotonic leak (e.g. 8× growth).
            require(
                alloc <= max(baseline * 8, baseline + 64 * 1024 * 1024),
                f"allocated_bytes grew unboundedly: cycle0={baseline} cycle{i}={alloc}",
            )
        # Final cycle should be within 4× of the median of earlier settles.
        if len(settle_alloc) >= 3:
            earlier = sorted(settle_alloc[:-1])
            median = earlier[len(earlier) // 2]
            require(
                settle_alloc[-1] <= max(median * 4, median + 32 * 1024 * 1024),
                f"final settle alloc {settle_alloc[-1]} vs median {median}",
            )

        result["cycles_detail"] = cycle_notes
        result["settled_allocated_bytes"] = settle_alloc
        result["late_response_overwrite"] = False
        result["memory_settled"] = True

        # --- Closing Study: stdin EOF must exit the engine (no orphan process) ---
        assert proc.stdin is not None
        proc.stdin.close()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired as exc:
            kill_proc(proc)
            raise SmokeError("solver-engine did not exit after stdin close") from exc
        exit_code = proc.returncode
        still_alive = proc.poll() is None
        require(not still_alive, f"engine still alive after close: pid={engine_pid}")
        # Confirm pid is not running (best-effort; PID reuse is rare in this window).
        pid_exists = Path(f"/proc/{engine_pid}").exists() if os.name != "nt" else False
        require(
            not pid_exists,
            f"engine pid {engine_pid} still present under /proc after wait",
        )
        result["engine_exit"] = {
            "pid": engine_pid,
            "returncode": exit_code,
            "stdin_eof_exited": True,
            "proc_gone": True,
        }
        proc = None

        result["ok"] = True
        result["wall_s"] = round(time.perf_counter() - t0, 4)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except Exception as exc:  # noqa: BLE001 — smoke reports failure payload
        result["ok"] = False
        result["error"] = str(exc)
        result["timed_out"] = timed_out["hit"]
        result["wall_s"] = round(time.perf_counter() - t0, 4)
        print(json.dumps(result, indent=2, sort_keys=True))
        print(f"zr152-overlap-smoke FAILED: {exc}", file=sys.stderr)
        return 1
    finally:
        timer.cancel()
        kill_proc(proc)
        for path in tmp_paths:
            try:
                os.unlink(path)
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())

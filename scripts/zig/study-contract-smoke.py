#!/usr/bin/env python3
"""Real-sidecar Study contract smoke (ZR-104 / audit §8).

Spawns `solver-engine` over length-prefixed protocol-2 IPC and exercises:
  ready → begin_config → solve → status → node (links + weighted strategy)
  → equity → pause/stop mid-train → checkpoint save/open/continue
  → 1 MiB smoke_resource_flop begin_config → budget_exceeded (ZR-142)

Train uses ZR-106 short-admit (`{accepted,running}`); completion is polled
via `status` (`running` / `terminal_reason` / `policy_revision` / `last_error`).
Async train faults stay sticky on `last_error` (no second solve reply).

ZR-133 Change C: iteration progress (`iterations`) advances every train step;
`policy_revision` advances only on strategy publish events (bounded cadence,
default every 10 iters, plus first iter / pause / stop / completion flushes).
Do not require revision == trained.

ZR-142: over-budget begin must not wipe the last usable published solution;
status exposes memory_budget_bytes / allocated_bytes / peak_allocated_bytes.

Uses the tiny river_gate_smoke fixture. No Accuracy walls.
Overall wall bound defaults to 60s.
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


class ContractError(RuntimeError):
    pass


def encode(
    op: str,
    body: Any,
    request_id: str,
    job_id: str | None = None,
    *,
    alphabetical_keys: bool = False,
) -> bytes:
    """Encode a protocol-2 request frame.

    When alphabetical_keys=True, emit BTreeMap-style key order (body before
    kind) to regression-test host top-level field scanning (ZR-119).
    """
    envelope: dict[str, Any] = {
        "v": 2,
        "kind": "request",
        "request_id": request_id,
        "job_id": job_id,
        "op": op,
        "body": body,
    }
    if alphabetical_keys:
        envelope = {k: envelope[k] for k in sorted(envelope)}
    payload = json.dumps(envelope, separators=(",", ":")).encode()
    return struct.pack("<I", len(payload)) + payload


def read_frame(stdout) -> dict:
    hdr = stdout.read(4)
    if not hdr or len(hdr) < 4:
        raise ContractError("solver-engine pipe closed (no length prefix)")
    (n,) = struct.unpack("<I", hdr)
    payload = stdout.read(n)
    if not payload or len(payload) < n:
        raise ContractError("solver-engine pipe closed (truncated payload)")
    env = json.loads(payload)
    if env.get("kind") == "progress":
        return read_frame(stdout)
    if env.get("kind") != "reply":
        raise ContractError(f"unexpected kind: {env!r}")
    return env


def write_req(
    proc: subprocess.Popen,
    op: str,
    body: Any,
    request_id: str,
    job_id: str | None = None,
    *,
    alphabetical_keys: bool = False,
) -> None:
    assert proc.stdin is not None
    proc.stdin.write(
        encode(op, body, request_id, job_id, alphabetical_keys=alphabetical_keys)
    )
    proc.stdin.flush()


def body_dict(env: dict) -> dict:
    body = env.get("body")
    if body is None:
        return {}
    if isinstance(body, dict):
        return body
    if isinstance(body, str):
        return json.loads(body)
    raise ContractError(f"unexpected body type: {type(body)}")


def require(cond: bool, msg: str) -> None:
    if not cond:
        raise ContractError(msg)


def weighted_action_freqs(node: dict) -> list[float]:
    """Σ_h reach[h]·σ[h][a] / Σ_h reach[h] — Study matrix weighting."""
    strategy = node.get("strategy")
    reach = node.get("reach") or []
    n_actions = int(node.get("n_actions") or 0)
    require(isinstance(strategy, list) and n_actions > 0, "decision needs strategy rows")
    require(len(reach) == len(strategy), "reach/strategy hand count mismatch")
    totals = [0.0] * n_actions
    mass = 0.0
    for hand_row, w in zip(strategy, reach):
        rw = float(w)
        if rw <= 0:
            continue
        require(isinstance(hand_row, list) and len(hand_row) == n_actions, "bad strategy row")
        mass += rw
        for a, p in enumerate(hand_row):
            totals[a] += rw * float(p)
    require(mass > 0, "zero reach mass for weighted strategy")
    return [t / mass for t in totals]


class ReplyInbox:
    """Demux interleaved async replies without dropping frames."""

    def __init__(self, stdout) -> None:
        self.stdout = stdout
        self.pending: list[dict] = []

    def _pull(self) -> dict:
        env = read_frame(self.stdout)
        self.pending.append(env)
        return env

    def take(self, op: str, *, timeout_s: float) -> dict:
        deadline = time.perf_counter() + timeout_s
        while True:
            for i, env in enumerate(self.pending):
                if env.get("op") == op:
                    return self.pending.pop(i)
            if time.perf_counter() >= deadline:
                ops = [e.get("op") for e in self.pending]
                raise ContractError(
                    f"timeout waiting for op={op!r}; pending={ops}"
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
        alphabetical_keys: bool = False,
    ) -> dict:
        write_req(
            proc,
            op,
            body,
            request_id,
            job_id,
            alphabetical_keys=alphabetical_keys,
        )
        env = self.take(op, timeout_s=timeout_s)
        if expect_ok and not env.get("ok", False):
            raise ContractError(
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
    """ZR-106: solve returns immediately with accepted/running; no completion reply."""
    write_req(proc, "solve", {"iterations": iterations}, request_id, job_id=job_id)
    env = inbox.take("solve", timeout_s=15.0)
    require(env.get("ok"), f"solve admit failed: {env}")
    body = body_dict(env)
    # ZR-125: pin the full short-admit shape Study relies on.
    require(body.get("accepted") is True, f"admit accepted: {body}")
    require(body.get("running") is True, f"admit running: {body}")
    require(body.get("async") is True, f"admit async: {body}")
    require("solution_id" in body, f"admit solution_id: {body}")
    require("threads" in body, f"admit threads: {body}")
    return body


def wait_until_idle(
    inbox: ReplyInbox,
    proc: subprocess.Popen,
    label: str,
    *,
    timeout_s: float = 45.0,
) -> dict:
    """Poll status until train overlay leaves running (Study waitUntilIdle)."""
    deadline = time.perf_counter() + timeout_s
    n = 0
    last: dict = {}
    while time.perf_counter() < deadline:
        last = body_dict(
            inbox.rpc(
                proc,
                "status",
                None,
                f"c-wait-idle-{label}-{n}",
                timeout_s=5.0,
            )
        )
        n += 1
        if last.get("running") is False:
            return last
        time.sleep(0.002)
    raise ContractError(f"{label}: timed out waiting for idle; last={last}")


def wait_until_training(
    inbox: ReplyInbox,
    proc: subprocess.Popen,
    label: str,
    *,
    timeout_s: float = 5.0,
) -> dict:
    """Wait until train is live with at least one published revision.

    Short-admit can report phase=training before the first publish; pause/stop
    probes need a positive revision so early-stop assertions stay meaningful.
    """
    deadline = time.perf_counter() + timeout_s
    n = 0
    while time.perf_counter() < deadline:
        st = body_dict(
            inbox.rpc(
                proc,
                "status",
                None,
                f"c-wait-train-{label}-{n}",
                timeout_s=5.0,
            )
        )
        n += 1
        rev = int(st.get("policy_revision") or 0)
        iters = int(st.get("iterations") or 0)
        if st.get("phase") == "training" and (rev > 0 or iters > 0):
            return st
        if st.get("running") is False and st.get("phase") != "paused":
            # Finished before we observed training (should not with long_iters).
            raise ContractError(f"{label}: left running before phase=training: {st}")
        time.sleep(0.001)
    raise ContractError(f"{label}: phase never became training with progress")


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
        "--overall-timeout",
        type=float,
        default=60.0,
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

    config_text = config_path.read_text(encoding="utf-8")
    if not config_text.endswith("\n"):
        config_text += "\n"

    timed_out = {"hit": False}

    def _hard_kill(proc: subprocess.Popen) -> None:
        timed_out["hit"] = True
        try:
            proc.kill()
        except OSError:
            pass

    result: dict[str, Any] = {
        "ok": False,
        "fixture": str(config_path),
        "binary": str(binary),
    }
    t0 = time.perf_counter()

    proc = subprocess.Popen(
        [str(binary), "--launch-id", "study-contract-smoke"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    timer = threading.Timer(args.overall_timeout, _hard_kill, args=(proc,))
    timer.daemon = True
    timer.start()

    tmp_path: str | None = None
    try:
        assert proc.stdout is not None
        inbox = ReplyInbox(proc.stdout)
        stages: dict[str, Any] = {}
        long_iters = 2_000_000

        # --- ready + idle status ---
        ready_body = body_dict(inbox.rpc(proc, "ready", None, "c-ready"))
        require(ready_body.get("protocol") == 2, f"bad protocol: {ready_body}")
        require(
            ready_body.get("sidecar") == "solver-engine",
            f"bad sidecar: {ready_body}",
        )
        stages["ready"] = {"ok": True, "protocol": ready_body.get("protocol")}

        status0 = body_dict(inbox.rpc(proc, "status", None, "c-status0"))
        require("running" in status0 and "paused" in status0, f"status shape: {status0}")
        require("status_generation" in status0, "status missing generation")
        # ZR-125: idle status must expose progress + recovery fields Study polls.
        for key in (
            "phase",
            "iterations",
            "iterations_requested",
            "failed",
            "last_error",
            "has_training",
            "can_continue",
            "policy_revision",
            "terminal_reason",
        ):
            require(key in status0, f"status missing {key}: {status0}")
        require(status0.get("last_error") is None, f"idle last_error: {status0}")
        stages["status_idle"] = {
            "running": status0.get("running"),
            "phase": status0.get("phase"),
            "iterations": status0.get("iterations"),
            "iterations_requested": status0.get("iterations_requested"),
            "failed": status0.get("failed"),
        }

        # --- ZR-170: idle values/equity must fail fast (no 30s publish wait) ---
        t_idle_vals = time.perf_counter()
        idle_vals = inbox.rpc(
            proc,
            "values",
            {"node_id": "r"},
            "c-idle-values",
            expect_ok=False,
            timeout_s=2.0,
        )
        idle_vals_s = round(time.perf_counter() - t_idle_vals, 4)
        require(idle_vals.get("ok") is False, f"idle values should fail: {idle_vals}")
        require(
            idle_vals.get("error_code") == "nothing_published",
            f"idle values code: {idle_vals}",
        )
        require(idle_vals_s < 2.0, f"idle values too slow: {idle_vals_s}s")
        t_idle_eq = time.perf_counter()
        idle_eq = inbox.rpc(
            proc,
            "equity",
            {"node_id": "r"},
            "c-idle-equity",
            expect_ok=False,
            timeout_s=2.0,
        )
        idle_eq_s = round(time.perf_counter() - t_idle_eq, 4)
        require(idle_eq.get("ok") is False, f"idle equity should fail: {idle_eq}")
        require(
            idle_eq.get("error_code") == "nothing_published",
            f"idle equity code: {idle_eq}",
        )
        require(idle_eq_s < 2.0, f"idle equity too slow: {idle_eq_s}s")
        stages["idle_analysis_fast_fail"] = {
            "values_s": idle_vals_s,
            "equity_s": idle_eq_s,
            "values_error": idle_vals.get("error_code"),
            "equity_error": idle_eq.get("error_code"),
        }

        # --- begin + short solve ---
        begin = body_dict(
            inbox.rpc(proc, "begin_config", {"config_text": config_text}, "c-begin")
        )
        require("solution_id" in begin, f"begin missing solution_id: {begin}")

        t_solve = time.perf_counter()
        admit10 = admit_solve(inbox, proc, 10, "c-solve-10", "j-contract-10")
        status1 = wait_until_idle(inbox, proc, "solve-10")
        require(status1.get("has_training") is True, f"has_training: {status1}")
        require(status1.get("can_continue") is True, f"can_continue: {status1}")
        require(status1.get("solution_id"), f"no solution_id: {status1}")
        require(
            status1.get("terminal_reason") == "completed",
            f"solve-10 terminal: {status1}",
        )
        require(
            status1.get("phase") == "published",
            f"solve-10 phase: {status1}",
        )
        # ZR-133: revision tracks publish events (first + completion flush for
        # a 10-iter batch at default cadence), not every trained iteration.
        rev10 = int(status1.get("policy_revision") or 0)
        require(rev10 >= 2, f"solve-10 revision<{2}: {status1}")
        require(rev10 < 10, f"solve-10 revision still every-iter: {status1}")
        # ZR-120: status must carry iteration progress for Study UI.
        require(
            int(status1.get("iterations") or -1) == 10,
            f"solve-10 iterations!=10: {status1}",
        )
        require(
            int(status1.get("iterations_requested") or -1) == 10,
            f"solve-10 iterations_requested!=10: {status1}",
        )
        stages["solve_10"] = {
            "admit": admit10,
            "terminal_reason": status1.get("terminal_reason"),
            "wall_s": round(time.perf_counter() - t_solve, 4),
            "policy_revision": status1.get("policy_revision"),
            "iterations": status1.get("iterations"),
            "iterations_requested": status1.get("iterations_requested"),
        }
        stages["status_after_solve"] = {
            "has_training": status1.get("has_training"),
            "can_continue": status1.get("can_continue"),
            "policy_revision": status1.get("policy_revision"),
            "phase": status1.get("phase"),
            "iterations": status1.get("iterations"),
        }

        # Idle pause after publication (Study pause control when not training).
        pause_idle = body_dict(inbox.rpc(proc, "pause", None, "c-pause-idle"))
        require(pause_idle.get("phase") == "paused", f"idle pause: {pause_idle}")

        # --- node links + weighted strategy ---
        node_root = body_dict(
            inbox.rpc(proc, "node", {"node_id": "p0.t-1.r-1"}, "c-node-root")
        )
        require(node_root.get("kind") == "decision", f"root kind: {node_root.get('kind')}")
        require(node_root.get("reach_defined") is True, "root reach_defined false")
        children = node_root.get("children") or []
        require(isinstance(children, list) and len(children) >= 1, "missing children")
        require(
            all(isinstance(c, str) and c.startswith("p") for c in children),
            f"bad children: {children}",
        )
        require(
            len(node_root.get("actions") or []) == len(children),
            "actions/children length mismatch",
        )
        reach = node_root.get("reach") or []
        marginal = node_root.get("marginal") or []
        require(len(reach) == int(node_root["n_hands"]), "reach length")
        require(len(marginal) == int(node_root["n_hands"]), "marginal length")
        freqs = weighted_action_freqs(node_root)
        freq_sum = sum(freqs)
        require(abs(freq_sum - 1.0) < 1e-4, f"weighted freqs sum {freq_sum}")

        child_id = children[0]
        node_child = body_dict(
            inbox.rpc(proc, "node", {"node_id": child_id}, "c-node-child")
        )
        require(node_child.get("node_id") == child_id, "child node_id mismatch")
        require(
            node_child.get("kind") in ("decision", "chance", "terminal"),
            f"unexpected child kind: {node_child.get('kind')}",
        )
        stages["node"] = {
            "root_actions": node_root.get("actions"),
            "root_children": children,
            "reach_defined": True,
            "weighted_freqs": [round(f, 6) for f in freqs],
            "child_id": child_id,
            "child_kind": node_child.get("kind"),
        }

        # --- node equity (root + first child) ---
        eq_root = body_dict(
            inbox.rpc(proc, "equity", {"node_id": "p0.t-1.r-1"}, "c-eq-root")
        )
        require(eq_root.get("kind") == "equity", f"equity kind: {eq_root}")
        require(eq_root.get("defined") is True, f"equity undefined: {eq_root}")
        oop = float(eq_root["oop_equity"])
        ip = float(eq_root["ip_equity"])
        require(abs(oop + ip - 1.0) < 1e-5, f"oop+ip={oop}+{ip}")

        eq_child = body_dict(
            inbox.rpc(proc, "equity", {"node_id": child_id}, "c-eq-child")
        )
        require(eq_child.get("defined") is True, f"child equity: {eq_child}")
        require(eq_child.get("node_id") == child_id, "child equity node_id")
        stages["equity"] = {
            "root_oop": oop,
            "root_ip": ip,
            "child_oop": float(eq_child["oop_equity"]),
            "child_ip": float(eq_child["ip_equity"]),
            "child_node_id": child_id,
        }

        # --- strategy-edit put with alphabetical envelope keys (ZR-119) ---
        # Mimics serde_json BTreeMap order (body before kind). Nested body
        # "kind":"full" must not InvalidFrame-kill the sidecar.
        n_actions = int(node_root.get("n_actions") or 0)
        require(n_actions >= 1, f"root n_actions: {n_actions}")
        probs = [0.0] * n_actions
        probs[-1] = 1.0
        put_alpha = body_dict(
            inbox.rpc(
                proc,
                "put_strategy_edit",
                {
                    "node_id": "p0.t-1.r-1",
                    "kind": "full",
                    "probs": probs,
                },
                "c-put-edit-alpha",
                alphabetical_keys=True,
            )
        )
        require(
            isinstance(put_alpha.get("edits"), list) and len(put_alpha["edits"]) >= 1,
            f"alpha put_strategy_edit: {put_alpha}",
        )
        # Engine must still answer after the alpha-ordered frame (no exit).
        listed = body_dict(
            inbox.rpc(proc, "list_strategy_edits", None, "c-list-edits")
        )
        require(
            len(listed.get("edits") or []) >= 1,
            f"list after alpha put: {listed}",
        )
        deleted = body_dict(
            inbox.rpc(
                proc,
                "delete_strategy_edit",
                {"node_id": "p0.t-1.r-1"},
                "c-del-edit",
            )
        )
        require(
            len(deleted.get("edits") or []) == 0,
            f"delete strategy edit: {deleted}",
        )
        # Recoverable reject must not disconnect.
        bad = inbox.rpc(
            proc,
            "put_strategy_edit",
            {
                "node_id": "p0.t-1.r-1",
                "kind": "full",
                "probs": [2.0] + [0.0] * (n_actions - 1),
            },
            "c-put-edit-bad",
            expect_ok=False,
            alphabetical_keys=True,
        )
        require(bad.get("ok") is False, f"expected invalid probs reject: {bad}")
        require(
            bad.get("error_code") in ("invalid_request", "invalid_frame"),
            f"unexpected bad error_code: {bad}",
        )
        alive = body_dict(inbox.rpc(proc, "status", None, "c-status-after-edit"))
        require("running" in alive, f"status after strategy edit: {alive}")
        stages["strategy_edit_alpha_keys"] = {
            "put_n_edits": len(put_alpha.get("edits") or []),
            "list_n_edits": len(listed.get("edits") or []),
            "delete_n_edits": len(deleted.get("edits") or []),
            "invalid_probs_rejected": True,
            "sidecar_alive_after": True,
        }

        # --- put_lock alphabetical envelope keys (ZR-119 / ZR-125) ---
        lock_probs = [0.0] * n_actions
        lock_probs[0] = 1.0
        put_lock_alpha = body_dict(
            inbox.rpc(
                proc,
                "put_lock",
                {
                    "node_id": "p0.t-1.r-1",
                    "kind": "full",
                    "scope": "node",
                    "probs": lock_probs,
                },
                "c-put-lock-alpha",
                alphabetical_keys=True,
            )
        )
        require(
            isinstance(put_lock_alpha.get("locks"), list)
            and len(put_lock_alpha["locks"]) >= 1,
            f"alpha put_lock: {put_lock_alpha}",
        )
        # Clear lock so later pause/stop trains stay unlocked.
        clear_lock = body_dict(
            inbox.rpc(
                proc,
                "delete_lock",
                {"node_id": "p0.t-1.r-1"},
                "c-del-lock",
            )
        )
        require(
            isinstance(clear_lock.get("locks"), list)
            and len(clear_lock["locks"]) == 0,
            f"delete_lock after alpha put: {clear_lock}",
        )
        alive_lock = body_dict(inbox.rpc(proc, "status", None, "c-status-after-lock"))
        require("running" in alive_lock, f"status after put_lock: {alive_lock}")
        stages["put_lock_alpha_keys"] = {
            "put_n_locks": len(put_lock_alpha.get("locks") or []),
            "delete_n_locks": len(clear_lock.get("locks") or []),
            "sidecar_alive_after": True,
        }

        # --- pause mid-train, then stop (cancel) mid-train ---
        inbox.rpc(proc, "begin_config", {"config_text": config_text}, "c-begin-pause")
        admit_solve(inbox, proc, long_iters, "c-solve-pause", "j-contract-pause")
        wait_until_training(inbox, proc, "pause")
        write_req(proc, "pause", None, "c-pause")
        pause_env = inbox.take("pause", timeout_s=10.0)
        require(pause_env.get("ok"), f"pause failed: {pause_env}")
        status_paused = wait_until_idle(inbox, proc, "pause")
        require(
            status_paused.get("terminal_reason") == "paused",
            f"expected paused terminal: {status_paused}",
        )
        rev_paused = int(status_paused.get("policy_revision") or 0)
        require(
            0 < rev_paused < long_iters,
            f"pause did not stop early: {status_paused}",
        )

        admit_solve(inbox, proc, long_iters, "c-solve-stop", "j-contract-stop")
        wait_until_training(inbox, proc, "stop")
        write_req(proc, "cancel", None, "c-cancel", job_id="j-contract-stop")
        cancel_env = inbox.take("cancel", timeout_s=10.0)
        require(cancel_env.get("ok"), f"cancel failed: {cancel_env}")
        require(
            body_dict(cancel_env).get("cancelled") is True,
            f"cancel body: {cancel_env}",
        )
        status_stopped = wait_until_idle(inbox, proc, "stop")
        require(
            status_stopped.get("terminal_reason") == "cancelled",
            f"expected cancelled terminal: {status_stopped}",
        )
        rev_stopped = int(status_stopped.get("policy_revision") or 0)
        require(
            rev_stopped < rev_paused + long_iters,
            f"stop did not stop early: {status_stopped}",
        )
        stages["pause_stop"] = {
            "pause_revision": rev_paused,
            "stop_revision": rev_stopped,
            "pause_terminal": status_paused.get("terminal_reason"),
            "stop_terminal": status_stopped.get("terminal_reason"),
        }

        # Fresh job after stop must admit + complete.
        admit_solve(inbox, proc, 1, "c-solve-fresh", "j-contract-fresh")
        status_fresh = wait_until_idle(inbox, proc, "fresh")
        require(
            status_fresh.get("terminal_reason") == "completed",
            f"fresh after stop: {status_fresh}",
        )
        stages["fresh_after_stop"] = {
            "terminal_reason": status_fresh.get("terminal_reason"),
            "policy_revision": status_fresh.get("policy_revision"),
        }

        # --- checkpoint save / open / continue (10 + 5) ---
        # Open resets policy_revision to 1 while preserving trainer.trained.
        # ZR-133: continue +5 at default cadence publishes on completion flush
        # (rev 1 → 2), not once per iter. Cumulative trained is still 15.
        inbox.rpc(proc, "begin_config", {"config_text": config_text}, "c-begin-ckpt")
        admit_solve(inbox, proc, 10, "c-ckpt-10", "j-ckpt-10")
        ckpt10 = wait_until_idle(inbox, proc, "ckpt-10")
        ckpt10_rev = int(ckpt10.get("policy_revision") or 0)
        require(ckpt10_rev >= 2, f"ckpt10 revision<{2}: {ckpt10}")
        require(ckpt10_rev < 10, f"ckpt10 revision still every-iter: {ckpt10}")
        require(
            int(ckpt10.get("iterations") or -1) == 10,
            f"ckpt10 iterations!=10: {ckpt10}",
        )
        require(ckpt10.get("terminal_reason") == "completed", f"ckpt10 terminal: {ckpt10}")
        require(ckpt10.get("phase") == "published", f"ckpt10 phase: {ckpt10}")

        fd, tmp_path = tempfile.mkstemp(prefix="zr104-", suffix=".psol")
        os.close(fd)
        save_env = inbox.rpc(proc, "save", {"path": tmp_path}, "c-save")
        require(body_dict(save_env).get("saved") is True, f"save: {save_env}")

        open_env = inbox.rpc(proc, "open", {"path": tmp_path}, "c-open")
        open_body = body_dict(open_env)
        require(open_body.get("can_continue") is True, f"open can_continue: {open_body}")
        require(open_body.get("has_training") is True, f"open has_training: {open_body}")
        require("status_generation" in open_body, "open missing status_generation")
        # Open reinstalls published revision = 1 while preserving trainer.trained.
        require(
            int(open_body.get("policy_revision") or 0) == 1,
            f"open revision reset: {open_body}",
        )

        # ZR-125: continue absolute iterations_requested = start_trained + job_iters.
        # After open, trainer.trained is still 10; +5 ⇒ requested 15.
        admit5 = admit_solve(inbox, proc, 5, "c-ckpt-5", "j-ckpt-5")
        mid_continue = body_dict(
            inbox.rpc(proc, "status", None, "c-status-continue-mid")
        )
        require(
            int(mid_continue.get("iterations_requested") or -1) == 15,
            f"continue iterations_requested!=15: {mid_continue}",
        )
        ckpt15 = wait_until_idle(inbox, proc, "ckpt-5")
        require(ckpt15.get("terminal_reason") == "completed", f"ckpt continue: {ckpt15}")
        # Open@1 + multi-iter completion flush (cadence bound not hit in 5 steps).
        # ZR-171: footer Acc/gap samples must not force-publish every eval — only
        # ZR-133 strategy cadence + completion flush advance policy_revision.
        require(
            int(ckpt15.get("policy_revision") or 0) == 2,
            f"continue revision!=2 (open@1 + completion flush): {ckpt15}",
        )
        require(
            int(ckpt15.get("iterations") or -1) == 15,
            f"continue iterations!=15: {ckpt15}",
        )
        stages["checkpoint"] = {
            "revision_after_10": ckpt10.get("policy_revision"),
            "revision_on_open": open_body.get("policy_revision"),
            "revision_after_open_continue_5": ckpt15.get("policy_revision"),
            "can_continue_on_open": open_body.get("can_continue"),
            "continue_admit": admit5,
            "continue_iterations_requested": mid_continue.get("iterations_requested"),
            "continue_iterations": ckpt15.get("iterations"),
            "note": (
                "trainer.trained is 15; policy_revision advances on publish "
                "events (ZR-133 cadence), open resets revision to 1"
            ),
        }

        # --- ZR-142 memory budget: 1 MiB flop must fail; prior solution kept ---
        prior_status = body_dict(inbox.rpc(proc, "status", None, "c-budget-prior"))
        prior_sid = prior_status.get("solution_id")
        prior_rev_budget = int(prior_status.get("policy_revision") or 0)
        require(prior_sid, f"missing prior solution before budget reject: {prior_status}")
        flop_budget_path = ROOT / "benchmarks/study/configs/smoke_resource_flop.txt"
        flop_budget_text = flop_budget_path.read_text(encoding="utf-8")
        budget_env = inbox.rpc(
            proc,
            "begin_config",
            {"config_text": flop_budget_text},
            "c-budget-reject",
            expect_ok=False,
        )
        require(
            budget_env.get("error_code") == "budget_exceeded",
            f"1 MiB flop expected budget_exceeded: {budget_env}",
        )
        after_status = body_dict(inbox.rpc(proc, "status", None, "c-budget-after"))
        require(
            after_status.get("solution_id") == prior_sid,
            f"budget reject wiped solution: before={prior_sid} after={after_status}",
        )
        require(
            int(after_status.get("policy_revision") or -1) == prior_rev_budget,
            f"budget reject changed revision: {after_status}",
        )
        require(
            "allocated_bytes" in after_status and "memory_budget_bytes" in after_status,
            f"status missing memory accounting: {after_status}",
        )
        stages["memory_budget"] = {
            "error_code": budget_env.get("error_code"),
            "preserved_solution_id": after_status.get("solution_id"),
            "allocated_bytes": after_status.get("allocated_bytes"),
            "memory_budget_bytes": after_status.get("memory_budget_bytes"),
            "peak_allocated_bytes": after_status.get("peak_allocated_bytes"),
        }

        wall_s = round(time.perf_counter() - t0, 4)
        require(not timed_out["hit"], "overall timeout hit")
        result.update({"ok": True, "wall_s": wall_s, "stages": stages})
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except Exception as exc:  # noqa: BLE001 — surface as smoke failure
        result["ok"] = False
        result["error"] = str(exc)
        result["wall_s"] = round(time.perf_counter() - t0, 4)
        result["timed_out"] = timed_out["hit"]
        print(json.dumps(result, separators=(",", ":")), file=sys.stderr)
        print(f"study-contract-smoke FAILED: {exc}", file=sys.stderr)
        return 1
    finally:
        timer.cancel()
        if tmp_path and os.path.isfile(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        if proc.stdin:
            try:
                proc.stdin.close()
            except OSError:
                pass
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())

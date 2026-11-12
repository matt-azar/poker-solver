#!/usr/bin/env python3
"""Real-sidecar Study contract smoke (ZR-104 / audit §8).

Spawns `solver-engine` over length-prefixed protocol-2 IPC and exercises:
  ready → begin_config → solve → status → node (links + weighted strategy)
  → equity → pause/stop mid-train → checkpoint save/open/continue

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


def encode(op: str, body: Any, request_id: str, job_id: str | None = None) -> bytes:
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
    ) -> dict:
        write_req(proc, op, body, request_id, job_id)
        env = self.take(op, timeout_s=timeout_s)
        if expect_ok and not env.get("ok", False):
            raise ContractError(
                f"{env.get('error_code')}: {env.get('error_message')} ({env.get('op')})"
            )
        return env


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
        stages["status_idle"] = {
            "running": status0.get("running"),
            "phase": status0.get("phase"),
        }

        # --- begin + short solve ---
        begin = body_dict(
            inbox.rpc(proc, "begin_config", {"config_text": config_text}, "c-begin")
        )
        require("solution_id" in begin, f"begin missing solution_id: {begin}")

        t_solve = time.perf_counter()
        write_req(
            proc, "solve", {"iterations": 10}, "c-solve-10", job_id="j-contract-10"
        )
        solve10 = inbox.take("solve", timeout_s=30.0)
        require(solve10.get("ok"), f"solve failed: {solve10}")
        solve10_body = body_dict(solve10)
        require(int(solve10_body.get("trained") or 0) == 10, f"trained!=10: {solve10_body}")
        stages["solve_10"] = {
            "trained": solve10_body.get("trained"),
            "terminal_reason": solve10_body.get("terminal_reason"),
            "wall_s": round(time.perf_counter() - t_solve, 4),
            "policy_revision": solve10_body.get("policy_revision"),
        }

        status1 = body_dict(inbox.rpc(proc, "status", None, "c-status1"))
        require(status1.get("has_training") is True, f"has_training: {status1}")
        require(status1.get("can_continue") is True, f"can_continue: {status1}")
        require(status1.get("running") is False, f"running after solve: {status1}")
        require(status1.get("solution_id"), f"no solution_id: {status1}")
        stages["status_after_solve"] = {
            "has_training": status1.get("has_training"),
            "can_continue": status1.get("can_continue"),
            "policy_revision": status1.get("policy_revision"),
            "phase": status1.get("phase"),
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

        def wait_until_training(label: str, *, timeout_s: float = 5.0) -> None:
            """Wait until session phase is training.

            `running` flips when the host sets train_running, which can precede
            Session.phase=.training; pause() still rejects phase=.paused (begin).
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
                if st.get("phase") == "training":
                    return
                if inbox.pending:
                    for env in inbox.pending:
                        if env.get("op") == "solve":
                            raise ContractError(
                                f"{label}: solve finished before phase=training: {env}"
                            )
                time.sleep(0.001)
            raise ContractError(f"{label}: phase never became training")

        # --- pause mid-train, then stop (cancel) mid-train ---
        inbox.rpc(proc, "begin_config", {"config_text": config_text}, "c-begin-pause")
        write_req(
            proc,
            "solve",
            {"iterations": long_iters},
            "c-solve-pause",
            job_id="j-contract-pause",
        )
        wait_until_training("pause")
        write_req(proc, "pause", None, "c-pause")
        pause_env = inbox.take("pause", timeout_s=10.0)
        require(pause_env.get("ok"), f"pause failed: {pause_env}")
        solve_pause = inbox.take("solve", timeout_s=45.0)
        require(solve_pause.get("ok"), f"paused solve failed: {solve_pause}")
        pause_body = body_dict(solve_pause)
        require(
            pause_body.get("terminal_reason") == "paused",
            f"expected paused terminal: {pause_body}",
        )
        trained_paused = int(pause_body.get("trained") or 0)
        require(
            0 < trained_paused < long_iters,
            f"pause did not stop early: {pause_body}",
        )

        status_paused = body_dict(inbox.rpc(proc, "status", None, "c-status-paused"))
        require(status_paused.get("running") is False, f"still running: {status_paused}")

        write_req(
            proc,
            "solve",
            {"iterations": long_iters},
            "c-solve-stop",
            job_id="j-contract-stop",
        )
        wait_until_training("stop")
        write_req(proc, "cancel", None, "c-cancel", job_id="j-contract-stop")
        cancel_env = inbox.take("cancel", timeout_s=10.0)
        require(cancel_env.get("ok"), f"cancel failed: {cancel_env}")
        require(
            body_dict(cancel_env).get("cancelled") is True,
            f"cancel body: {cancel_env}",
        )
        solve_stop = inbox.take("solve", timeout_s=45.0)
        require(solve_stop.get("ok"), f"stopped solve failed: {solve_stop}")
        stop_body = body_dict(solve_stop)
        require(
            stop_body.get("terminal_reason") == "cancelled",
            f"expected cancelled terminal: {stop_body}",
        )
        trained_stopped = int(stop_body.get("trained") or 0)
        require(
            trained_stopped < trained_paused + long_iters,
            f"stop did not stop early: {stop_body}",
        )
        stages["pause_stop"] = {
            "pause_trained": trained_paused,
            "stop_trained": trained_stopped,
            "pause_terminal": pause_body.get("terminal_reason"),
            "stop_terminal": stop_body.get("terminal_reason"),
        }

        # Fresh job after stop must admit.
        write_req(
            proc,
            "solve",
            {"iterations": 1},
            "c-solve-fresh",
            job_id="j-contract-fresh",
        )
        fresh_env = inbox.take("solve", timeout_s=15.0)
        require(fresh_env.get("ok"), f"fresh after stop failed: {fresh_env}")
        stages["fresh_after_stop"] = body_dict(fresh_env)

        # --- checkpoint save / open / continue (10 + 5 → trained 15) ---
        inbox.rpc(proc, "begin_config", {"config_text": config_text}, "c-begin-ckpt")
        write_req(proc, "solve", {"iterations": 10}, "c-ckpt-10", job_id="j-ckpt-10")
        ckpt10 = inbox.take("solve", timeout_s=30.0)
        require(ckpt10.get("ok"), f"ckpt solve10: {ckpt10}")
        require(int(body_dict(ckpt10).get("trained") or 0) == 10, "ckpt trained!=10")

        fd, tmp_path = tempfile.mkstemp(prefix="zr104-", suffix=".psol")
        os.close(fd)
        save_env = inbox.rpc(proc, "save", {"path": tmp_path}, "c-save")
        require(body_dict(save_env).get("saved") is True, f"save: {save_env}")

        open_env = inbox.rpc(proc, "open", {"path": tmp_path}, "c-open")
        open_body = body_dict(open_env)
        require(open_body.get("can_continue") is True, f"open can_continue: {open_body}")
        require(open_body.get("has_training") is True, f"open has_training: {open_body}")
        require("status_generation" in open_body, "open missing status_generation")

        write_req(proc, "solve", {"iterations": 5}, "c-ckpt-5", job_id="j-ckpt-5")
        ckpt15 = inbox.take("solve", timeout_s=30.0)
        require(ckpt15.get("ok"), f"ckpt continue: {ckpt15}")
        ckpt15_body = body_dict(ckpt15)
        require(
            int(ckpt15_body.get("trained") or 0) == 15,
            f"continue trained!=15: {ckpt15_body}",
        )
        stages["checkpoint"] = {
            "trained_after_open_continue": ckpt15_body.get("trained"),
            "can_continue_on_open": open_body.get("can_continue"),
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

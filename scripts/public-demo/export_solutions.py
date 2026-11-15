#!/usr/bin/env python3
"""Export precomputed Study solutions for the public browser demo.

Spawns Zig solver-engine (protocol 2), solves two street-config fixtures, walks
every node, and writes split JSON so the flop initial view only downloads the
root pack (+ catalog/manifest).

River also applies one named lock preset via put_lock + resolve_locked and
exports a second variant pack.

Usage:
  zig build -Doptimize=ReleaseFast -Dcpu=x86_64_v2
  python3 scripts/public-demo/export_solutions.py

Outputs under desktop/public/demo/ (served as /demo/… by Vite).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BINARY = ROOT / "zig-out/bin/solver-engine"
if os.name == "nt" and not DEFAULT_BINARY.is_file():
    DEFAULT_BINARY = ROOT / "zig-out/bin/solver-engine.exe"
CONFIG_DIR = Path(__file__).resolve().parent / "configs"
OUT_DIR = ROOT / "desktop/public/demo"


class ExportError(RuntimeError):
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
        raise ExportError("solver-engine pipe closed (no length prefix)")
    (n,) = struct.unpack("<I", hdr)
    payload = stdout.read(n)
    if not payload or len(payload) < n:
        raise ExportError("solver-engine pipe closed (truncated payload)")
    env = json.loads(payload)
    if env.get("kind") == "progress":
        return read_frame(stdout)
    if env.get("kind") != "reply":
        raise ExportError(f"unexpected kind: {env!r}")
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
    raise ExportError(f"unexpected body type: {type(body)}")


class ReplyInbox:
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
                raise ExportError(f"timeout waiting for op={op!r}; pending={ops}")
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
        timeout_s: float = 60.0,
    ) -> dict:
        write_req(proc, op, body, request_id, job_id)
        env = self.take(op, timeout_s=timeout_s)
        if expect_ok and not env.get("ok", False):
            raise ExportError(
                f"{env.get('error_code')}: {env.get('error_message')} ({env.get('op')})"
            )
        return env


def admit_train(
    inbox: ReplyInbox,
    proc: subprocess.Popen,
    op: str,
    body: dict,
    request_id: str,
    job_id: str,
) -> dict:
    write_req(proc, op, body, request_id, job_id=job_id)
    env = inbox.take(op, timeout_s=30.0)
    if not env.get("ok"):
        raise ExportError(f"{op} admit failed: {env}")
    admit = body_dict(env)
    if admit.get("accepted") is not True or admit.get("running") is not True:
        raise ExportError(f"{op} short-admit shape: {admit}")
    return admit


def wait_until_idle(
    inbox: ReplyInbox,
    proc: subprocess.Popen,
    label: str,
    *,
    timeout_s: float = 120.0,
) -> dict:
    deadline = time.perf_counter() + timeout_s
    n = 0
    last: dict = {}
    while time.perf_counter() < deadline:
        last = body_dict(
            inbox.rpc(proc, "status", None, f"wait-{label}-{n}", timeout_s=10.0)
        )
        n += 1
        if last.get("running") is False:
            if last.get("failed"):
                raise ExportError(f"{label}: train failed: {last}")
            return last
        time.sleep(0.01)
    raise ExportError(f"{label}: timed out waiting for idle; last={last}")


def node_file_name(node_id: str) -> str:
    # Keep readable ids; encode path-unsafe chars only.
    safe = re.sub(r"[^\w.\-]+", "_", node_id)
    return f"{safe}.json"


def child_node_ids(node: dict) -> list[str]:
    """Collect child public-node ids from a host `node` body.

    Zig Study `formatNodeBody` emits:
      - decision: `children` as a string[] parallel to `actions`
      - chance: `cards[]` with `{card, child_id, weight}` (children often empty)
    Older / desktop-normalized shapes may use `{node_id, …}` objects — accept both.
    """
    ids: list[str] = []
    for child in node.get("children") or []:
        if isinstance(child, str) and child:
            ids.append(child)
        elif isinstance(child, dict):
            nid = child.get("node_id") or child.get("child_id")
            if isinstance(nid, str) and nid:
                ids.append(nid)
    for card in node.get("cards") or []:
        if not isinstance(card, dict):
            continue
        nid = card.get("child_id") or card.get("node_id")
        if isinstance(nid, str) and nid:
            ids.append(nid)
    return ids


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def export_tree(
    inbox: ReplyInbox,
    proc: subprocess.Popen,
    pack_dir: Path,
    *,
    root_id: str,
    request_prefix: str,
    max_chance_children: int | None = None,
) -> dict[str, Any]:
    """BFS walk: write node/values/equity per node. Returns smoke expected slice.

    Decision/terminal children are always followed. Chance fan-out (turn/river
    deals on flop trees) is capped by ``max_chance_children`` so the committed
    pack stays demo-sized; the chance node JSON still lists every card link,
    and ``index.json`` records which card children were materialized.
    """
    nodes_dir = pack_dir / "nodes"
    values_dir = pack_dir / "values"
    equity_dir = pack_dir / "equity"
    if pack_dir.exists():
        shutil.rmtree(pack_dir)
    pack_dir.mkdir(parents=True)

    queue = [root_id]
    seen: set[str] = set()
    index: list[str] = []
    expected: dict[str, Any] = {"nodes": {}}
    chance_samples: dict[str, list[str]] = {}

    while queue:
        node_id = queue.pop(0)
        if node_id in seen:
            continue
        seen.add(node_id)
        index.append(node_id)

        node = body_dict(
            inbox.rpc(
                proc,
                "node",
                {"node_id": node_id},
                f"{request_prefix}-node-{len(index)}",
            )
        )
        fname = node_file_name(node_id)
        write_json(nodes_dir / fname, node)

        kind = node.get("kind")
        values: dict[str, Any] | None = None
        equity: dict[str, Any] | None = None
        # Decision nodes get full Study inspect packs. Chance/terminal skip
        # values/equity (host analysis is decision-scoped; UI only needs links).
        if kind == "decision":
            values = body_dict(
                inbox.rpc(
                    proc,
                    "values",
                    {"node_id": node_id},
                    f"{request_prefix}-values-{len(index)}",
                    timeout_s=120.0,
                )
            )
            equity = body_dict(
                inbox.rpc(
                    proc,
                    "equity",
                    {"node_id": node_id},
                    f"{request_prefix}-equity-{len(index)}",
                    timeout_s=120.0,
                )
            )
            write_json(values_dir / fname, values)
            write_json(equity_dir / fname, equity)

        expected["nodes"][node_id] = {
            "kind": kind,
            "actions": node.get("actions"),
            "action_frequencies": node.get("action_frequencies"),
            "combos": node.get("combos"),
            "node_ev": None if values is None else values.get("node_ev"),
            "value": None if values is None else values.get("value"),
            "action_ev": None if values is None else values.get("action_ev"),
        }

        if kind == "chance":
            card_ids: list[str] = []
            for card in node.get("cards") or []:
                if isinstance(card, dict):
                    cid = card.get("child_id") or card.get("node_id")
                    if isinstance(cid, str) and cid:
                        card_ids.append(cid)
            if max_chance_children is not None:
                follow = card_ids[: max(0, max_chance_children)]
            else:
                follow = card_ids
            chance_samples[node_id] = follow
            for child_id in follow:
                if child_id not in seen:
                    queue.append(child_id)
            # Also follow any non-card children string links (usually empty).
            for child in node.get("children") or []:
                if isinstance(child, str) and child and child not in seen:
                    queue.append(child)
        else:
            for child_id in child_node_ids(node):
                if child_id not in seen:
                    queue.append(child_id)

    status = body_dict(inbox.rpc(proc, "status", None, f"{request_prefix}-status-final"))
    locks = body_dict(inbox.rpc(proc, "list_locks", None, f"{request_prefix}-locks"))
    write_json(pack_dir / "status.json", status)
    write_json(pack_dir / "locks.json", locks)
    write_json(
        pack_dir / "index.json",
        {
            "root_node_id": root_id,
            "nodes": index,
            "max_chance_children": max_chance_children,
            "chance_children_exported": chance_samples,
        },
    )
    write_json(pack_dir / "expected.json", expected)
    return {
        "node_count": len(index),
        "root_node_id": root_id,
        "status": status,
        "chance_samples": chance_samples,
    }


def git_sha() -> str:
    try:
        return (
            subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
            ).strip()
        )
    except Exception:
        return "unknown"


def parse_board_ranges(config_text: str) -> dict[str, Any]:
    out: dict[str, Any] = {
        "board": None,
        "pot": None,
        "stack": None,
        "oop_range": None,
        "ip_range": None,
        "bet_sizes": {},
    }
    for line in config_text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        key, value = parts[0], parts[1]
        if key == "board":
            out["board"] = value.split()
        elif key == "pot":
            out["pot"] = float(value)
        elif key == "stack":
            out["stack"] = float(value)
        elif key == "oop-range":
            out["oop_range"] = value
        elif key == "ip-range":
            out["ip_range"] = value
        elif key.endswith("-bets") or key.endswith("-raises"):
            out["bet_sizes"][key] = value
    return out


def spawn_engine(binary: Path) -> tuple[subprocess.Popen, ReplyInbox]:
    proc = subprocess.Popen(
        [str(binary), "--launch-id", "public-demo-export"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    inbox = ReplyInbox(proc.stdout)
    ready = body_dict(inbox.rpc(proc, "ready", None, "ready"))
    if ready.get("sidecar") != "solver-engine":
        raise ExportError(f"unexpected ready: {ready}")
    return proc, inbox


def solve_config(
    inbox: ReplyInbox,
    proc: subprocess.Popen,
    config_text: str,
    *,
    iterations: int,
    label: str,
) -> dict:
    begin = body_dict(
        inbox.rpc(
            proc,
            "begin_config",
            {"config_text": config_text},
            f"{label}-begin",
            timeout_s=60.0,
        )
    )
    job_id = f"{label}-job"
    admit_train(
        inbox,
        proc,
        "solve",
        {"iterations": iterations},
        f"{label}-solve",
        job_id,
    )
    status = wait_until_idle(inbox, proc, label, timeout_s=180.0)
    status["begin_solution_id"] = begin.get("solution_id")
    return status


def export_flop(
    inbox: ReplyInbox,
    proc: subprocess.Popen,
    *,
    iterations: int,
    engine_sha: str,
    max_chance_children: int,
) -> dict:
    config_path = CONFIG_DIR / "flop-explore.txt"
    config_text = config_path.read_text(encoding="utf-8")
    meta = parse_board_ranges(config_text)
    status = solve_config(
        inbox, proc, config_text, iterations=iterations, label="flop"
    )
    root_id = status.get("root_node_id") or "p0.t-1.r-1"
    example_dir = OUT_DIR / "flop-explore"
    if example_dir.exists():
        shutil.rmtree(example_dir)
    pack = export_tree(
        inbox,
        proc,
        example_dir / "baseline",
        root_id=root_id,
        request_prefix="flop",
        max_chance_children=max_chance_children,
    )
    manifest = {
        "schema": "public-demo-manifest/v1",
        "id": "flop-explore",
        "title": "Flop explore",
        "label": "Precomputed",
        "street": "flop",
        "description": (
            "Tiny flop tree for browsing branches, combos, EV, and equity. "
            "Chance (turn/river) fan-out is sampled so the pack stays small; "
            "each chance node still lists every card link."
        ),
        "config_path": str(config_path.relative_to(ROOT)),
        "engine_build_sha": engine_sha,
        "iterations": iterations,
        "max_chance_children": max_chance_children,
        "root_node_id": root_id,
        "ev_units": "chips",
        "equity_units": "fraction of the pot",
        "utility_basis": "local",
        "combo_weights": "reach / marginal from host node body (acting-seat)",
        "action_labels": "host Study labels (Check, Bet N, Raise N, Fold, Call, all-in)",
        "chunk_layout": {
            "nodes": "baseline/nodes/<node_id>.json — one public node per file",
            "values": "baseline/values/<node_id>.json — decision nodes only",
            "equity": "baseline/equity/<node_id>.json — decision nodes only",
            "initial_view": [
                "catalog.json",
                "flop-explore/manifest.json",
                "flop-explore/baseline/status.json",
                "flop-explore/baseline/index.json",
                f"flop-explore/baseline/nodes/{node_file_name(root_id)}",
                f"flop-explore/baseline/values/{node_file_name(root_id)}",
                f"flop-explore/baseline/equity/{node_file_name(root_id)}",
            ],
        },
        "default_variant": "baseline",
        "variants": [
            {
                "id": "baseline",
                "title": "Baseline",
                "description": "Solved equilibrium (no locks).",
                "pack": "baseline",
            }
        ],
        **meta,
        "node_count": pack["node_count"],
        "export_command": (
            "zig build -Doptimize=ReleaseFast -Dcpu=x86_64_v2 && "
            "python3 scripts/public-demo/export_solutions.py"
        ),
    }
    write_json(example_dir / "manifest.json", manifest)
    # Keep inputs next to the pack for regeneration without hunting scripts/.
    (example_dir / "inputs").mkdir(parents=True, exist_ok=True)
    shutil.copy2(config_path, example_dir / "inputs" / "flop-explore.txt")
    return manifest


def export_river(
    inbox: ReplyInbox,
    proc: subprocess.Popen,
    *,
    iterations: int,
    resolve_iterations: int,
    engine_sha: str,
) -> dict:
    config_path = CONFIG_DIR / "river-lock.txt"
    config_text = config_path.read_text(encoding="utf-8")
    meta = parse_board_ranges(config_text)
    status = solve_config(
        inbox, proc, config_text, iterations=iterations, label="river"
    )
    root_id = status.get("root_node_id") or "p0.t-1.r-1"
    example_dir = OUT_DIR / "river-lock"
    if example_dir.exists():
        shutil.rmtree(example_dir)

    baseline = export_tree(
        inbox,
        proc,
        example_dir / "baseline",
        root_id=root_id,
        request_prefix="river-base",
        max_chance_children=None,
    )

    root_node = body_dict(
        inbox.rpc(proc, "node", {"node_id": root_id}, "river-lock-root")
    )
    actions = root_node.get("actions") or []
    if not actions:
        raise ExportError("river root has no actions for lock preset")
    # Named preset: force OOP root to always take the first action (Check).
    probs = [0.0] * len(actions)
    probs[0] = 1.0
    lock_body = {
        "node_id": root_id,
        "kind": "full",
        "scope": "node",
        "probs": probs,
    }
    put = body_dict(
        inbox.rpc(proc, "put_lock", lock_body, "river-put-lock")
    )
    job_id = "river-resolve-job"
    admit_train(
        inbox,
        proc,
        "resolve_locked",
        {"iterations": resolve_iterations, "warm_start": 0},
        "river-resolve",
        job_id,
    )
    locked_status = wait_until_idle(inbox, proc, "river-resolve", timeout_s=180.0)
    locked = export_tree(
        inbox,
        proc,
        example_dir / "oop-always-check",
        root_id=root_id,
        request_prefix="river-locked",
        max_chance_children=None,
    )
    write_json(
        example_dir / "oop-always-check" / "lock_preset.json",
        {
            "id": "oop-always-check",
            "title": "OOP always Check",
            "description": (
                "Locks the OOP root decision to 100% Check, then re-solves with "
                "resolve_locked (warm_start=0)."
            ),
            "put_lock": lock_body,
            "list_locks_after_put": put,
            "resolve_iterations": resolve_iterations,
            "status_after_resolve": {
                "solution_id": locked_status.get("solution_id"),
                "baseline_solution_id": locked_status.get("baseline_solution_id"),
                "policy_revision": locked_status.get("policy_revision"),
                "iterations": locked_status.get("iterations"),
            },
        },
    )

    manifest = {
        "schema": "public-demo-manifest/v1",
        "id": "river-lock",
        "title": "River node locking",
        "label": "Precomputed",
        "street": "river",
        "description": (
            "River solution with a baseline equilibrium and one named lock preset "
            "(OOP always Check) produced by put_lock + resolve_locked."
        ),
        "config_path": str(config_path.relative_to(ROOT)),
        "engine_build_sha": engine_sha,
        "iterations": iterations,
        "resolve_iterations": resolve_iterations,
        "root_node_id": root_id,
        "ev_units": "chips",
        "equity_units": "fraction of the pot",
        "utility_basis": "local",
        "combo_weights": "reach / marginal from host node body (acting-seat)",
        "action_labels": "host Study labels (Check, Bet N, Raise N, Fold, Call, all-in)",
        "chunk_layout": {
            "nodes": "<variant>/nodes/<node_id>.json",
            "values": "<variant>/values/<node_id>.json — decision nodes only",
            "equity": "<variant>/equity/<node_id>.json — decision nodes only",
            "lock_preset": "oop-always-check/lock_preset.json",
            "initial_view": [
                "catalog.json",
                "river-lock/manifest.json",
                "river-lock/baseline/status.json",
                "river-lock/baseline/index.json",
                f"river-lock/baseline/nodes/{node_file_name(root_id)}",
                f"river-lock/baseline/values/{node_file_name(root_id)}",
                f"river-lock/baseline/equity/{node_file_name(root_id)}",
            ],
        },
        "default_variant": "baseline",
        "variants": [
            {
                "id": "baseline",
                "title": "Baseline",
                "description": "Solved equilibrium before locking.",
                "pack": "baseline",
            },
            {
                "id": "oop-always-check",
                "title": "OOP always Check",
                "description": "Root locked to 100% Check; IP re-solved against the lock.",
                "pack": "oop-always-check",
            },
        ],
        **meta,
        "node_count_baseline": baseline["node_count"],
        "node_count_locked": locked["node_count"],
        "export_command": (
            "zig build -Doptimize=ReleaseFast -Dcpu=x86_64_v2 && "
            "python3 scripts/public-demo/export_solutions.py"
        ),
    }
    write_json(example_dir / "manifest.json", manifest)
    (example_dir / "inputs").mkdir(parents=True, exist_ok=True)
    shutil.copy2(config_path, example_dir / "inputs" / "river-lock.txt")
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("binary", nargs="?", type=Path, default=DEFAULT_BINARY)
    ap.add_argument("--iterations", type=int, default=40)
    ap.add_argument("--resolve-iterations", type=int, default=40)
    ap.add_argument(
        "--max-chance-children",
        type=int,
        default=2,
        help=(
            "Flop only: max card children to materialize under each chance node "
            "(default 2). River has no chance nodes. Use 0 to stop at chance stubs."
        ),
    )
    ap.add_argument("--out", type=Path, default=None)
    args = ap.parse_args()

    binary: Path = args.binary
    if not binary.is_file():
        print(f"missing solver-engine: {binary}", file=sys.stderr)
        return 2

    global OUT_DIR
    if args.out is not None:
        OUT_DIR = args.out
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    engine_sha = git_sha()
    proc, inbox = spawn_engine(binary)
    try:
        flop = export_flop(
            inbox,
            proc,
            iterations=args.iterations,
            engine_sha=engine_sha,
            max_chance_children=args.max_chance_children,
        )
        river = export_river(
            inbox,
            proc,
            iterations=args.iterations,
            resolve_iterations=args.resolve_iterations,
            engine_sha=engine_sha,
        )
        catalog = {
            "schema": "public-demo-catalog/v1",
            "version": 1,
            "label": "Precomputed",
            "engine_build_sha": engine_sha,
            "schema_path": "desktop/public-demo/schema/manifest.v1.schema.json",
            "download_windows_url": (
                "https://github.com/matt-azar/poker-solver/releases/latest/"
                "download/Holdem-Study-windows-x64-setup.exe"
            ),
            "default_example": "flop-explore",
            "examples": [
                {
                    "id": flop["id"],
                    "title": flop["title"],
                    "street": flop["street"],
                    "description": flop["description"],
                    "path": "flop-explore/manifest.json",
                },
                {
                    "id": river["id"],
                    "title": river["title"],
                    "street": river["street"],
                    "description": river["description"],
                    "path": "river-lock/manifest.json",
                },
            ],
            "export_command": flop["export_command"],
            "follow_up": (
                "Live browser solving is out of scope for this demo; "
                "desktop Tauri + solver-engine remains the live path."
            ),
        }
        write_json(OUT_DIR / "catalog.json", catalog)
        print(json.dumps({"ok": True, "catalog": catalog}, indent=2))
        return 0
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())

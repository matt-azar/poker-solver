# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Hard bounds for the limited river browser-solving beta.

Prefer root-cause caps (board length, memory-mib, iterations, concurrency)
over timeout bumps. Turn/flop live solving is out of scope until metrics
from this river beta are reviewed.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RiverBetaBounds:
    """Service-level limits (env overrides for ops, not per-visitor)."""

    max_concurrent_sessions: int = 4
    max_session_idle_sec: float = 300.0
    max_memory_mib: int = 256
    default_memory_mib: int = 64
    max_iterations: int = 200
    default_iterations: int = 50
    max_time_limit_sec: float = 30.0
    default_time_limit_sec: float = 15.0
    max_threads: int = 1
    max_weighted_combos_per_player: int = 24
    max_river_bet_sizes: int = 2
    max_raises: int = 1
    # Tree / plan_memory soft gate before begin_config (bytes). 0 = skip.
    max_plan_memory_bytes: int = 48 * 1024 * 1024
    session_cookie_name: str = "river_beta_sid"

    @classmethod
    def from_environ(cls) -> "RiverBetaBounds":
        def _int(name: str, default: int) -> int:
            raw = os.environ.get(name)
            if raw is None or not raw.strip():
                return default
            return int(raw)

        def _float(name: str, default: float) -> float:
            raw = os.environ.get(name)
            if raw is None or not raw.strip():
                return default
            return float(raw)

        return cls(
            max_concurrent_sessions=_int(
                "RIVER_BETA_MAX_SESSIONS", cls.max_concurrent_sessions
            ),
            max_session_idle_sec=_float(
                "RIVER_BETA_SESSION_IDLE_SEC", cls.max_session_idle_sec
            ),
            max_memory_mib=_int("RIVER_BETA_MAX_MEMORY_MIB", cls.max_memory_mib),
            default_memory_mib=_int(
                "RIVER_BETA_DEFAULT_MEMORY_MIB", cls.default_memory_mib
            ),
            max_iterations=_int("RIVER_BETA_MAX_ITERATIONS", cls.max_iterations),
            default_iterations=_int(
                "RIVER_BETA_DEFAULT_ITERATIONS", cls.default_iterations
            ),
            max_time_limit_sec=_float(
                "RIVER_BETA_MAX_TIME_LIMIT_SEC", cls.max_time_limit_sec
            ),
            default_time_limit_sec=_float(
                "RIVER_BETA_DEFAULT_TIME_LIMIT_SEC", cls.default_time_limit_sec
            ),
            max_threads=_int("RIVER_BETA_MAX_THREADS", cls.max_threads),
            max_weighted_combos_per_player=_int(
                "RIVER_BETA_MAX_COMBOS", cls.max_weighted_combos_per_player
            ),
            max_river_bet_sizes=_int(
                "RIVER_BETA_MAX_RIVER_BETS", cls.max_river_bet_sizes
            ),
            max_raises=_int("RIVER_BETA_MAX_RAISES", cls.max_raises),
            max_plan_memory_bytes=_int(
                "RIVER_BETA_MAX_PLAN_MEMORY_BYTES", cls.max_plan_memory_bytes
            ),
        )


class BoundsError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


_BOARD_RE = re.compile(r"(?im)^\s*board\s+(.+?)\s*$")
_KEY_RE = re.compile(r"(?im)^\s*([a-z0-9\-]+)\s+(.+?)\s*$")
_COMBO_SPLIT = re.compile(r"\s*,\s*")

# Ops the HTTP→IPC proxy may forward. Train/browse/lock only — no save/open
# to arbitrary host paths, no equity calculator jobs.
ALLOWED_IPC_OPS: frozenset[str] = frozenset(
    {
        "ready",
        "status",
        "begin_config",
        "solve",
        "pause",
        "cancel",
        "node",
        "values",
        "equity",
        "categories",
        "list_locks",
        "put_lock",
        "delete_lock",
        "resolve_locked",
        "list_strategy_edits",
        "put_strategy_edit",
        "delete_strategy_edit",
        "get_config",
        "tree_preview",
        "plan_memory",
        "prioritize_analysis",
    }
)


def parse_street_config_lines(config_text: str) -> dict[str, str]:
    lines = config_text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if not lines or lines[0].strip() != "street-config 1":
        raise BoundsError(
            "invalid_config",
            "config must start with 'street-config 1'",
        )
    out: dict[str, str] = {}
    for line in lines[1:]:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = _KEY_RE.match(stripped)
        if not m:
            raise BoundsError("invalid_config", f"bad street-config line: {stripped!r}")
        out[m.group(1).lower()] = m.group(2).strip()
    return out


def board_card_count(config_text: str) -> int:
    m = _BOARD_RE.search(config_text)
    if not m:
        raise BoundsError("invalid_config", "board line required")
    tokens = [t for t in m.group(1).split() if t]
    return len(tokens)


def count_weighted_combos(range_text: str) -> int:
    if not range_text.strip():
        return 0
    return len([p for p in _COMBO_SPLIT.split(range_text.strip()) if p])


def count_bet_sizes(value: str) -> int:
    if not value.strip():
        return 0
    # Empty arrays / check-only: single token that is empty already handled.
    parts = re.split(r"[\s,]+", value.strip())
    return len([p for p in parts if p])


def enforce_river_only(config_text: str, bounds: RiverBetaBounds) -> dict[str, str]:
    """Validate + normalize a street-config for the river beta."""
    fields = parse_street_config_lines(config_text)
    n_board = board_card_count(config_text)
    if n_board != 5:
        raise BoundsError(
            "river_only",
            f"river beta requires a 5-card board (got {n_board}); "
            "turn/flop live solving is out of scope",
        )

    # Reject explicit flop/turn sizing that would imply a multi-street tree
    # if someone later swaps the board — keep the beta surface river-shaped.
    for banned in (
        "oop-flop-bets",
        "ip-flop-bets",
        "oop-turn-bets",
        "ip-turn-bets",
        "oop-donk-bets",
        "ip-donk-bets",
    ):
        if banned in fields and fields[banned].strip():
            raise BoundsError(
                "river_only",
                f"{banned} is not allowed in the river beta",
            )

    for key in ("oop-range", "ip-range"):
        n = count_weighted_combos(fields.get(key, ""))
        if n == 0:
            raise BoundsError("invalid_config", f"{key} required")
        if n > bounds.max_weighted_combos_per_player:
            raise BoundsError(
                "tree_bound",
                f"{key} has {n} combos; max is {bounds.max_weighted_combos_per_player}",
            )

    for key in ("oop-river-bets", "ip-river-bets"):
        if key in fields:
            n = count_bet_sizes(fields[key])
            if n > bounds.max_river_bet_sizes:
                raise BoundsError(
                    "tree_bound",
                    f"{key} has {n} sizes; max is {bounds.max_river_bet_sizes}",
                )

    if "max-raises" in fields:
        try:
            raises = int(fields["max-raises"])
        except ValueError as exc:
            raise BoundsError("invalid_config", "max-raises must be an integer") from exc
        if raises > bounds.max_raises:
            raise BoundsError(
                "tree_bound",
                f"max-raises {raises} exceeds beta cap {bounds.max_raises}",
            )

    memory_mib = bounds.default_memory_mib
    if "memory-mib" in fields:
        try:
            memory_mib = int(fields["memory-mib"])
        except ValueError as exc:
            raise BoundsError("invalid_config", "memory-mib must be an integer") from exc
    if memory_mib <= 0 or memory_mib > bounds.max_memory_mib:
        raise BoundsError(
            "memory_bound",
            f"memory-mib must be 1..{bounds.max_memory_mib} (got {memory_mib})",
        )
    fields["memory-mib"] = str(memory_mib)

    threads = 1
    if "threads" in fields:
        try:
            threads = int(fields["threads"])
        except ValueError as exc:
            raise BoundsError("invalid_config", "threads must be an integer") from exc
    if threads < 1 or threads > bounds.max_threads:
        raise BoundsError(
            "thread_bound",
            f"threads must be 1..{bounds.max_threads} (got {threads})",
        )
    fields["threads"] = str(threads)
    return fields


def rewrite_config_with_caps(config_text: str, fields: dict[str, str]) -> str:
    """Re-emit street-config 1 with enforced memory-mib / threads."""
    lines = ["street-config 1"]
    # Preserve original key order where possible; overlay caps.
    seen: set[str] = set()
    for raw in config_text.replace("\r\n", "\n").replace("\r", "\n").split("\n")[1:]:
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = _KEY_RE.match(stripped)
        if not m:
            continue
        key = m.group(1).lower()
        seen.add(key)
        if key in ("memory-mib", "threads"):
            lines.append(f"{key} {fields[key]}")
        else:
            lines.append(f"{key} {m.group(2).strip()}")
    for key in ("memory-mib", "threads"):
        if key not in seen:
            lines.append(f"{key} {fields[key]}")
    return "\n".join(lines) + "\n"


def clamp_solve_params(
    body: dict[str, Any] | None,
    bounds: RiverBetaBounds,
) -> dict[str, Any]:
    src = body or {}
    try:
        iterations = int(src.get("iterations", bounds.default_iterations))
    except (TypeError, ValueError) as exc:
        raise BoundsError("invalid_request", "iterations must be an integer") from exc
    if iterations < 1 or iterations > bounds.max_iterations:
        raise BoundsError(
            "runtime_bound",
            f"iterations must be 1..{bounds.max_iterations} (got {iterations})",
        )

    time_limit = src.get("time_limit", bounds.default_time_limit_sec)
    if time_limit is None:
        time_limit = bounds.default_time_limit_sec
    try:
        time_limit_f = float(time_limit)
    except (TypeError, ValueError) as exc:
        raise BoundsError("invalid_request", "time_limit must be a number") from exc
    if time_limit_f < 0:
        # Host uses <0 as unlimited — never allow that in the beta.
        raise BoundsError("runtime_bound", "time_limit must be >= 0")
    if time_limit_f > bounds.max_time_limit_sec:
        raise BoundsError(
            "runtime_bound",
            f"time_limit must be <= {bounds.max_time_limit_sec}s",
        )

    out: dict[str, Any] = {
        "iterations": iterations,
        "time_limit": time_limit_f,
    }
    if "accuracy" in src and src["accuracy"] is not None:
        try:
            out["accuracy"] = float(src["accuracy"])
        except (TypeError, ValueError) as exc:
            raise BoundsError("invalid_request", "accuracy must be a number") from exc
    if "eval_every" in src and src["eval_every"] is not None:
        try:
            out["eval_every"] = int(src["eval_every"])
        except (TypeError, ValueError) as exc:
            raise BoundsError("invalid_request", "eval_every must be an integer") from exc
    return out

# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Isolated river-beta sessions: one visitor → one solver-engine process."""

from __future__ import annotations

import logging
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from bounds import (
    ALLOWED_IPC_OPS,
    BoundsError,
    RiverBetaBounds,
    clamp_solve_params,
    enforce_river_only,
    rewrite_config_with_caps,
)
from ipc import IpcError, SolverSidecar, default_solver_engine
from metrics import SessionMetrics

log = logging.getLogger("river_beta.session")

HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = HERE / "configs" / "river_beta_default.txt"


class SessionError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class RiverSession:
    def __init__(
        self,
        session_id: str,
        bounds: RiverBetaBounds,
        *,
        engine_binary: Path | None = None,
    ) -> None:
        self.session_id = session_id
        self.bounds = bounds
        self.metrics = SessionMetrics()
        self.created_at = time.time()
        self.last_used_at = self.created_at
        self.active_job_id: str | None = None
        self._mu = threading.RLock()
        self._sidecar = SolverSidecar(
            engine_binary or default_solver_engine(),
            launch_id=f"river-beta-{session_id[:12]}",
            on_stderr_line=lambda line: log.debug("[%s] %s", session_id[:8], line),
        )
        self._started = False

    def touch(self) -> None:
        self.last_used_at = time.time()

    def start(self) -> None:
        with self._mu:
            if self._started:
                return
            self._sidecar.start()
            self._started = True
            self.metrics.sample_pid(self._sidecar.pid)
            self.touch()

    def close(self) -> None:
        with self._mu:
            self._sidecar.close()
            self._started = False

    def info(self) -> dict[str, Any]:
        self.metrics.sample_pid(self._sidecar.pid)
        now = time.time()
        idle_remaining = max(
            0.0, self.bounds.max_session_idle_sec - (now - self.last_used_at)
        )
        return {
            "session_id": self.session_id,
            "created_at": self.created_at,
            "last_used_at": self.last_used_at,
            "idle_remaining_sec": round(idle_remaining, 1),
            "alive": self._sidecar.alive,
            "pid": self._sidecar.pid,
            "launch_id": self._sidecar.launch_id,
            "active_job_id": self.active_job_id,
            "metrics": self.metrics.to_dict(),
            "street": "river",
            "bounds": self._bounds_snapshot(),
        }

    def _bounds_snapshot(self) -> dict[str, Any]:
        b = self.bounds
        return {
            "max_concurrent_sessions": b.max_concurrent_sessions,
            "max_session_idle_sec": b.max_session_idle_sec,
            "max_memory_mib": b.max_memory_mib,
            "default_memory_mib": b.default_memory_mib,
            "max_iterations": b.max_iterations,
            "default_iterations": b.default_iterations,
            "max_time_limit_sec": b.max_time_limit_sec,
            "default_time_limit_sec": b.default_time_limit_sec,
            "max_threads": b.max_threads,
            "max_weighted_combos_per_player": b.max_weighted_combos_per_player,
            "max_river_bet_sizes": b.max_river_bet_sizes,
            "max_raises": b.max_raises,
            "max_plan_memory_bytes": b.max_plan_memory_bytes,
            "summary": (
                f"river-only · ≤{b.max_iterations} iters · "
                f"≤{b.max_time_limit_sec:g}s · ≤{b.max_memory_mib} MiB · "
                f"≤{b.max_weighted_combos_per_player} combos/player · "
                f"{b.max_concurrent_sessions} sessions · "
                f"idle {b.max_session_idle_sec:g}s"
            ),
        }

    def ipc(
        self,
        op: str,
        body: Any = None,
        *,
        job_id: str | None = None,
        timeout_s: float = 120.0,
    ) -> dict[str, Any]:
        if op not in ALLOWED_IPC_OPS:
            raise SessionError("op_forbidden", f"op {op!r} is not allowed in river beta")
        with self._mu:
            self.touch()
            if not self._started:
                self.start()
            try:
                if op == "begin_config":
                    return self._begin_config(body, job_id=job_id, timeout_s=timeout_s)
                if op in ("solve", "resolve_locked"):
                    return self._train(op, body, job_id=job_id, timeout_s=timeout_s)
                if op in ("cancel", "pause"):
                    return self._control(op, job_id=job_id, timeout_s=timeout_s)
                env = self._sidecar.request(
                    op, body, job_id=job_id, timeout_s=timeout_s, expect_ok=False
                )
                self.metrics.sample_pid(self._sidecar.pid)
                return env
            except BoundsError as exc:
                self.metrics.last_error = exc.message
                raise SessionError(exc.code, exc.message) from exc
            except IpcError as exc:
                self.metrics.last_error = str(exc)
                self.metrics.sample_pid(self._sidecar.pid)
                # Surface host error envelopes when present.
                if exc.envelope:
                    return exc.envelope
                raise SessionError(exc.code, str(exc)) from exc

    def _begin_config(
        self,
        body: Any,
        *,
        job_id: str | None,
        timeout_s: float,
    ) -> dict[str, Any]:
        if not isinstance(body, dict):
            raise BoundsError("invalid_request", "begin_config body must be an object")
        config_text = body.get("config_text")
        if not isinstance(config_text, str) or not config_text.strip():
            raise BoundsError("invalid_request", "config_text required")
        fields = enforce_river_only(config_text, self.bounds)
        capped = rewrite_config_with_caps(config_text, fields)

        # Optional plan_memory preflight — refuse oversized trees before compile.
        if self.bounds.max_plan_memory_bytes > 0:
            plan = self._sidecar.request(
                "plan_memory",
                {"config_text": capped},
                timeout_s=min(timeout_s, 30.0),
                expect_ok=False,
            )
            if plan.get("ok"):
                plan_body = plan.get("body") or {}
                if isinstance(plan_body, str):
                    import json

                    plan_body = json.loads(plan_body)
                if isinstance(plan_body, dict):
                    estimated = (
                        plan_body.get("estimated_peak_bytes")
                        or plan_body.get("bytes")
                        or plan_body.get("estimated_bytes")
                        or plan_body.get("memory_bytes")
                        or plan_body.get("total_bytes")
                    )
                    if estimated is not None and int(estimated) > self.bounds.max_plan_memory_bytes:
                        raise BoundsError(
                            "tree_bound",
                            f"plan_memory estimated_peak_bytes={estimated} exceeds "
                            f"{self.bounds.max_plan_memory_bytes}",
                        )

        env = self._sidecar.request(
            "begin_config",
            {"config_text": capped},
            job_id=job_id,
            timeout_s=timeout_s,
            expect_ok=False,
        )
        self.metrics.sample_pid(self._sidecar.pid)
        return env

    def _train(
        self,
        op: str,
        body: Any,
        *,
        job_id: str | None,
        timeout_s: float,
    ) -> dict[str, Any]:
        params = clamp_solve_params(body if isinstance(body, dict) else {}, self.bounds)
        jid = job_id or f"job-{uuid.uuid4().hex[:12]}"
        self.active_job_id = jid
        started = time.perf_counter()
        env = self._sidecar.request(
            op,
            params,
            job_id=jid,
            timeout_s=min(timeout_s, 15.0),  # short-admit
            expect_ok=False,
        )
        # Short-admit only — wall time accumulates while visitor polls status.
        self.metrics.note_solve_wall(time.perf_counter() - started)
        self.metrics.sample_pid(self._sidecar.pid)
        return env

    def _control(
        self,
        op: str,
        *,
        job_id: str | None,
        timeout_s: float,
    ) -> dict[str, Any]:
        # Job-scoped: never cancel an unknown / stale id (AGENT_LESSONS).
        jid = job_id or self.active_job_id
        if not jid:
            return {
                "v": 2,
                "kind": "reply",
                "request_id": "local",
                "job_id": None,
                "op": op,
                "ok": False,
                "error_code": "not_running",
                "error_message": "no active job id for this session",
                "body": None,
            }
        env = self._sidecar.request(
            op, None, job_id=jid, timeout_s=timeout_s, expect_ok=False
        )
        self.metrics.sample_pid(self._sidecar.pid)
        return env

    def poll_until_idle(self, *, timeout_s: float = 60.0) -> dict[str, Any]:
        """Helper for smokes: poll status until not running."""
        deadline = time.monotonic() + timeout_s
        last: dict[str, Any] = {}
        while time.monotonic() < deadline:
            env = self.ipc("status", None, timeout_s=8.0)
            last = env
            body = env.get("body") or {}
            if isinstance(body, str):
                import json

                body = json.loads(body)
            if isinstance(body, dict) and not body.get("running"):
                self.metrics.sample_pid(self._sidecar.pid)
                # Attribute remaining wall to the solve once idle.
                return env
            time.sleep(0.05)
        raise SessionError("timeout", "solve did not finish within timeout")


class SessionManager:
    def __init__(
        self,
        bounds: RiverBetaBounds | None = None,
        *,
        engine_binary: Path | None = None,
    ) -> None:
        self.bounds = bounds or RiverBetaBounds.from_environ()
        self.engine_binary = engine_binary
        self._mu = threading.Lock()
        self._sessions: dict[str, RiverSession] = {}

    def create(self) -> RiverSession:
        with self._mu:
            self._reap_locked()
            if len(self._sessions) >= self.bounds.max_concurrent_sessions:
                raise SessionError(
                    "concurrency_bound",
                    f"max concurrent sessions is {self.bounds.max_concurrent_sessions}",
                )
            sid = uuid.uuid4().hex
            session = RiverSession(
                sid, self.bounds, engine_binary=self.engine_binary
            )
            session.start()
            self._sessions[sid] = session
            return session

    def get(self, session_id: str | None) -> RiverSession | None:
        if not session_id:
            return None
        with self._mu:
            self._reap_locked()
            session = self._sessions.get(session_id)
            if session:
                session.touch()
            return session

    def destroy(self, session_id: str) -> bool:
        with self._mu:
            session = self._sessions.pop(session_id, None)
        if not session:
            return False
        session.close()
        return True

    def active_count(self) -> int:
        with self._mu:
            self._reap_locked()
            return len(self._sessions)

    def list_metrics(self) -> list[dict[str, Any]]:
        with self._mu:
            self._reap_locked()
            return [s.info() for s in self._sessions.values()]

    def shutdown(self) -> None:
        with self._mu:
            ids = list(self._sessions.keys())
        for sid in ids:
            self.destroy(sid)

    def _reap_locked(self) -> None:
        now = time.time()
        idle = self.bounds.max_session_idle_sec
        dead = [
            sid
            for sid, s in self._sessions.items()
            if (now - s.last_used_at) > idle or not s._sidecar.alive
        ]
        for sid in dead:
            session = self._sessions.pop(sid, None)
            if session:
                log.info("reaping session %s", sid[:8])
                try:
                    session.close()
                except Exception:
                    pass


def load_default_config() -> str:
    return DEFAULT_CONFIG_PATH.read_text(encoding="utf-8")

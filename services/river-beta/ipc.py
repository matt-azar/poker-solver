# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Protocol-2 length-prefixed IPC client for Zig `solver-engine`.

Mirrors `scripts/zig/study-contract-smoke.py` framing. One process, one
session — demux by request_id with a background reader thread.

Framing rules (audit §8 / IPC-7):
- Exact-read and write-all loops (never assume one read/write completes a
  header, body, or frame).
- Only active request IDs are tracked; late/unknown replies are discarded.
- Close and reader failure wake every waiter.
"""

from __future__ import annotations

import json
import os
import struct
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, BinaryIO, Callable


ROOT = Path(__file__).resolve().parents[2]
PROTOCOL = 2
MAX_FRAME_BYTES = 64 * 1024 * 1024


class IpcError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "ipc_error",
        envelope: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.envelope = envelope or {}


def default_solver_engine() -> Path:
    env = os.environ.get("RIVER_BETA_SOLVER_ENGINE") or os.environ.get(
        "HOLDEM_STUDY_SOLVER_ENGINE"
    )
    candidates: list[Path] = []
    if env:
        candidates.append(Path(env).expanduser())
    candidates.extend(
        [
            ROOT / "zig-out" / "bin" / "solver-engine",
            ROOT / "zig-out" / "bin" / "solver-engine.exe",
        ]
    )
    for path in candidates:
        if path.is_file():
            return path
    return candidates[-1]


def encode_frame(
    op: str,
    body: Any,
    request_id: str,
    job_id: str | None = None,
) -> bytes:
    envelope = {
        "v": PROTOCOL,
        "kind": "request",
        "request_id": request_id,
        "job_id": job_id,
        "op": op,
        "body": body,
    }
    payload = json.dumps(envelope, separators=(",", ":")).encode()
    return struct.pack("<I", len(payload)) + payload


def read_exact(stream: BinaryIO, n: int) -> bytes:
    """Read exactly ``n`` bytes, looping across short reads."""
    if n <= 0:
        return b""
    chunks: list[bytes] = []
    remaining = n
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            raise IpcError(
                "solver-engine pipe closed (short read)",
                code="pipe_closed",
            )
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def write_all(stream: BinaryIO, data: bytes) -> None:
    """Write all bytes, looping across short writes."""
    view = memoryview(data)
    while len(view) > 0:
        n = stream.write(view)
        if n is None:
            # Non-blocking stream with no progress — treat as failure.
            raise IpcError("solver-engine stdin write returned None", code="broken_pipe")
        if n == 0:
            raise IpcError("solver-engine stdin short write (0)", code="broken_pipe")
        view = view[n:]


def read_one_frame(stdout: BinaryIO) -> dict[str, Any]:
    hdr = read_exact(stdout, 4)
    (n,) = struct.unpack("<I", hdr)
    if n <= 0 or n > MAX_FRAME_BYTES:
        raise IpcError(f"invalid frame length {n}", code="bad_frame")
    payload = read_exact(stdout, n)
    env = json.loads(payload)
    if not isinstance(env, dict):
        raise IpcError("frame JSON must be an object", code="bad_frame")
    return env


# Back-compat alias for callers/tests that imported the private name.
_read_one_frame = read_one_frame


class SolverSidecar:
    """Owns one solver-engine child and demuxes replies by request_id."""

    def __init__(
        self,
        binary: Path | None = None,
        *,
        launch_id: str | None = None,
        on_stderr_line: Callable[[str], None] | None = None,
    ) -> None:
        self.binary = Path(binary) if binary else default_solver_engine()
        self.launch_id = launch_id or f"river-beta-{uuid.uuid4().hex[:12]}"
        self._on_stderr_line = on_stderr_line
        self._proc: subprocess.Popen[bytes] | None = None
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        # Active waiters only — late replies for unknown IDs are discarded.
        self._waiters: set[str] = set()
        self._pending: dict[str, dict[str, Any]] = {}
        self._reader: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._closed = False
        self._reader_error: BaseException | None = None

    @property
    def pid(self) -> int | None:
        return self._proc.pid if self._proc else None

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def start(self, *, ready_timeout_s: float = 8.0) -> dict[str, Any]:
        if not self.binary.is_file():
            raise IpcError(
                f"solver-engine not found at {self.binary}; run zig build first",
                code="engine_missing",
            )
        self._proc = subprocess.Popen(
            [str(self.binary), "--launch-id", self.launch_id],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        self._reader = threading.Thread(target=self._read_loop, name="river-beta-ipc", daemon=True)
        self._reader.start()
        self._stderr_thread = threading.Thread(
            target=self._drain_stderr, name="river-beta-stderr", daemon=True
        )
        self._stderr_thread.start()
        return self.request("ready", None, timeout_s=ready_timeout_s)

    def close(self) -> None:
        with self._lock:
            self._closed = True
            # Wake every waiter so close cannot hang behind a long timeout.
            self._cv.notify_all()
        proc = self._proc
        self._proc = None
        if proc is None:
            return
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            try:
                if stream:
                    stream.close()
            except OSError:
                pass
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
                proc.wait(timeout=2)
            except Exception:
                pass

    def request(
        self,
        op: str,
        body: Any = None,
        *,
        job_id: str | None = None,
        timeout_s: float = 60.0,
        expect_ok: bool = True,
    ) -> dict[str, Any]:
        if not self.alive:
            raise IpcError("solver-engine is not running", code="session_dead")
        request_id = uuid.uuid4().hex
        frame = encode_frame(op, body, request_id, job_id)
        assert self._proc is not None and self._proc.stdin is not None
        with self._lock:
            if self._closed or self._reader_error is not None:
                raise IpcError(
                    f"sidecar closed: {self._reader_error}",
                    code="session_dead",
                )
            self._waiters.add(request_id)
            try:
                write_all(self._proc.stdin, frame)
                self._proc.stdin.flush()
            except Exception:
                self._waiters.discard(request_id)
                self._pending.pop(request_id, None)
                raise
            deadline = time.monotonic() + timeout_s
            try:
                while request_id not in self._pending:
                    if self._closed or self._reader_error is not None:
                        raise IpcError(
                            f"sidecar closed: {self._reader_error}",
                            code="session_dead",
                        )
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise IpcError(
                            f"timeout waiting for op={op!r} request_id={request_id}",
                            code="timeout",
                        )
                    self._cv.wait(timeout=remaining)
                env = self._pending.pop(request_id)
            finally:
                self._waiters.discard(request_id)
                self._pending.pop(request_id, None)
        if expect_ok and not env.get("ok", False):
            raise IpcError(
                env.get("error_message") or env.get("error_code") or "request failed",
                code=str(env.get("error_code") or "host_error"),
                envelope=env,
            )
        return env

    def _read_loop(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        try:
            while True:
                env = read_one_frame(self._proc.stdout)
                kind = env.get("kind")
                if kind == "progress":
                    continue
                if kind != "reply":
                    continue
                rid = env.get("request_id")
                if not isinstance(rid, str):
                    continue
                with self._lock:
                    # Discard late / unknown replies — only active waiters count.
                    if rid in self._waiters:
                        self._pending[rid] = env
                        self._cv.notify_all()
        except BaseException as exc:
            with self._lock:
                self._reader_error = exc
                self._closed = True
                self._cv.notify_all()

    def _drain_stderr(self) -> None:
        assert self._proc is not None and self._proc.stderr is not None
        try:
            for raw in iter(self._proc.stderr.readline, b""):
                line = raw.decode("utf-8", errors="replace").rstrip()
                if self._on_stderr_line:
                    self._on_stderr_line(line)
        except Exception:
            pass

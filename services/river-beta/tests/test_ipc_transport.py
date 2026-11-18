# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Unit tests for river-beta framing, late replies, and closed waiters.

No solver-engine required — uses fragmented in-memory streams and os.pipe.
"""

from __future__ import annotations

import json
import os
import struct
import sys
import threading
import time
import unittest
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from ipc import (  # noqa: E402
    IpcError,
    SolverSidecar,
    encode_frame,
    read_exact,
    read_one_frame,
    write_all,
)


class FragmentedReader:
    """BinaryIO-like reader that returns at most ``chunk`` bytes per read."""

    def __init__(self, data: bytes, chunk: int = 1) -> None:
        self._data = data
        self._pos = 0
        self._chunk = max(1, chunk)

    def read(self, n: int = -1) -> bytes:
        if self._pos >= len(self._data):
            return b""
        if n < 0:
            n = len(self._data) - self._pos
        take = min(n, self._chunk, len(self._data) - self._pos)
        out = self._data[self._pos : self._pos + take]
        self._pos += take
        return out


class FragmentedWriter:
    """BinaryIO-like writer that accepts at most ``chunk`` bytes per write."""

    def __init__(self, chunk: int = 1) -> None:
        self.buf = bytearray()
        self._chunk = max(1, chunk)

    def write(self, data: bytes | memoryview) -> int:
        view = memoryview(data).cast("B")
        n = min(len(view), self._chunk)
        self.buf.extend(view[:n])
        return n

    def flush(self) -> None:
        pass


def _frame_bytes(env: dict[str, Any]) -> bytes:
    payload = json.dumps(env, separators=(",", ":")).encode()
    return struct.pack("<I", len(payload)) + payload


class ExactReadWriteTests(unittest.TestCase):
    def test_read_exact_assembles_single_byte_chunks(self) -> None:
        payload = b"hello-world-partial"
        reader = FragmentedReader(payload, chunk=1)
        self.assertEqual(read_exact(reader, len(payload)), payload)

    def test_read_one_frame_across_header_and_body_fragments(self) -> None:
        # Reproduce the audit case: a valid status-sized payload must survive
        # fragmented reads (previously assumed one read for header/body).
        body = {"v": 2, "kind": "reply", "request_id": "r1", "op": "status", "ok": True, "body": {"running": False}}
        raw = _frame_bytes(body)
        self.assertGreater(len(raw), 4)
        reader = FragmentedReader(raw, chunk=3)
        env = read_one_frame(reader)
        self.assertEqual(env["request_id"], "r1")
        self.assertTrue(env["ok"])

    def test_read_exact_eof_raises(self) -> None:
        reader = FragmentedReader(b"abc", chunk=1)
        with self.assertRaises(IpcError) as ctx:
            read_exact(reader, 10)
        self.assertEqual(ctx.exception.code, "pipe_closed")

    def test_write_all_honors_short_writes(self) -> None:
        data = encode_frame("ready", None, "abc123")
        writer = FragmentedWriter(chunk=2)
        write_all(writer, data)
        self.assertEqual(bytes(writer.buf), data)


class SidecarLifecycleTests(unittest.TestCase):
    def _attach_pipes(self, sidecar: SolverSidecar) -> tuple[int, int, int, int]:
        """Wire stdin/stdout pipes without spawning solver-engine."""
        out_r, out_w = os.pipe()  # child stdout → reader
        in_r, in_w = os.pipe()  # writer → child stdin (drained)
        # Fake Popen-like object.
        class FakeProc:
            def __init__(self) -> None:
                self.stdin = os.fdopen(in_w, "wb", buffering=0)
                self.stdout = os.fdopen(out_r, "rb", buffering=0)
                self.stderr = open(os.devnull, "rb")
                self.pid = 0

            def poll(self) -> None:
                return None

            def terminate(self) -> None:
                pass

            def kill(self) -> None:
                pass

            def wait(self, timeout: float | None = None) -> int:
                return 0

        sidecar._proc = FakeProc()  # type: ignore[assignment]
        sidecar._closed = False
        sidecar._reader_error = None
        sidecar._reader = threading.Thread(
            target=sidecar._read_loop, name="test-ipc", daemon=True
        )
        sidecar._reader.start()

        def drain_stdin() -> None:
            with os.fdopen(in_r, "rb", buffering=0) as r:
                while True:
                    chunk = r.read(4096)
                    if not chunk:
                        break

        threading.Thread(target=drain_stdin, daemon=True).start()
        return out_r, out_w, in_r, in_w

    def test_late_reply_discarded_after_timeout(self) -> None:
        sidecar = SolverSidecar(binary=Path("/nonexistent/solver-engine"))
        _, out_w, _, _ = self._attach_pipes(sidecar)
        try:
            # No reply ever arrives → timeout; waiter unregisters.
            with self.assertRaises(IpcError) as ctx:
                sidecar.request("status", None, timeout_s=0.15)
            self.assertEqual(ctx.exception.code, "timeout")
            self.assertEqual(len(sidecar._waiters), 0)

            # Late reply for a recycled/unknown id must not stick in pending.
            late = _frame_bytes(
                {
                    "v": 2,
                    "kind": "reply",
                    "request_id": "not-a-waiter",
                    "op": "status",
                    "ok": True,
                    "body": {},
                }
            )
            # Fragment the write to also exercise the reader path.
            os.write(out_w, late[:5])
            time.sleep(0.02)
            os.write(out_w, late[5:])
            time.sleep(0.05)
            self.assertEqual(sidecar._pending, {})
        finally:
            try:
                os.close(out_w)
            except OSError:
                pass
            sidecar.close()

    def test_close_wakes_waiter(self) -> None:
        sidecar = SolverSidecar(binary=Path("/nonexistent/solver-engine"))
        _, out_w, _, _ = self._attach_pipes(sidecar)
        errors: list[BaseException] = []

        def blocked_request() -> None:
            try:
                sidecar.request("values", {"node_id": "p0.t-1.r-1"}, timeout_s=30.0)
            except BaseException as exc:  # noqa: BLE001 — capture for assertion
                errors.append(exc)

        t = threading.Thread(target=blocked_request)
        t.start()
        # Wait until the request is registered as an active waiter.
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and not sidecar._waiters:
            time.sleep(0.01)
        self.assertTrue(sidecar._waiters)
        sidecar.close()
        t.join(timeout=2.0)
        self.assertFalse(t.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], IpcError)
        self.assertEqual(errors[0].code, "session_dead")  # type: ignore[attr-defined]
        try:
            os.close(out_w)
        except OSError:
            pass

    def test_active_waiter_receives_fragmented_reply(self) -> None:
        sidecar = SolverSidecar(binary=Path("/nonexistent/solver-engine"))
        _, out_w, _, _ = self._attach_pipes(sidecar)
        result: dict[str, Any] = {}
        err: list[BaseException] = []

        def do_request() -> None:
            try:
                result["env"] = sidecar.request("ready", None, timeout_s=5.0, expect_ok=False)
            except BaseException as exc:  # noqa: BLE001
                err.append(exc)

        t = threading.Thread(target=do_request)
        t.start()
        deadline = time.monotonic() + 2.0
        rid = None
        while time.monotonic() < deadline:
            if sidecar._waiters:
                rid = next(iter(sidecar._waiters))
                break
            time.sleep(0.01)
        self.assertIsNotNone(rid)
        reply = _frame_bytes(
            {
                "v": 2,
                "kind": "reply",
                "request_id": rid,
                "op": "ready",
                "ok": True,
                "body": {"protocol": 2},
            }
        )
        # Deliver one byte at a time (exact-read under the reader thread).
        for i in range(0, len(reply), 1):
            os.write(out_w, reply[i : i + 1])
            time.sleep(0.001)
        t.join(timeout=5.0)
        self.assertFalse(err, err)
        self.assertTrue(result["env"]["ok"])
        try:
            os.close(out_w)
        except OSError:
            pass
        sidecar.close()


class SessionLockNarrowingTests(unittest.TestCase):
    def test_status_can_run_while_slow_request_holds_no_session_lock(self) -> None:
        """Long sidecar waits must not hold RiverSession._mu (status/cancel)."""
        from session import RiverSession
        from bounds import RiverBetaBounds

        session = RiverSession("testsession", RiverBetaBounds(max_plan_memory_bytes=0))
        session._started = True

        release = threading.Event()
        in_request = threading.Event()

        class SlowSidecar:
            pid = 1

            @property
            def alive(self) -> bool:
                return True

            def request(self, *_a, **_k):
                in_request.set()
                release.wait(timeout=5.0)
                return {
                    "v": 2,
                    "kind": "reply",
                    "request_id": "x",
                    "op": "values",
                    "ok": True,
                    "body": {},
                }

        session._sidecar = SlowSidecar()  # type: ignore[assignment]

        status_ok = threading.Event()

        def do_values() -> None:
            session.ipc("values", {"node_id": "root"}, timeout_s=5.0)

        def do_status() -> None:
            in_request.wait(timeout=5.0)
            # If session.ipc held _mu across the slow values call, this would block.
            acquired = session._mu.acquire(timeout=0.5)
            if acquired:
                session._mu.release()
                status_ok.set()
            release.set()

        t1 = threading.Thread(target=do_values)
        t2 = threading.Thread(target=do_status)
        t1.start()
        t2.start()
        t1.join(timeout=5.0)
        t2.join(timeout=5.0)
        self.assertTrue(status_ok.is_set(), "session lock was held during slow IPC")


if __name__ == "__main__":
    unittest.main()

# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Admit-then-commit job ownership for river-beta train / Stop."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from bounds import RiverBetaBounds  # noqa: E402
from session import RiverSession, is_train_admission_success  # noqa: E402


class IsTrainAdmissionSuccess(unittest.TestCase):
    def test_accepted_running_body(self) -> None:
        self.assertTrue(
            is_train_admission_success(
                {
                    "ok": True,
                    "body": {"accepted": True, "running": True, "async": True},
                }
            )
        )

    def test_json_string_body(self) -> None:
        self.assertTrue(
            is_train_admission_success(
                {
                    "ok": True,
                    "body": json.dumps({"accepted": True, "running": True}),
                }
            )
        )

    def test_busy_error_code(self) -> None:
        self.assertFalse(
            is_train_admission_success(
                {
                    "ok": False,
                    "error_code": "busy",
                    "error_message": "train already running",
                    "body": None,
                }
            )
        )

    def test_busy_flag_in_body(self) -> None:
        self.assertFalse(
            is_train_admission_success(
                {"ok": True, "body": {"busy": True, "accepted": True}}
            )
        )

    def test_ok_false_without_body(self) -> None:
        self.assertFalse(is_train_admission_success({"ok": False, "body": None}))

    def test_cancelled_and_not_running(self) -> None:
        self.assertFalse(
            is_train_admission_success({"ok": False, "error_code": "cancelled"})
        )
        self.assertFalse(
            is_train_admission_success({"ok": False, "error_code": "not_running"})
        )


class AdmitThenCommitTrain(unittest.TestCase):
    def _session(self) -> RiverSession:
        bounds = RiverBetaBounds(max_plan_memory_bytes=0)
        session = RiverSession("test-session", bounds, engine_binary=Path("/dev/null"))
        session._started = True
        session._sidecar = MagicMock()
        session._sidecar.pid = 4242
        session._sidecar.alive = True
        session._sidecar.launch_id = "river-beta-test"
        return session

    def test_commits_active_only_after_admit(self) -> None:
        session = self._session()
        session._sidecar.request.return_value = {
            "ok": True,
            "job_id": "job-a",
            "body": {"accepted": True, "running": True},
        }
        self.assertIsNone(session.active_job_id)
        env = session.ipc("solve", {"iterations": 10}, job_id="job-a")
        self.assertTrue(env.get("ok"))
        self.assertEqual(session.active_job_id, "job-a")

    def test_rejected_second_train_preserves_running_job(self) -> None:
        session = self._session()
        session.active_job_id = "job-a"

        def _request(
            op: str,
            body: Any = None,
            *,
            job_id: str | None = None,
            timeout_s: float = 60.0,
            expect_ok: bool = True,
        ) -> dict[str, Any]:
            self.assertEqual(op, "solve")
            self.assertEqual(job_id, "job-b")
            return {
                "ok": False,
                "job_id": "job-b",
                "error_code": "busy",
                "error_message": "train already running",
                "body": None,
            }

        session._sidecar.request.side_effect = _request
        env = session.ipc("solve", {"iterations": 10}, job_id="job-b")
        self.assertEqual(env.get("error_code"), "busy")
        self.assertEqual(session.active_job_id, "job-a")

    def test_default_stop_uses_authoritative_active_id(self) -> None:
        session = self._session()
        session.active_job_id = "job-a"

        def _request(
            op: str,
            body: Any = None,
            *,
            job_id: str | None = None,
            timeout_s: float = 60.0,
            expect_ok: bool = True,
        ) -> dict[str, Any]:
            self.assertEqual(op, "cancel")
            self.assertEqual(job_id, "job-a")
            return {
                "ok": True,
                "job_id": "job-a",
                "body": {"cancelled": True},
            }

        session._sidecar.request.side_effect = _request
        env = session.ipc("cancel", None)
        self.assertTrue(env.get("ok"))
        self.assertEqual(session.active_job_id, "job-a")

    def test_busy_then_default_stop_still_targets_a(self) -> None:
        """Audit reproduction: A running, B busy, default Stop must hit A."""
        session = self._session()
        calls: list[tuple[str, str | None]] = []

        def _request(
            op: str,
            body: Any = None,
            *,
            job_id: str | None = None,
            timeout_s: float = 60.0,
            expect_ok: bool = True,
        ) -> dict[str, Any]:
            calls.append((op, job_id))
            if op == "solve" and job_id == "job-a":
                return {
                    "ok": True,
                    "job_id": "job-a",
                    "body": {"accepted": True, "running": True},
                }
            if op == "solve" and job_id == "job-b":
                return {
                    "ok": False,
                    "job_id": "job-b",
                    "error_code": "busy",
                    "error_message": "train already running",
                    "body": None,
                }
            if op == "cancel":
                return {
                    "ok": True,
                    "job_id": job_id,
                    "body": {"cancelled": True},
                }
            raise AssertionError(f"unexpected op={op!r} job_id={job_id!r}")

        session._sidecar.request.side_effect = _request
        self.assertTrue(session.ipc("solve", {"iterations": 50}, job_id="job-a").get("ok"))
        self.assertEqual(session.active_job_id, "job-a")
        busy = session.ipc("solve", {"iterations": 50}, job_id="job-b")
        self.assertEqual(busy.get("error_code"), "busy")
        self.assertEqual(session.active_job_id, "job-a")
        cancel = session.ipc("cancel", None)  # default Stop — no explicit job_id
        self.assertTrue(cancel.get("ok"))
        self.assertEqual(calls[-1], ("cancel", "job-a"))


if __name__ == "__main__":
    unittest.main()

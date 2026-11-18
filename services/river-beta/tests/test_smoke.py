# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""End-to-end smoke against a real solver-engine (skipped if missing)."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))

from bounds import RiverBetaBounds  # noqa: E402
from ipc import default_solver_engine  # noqa: E402
from session import SessionManager, load_default_config  # noqa: E402


def _engine() -> Path:
    return default_solver_engine()


@unittest.skipUnless(_engine().is_file(), "solver-engine not built")
class RiverBetaSmoke(unittest.TestCase):
    def test_isolated_solve_status_node_cancel_metrics(self) -> None:
        bounds = RiverBetaBounds(
            max_concurrent_sessions=2,
            max_iterations=30,
            default_iterations=15,
            max_time_limit_sec=20.0,
            default_time_limit_sec=10.0,
            max_plan_memory_bytes=0,  # skip preflight shape variance in smoke
        )
        mgr = SessionManager(bounds, engine_binary=_engine())
        try:
            a = mgr.create()
            b = mgr.create()
            self.assertNotEqual(a.session_id, b.session_id)
            self.assertNotEqual(a._sidecar.pid, b._sidecar.pid)

            begin = a.ipc(
                "begin_config",
                {"config_text": load_default_config()},
                timeout_s=60.0,
            )
            self.assertTrue(begin.get("ok"), begin)

            solve = a.ipc(
                "solve",
                {"iterations": 15, "time_limit": 10},
                timeout_s=15.0,
            )
            self.assertTrue(solve.get("ok"), solve)
            self.assertIsNotNone(a.active_job_id)

            idle = a.poll_until_idle(timeout_s=30.0)
            body = idle.get("body") or {}
            if isinstance(body, str):
                body = json.loads(body)
            self.assertFalse(body.get("running"))

            root_id = body.get("root_node_id") or "p0.t-1.r-1"
            node = a.ipc("node", {"node_id": root_id}, timeout_s=30.0)
            self.assertTrue(node.get("ok"), node)

            info = a.info()
            metrics = info["metrics"]
            self.assertGreaterEqual(metrics["samples"], 1)
            self.assertGreaterEqual(metrics["peak_rss_bytes"], 0)
            # CPU may be tiny on a 15-iter river smoke but should be sampled.
            self.assertIn("cpu_user_sec", metrics)
            self.assertIn("cpu_system_sec", metrics)

            # Concurrency bound
            with self.assertRaises(Exception) as ctx:
                mgr.create()
            self.assertEqual(ctx.exception.code, "concurrency_bound")

            # Tear down one → room for another
            mgr.destroy(b.session_id)
            c = mgr.create()
            self.assertTrue(c._sidecar.alive)
            mgr.destroy(c.session_id)
            mgr.destroy(a.session_id)
        finally:
            mgr.shutdown()

    def test_rejects_flop_via_session(self) -> None:
        bounds = RiverBetaBounds(max_plan_memory_bytes=0)
        mgr = SessionManager(bounds, engine_binary=_engine())
        try:
            s = mgr.create()
            flop = """street-config 1
board Ah Kh Qh
pot 100
stack 100
oop-range AsQs:1,2d2h:1
ip-range AsQs:1,2d2h:1
oop-flop-bets 1
ip-flop-bets 1
memory-mib 64
threads 1
"""
            from session import SessionError

            with self.assertRaises(SessionError) as ctx:
                s.ipc("begin_config", {"config_text": flop})
            self.assertEqual(ctx.exception.code, "river_only")
        finally:
            mgr.shutdown()

    def test_rejected_second_train_preserves_active_for_stop(self) -> None:
        """Audit §7: busy train B must not steal active_job_id from A."""
        bounds = RiverBetaBounds(
            max_concurrent_sessions=1,
            max_iterations=5000,
            default_iterations=2000,
            max_time_limit_sec=60.0,
            default_time_limit_sec=30.0,
            max_plan_memory_bytes=0,
        )
        mgr = SessionManager(bounds, engine_binary=_engine())
        try:
            s = mgr.create()
            begin = s.ipc(
                "begin_config",
                {"config_text": load_default_config()},
                timeout_s=60.0,
            )
            self.assertTrue(begin.get("ok"), begin)

            a = s.ipc(
                "solve",
                {"iterations": 2000, "time_limit": 30},
                job_id="job-a",
                timeout_s=15.0,
            )
            self.assertTrue(a.get("ok"), a)
            self.assertEqual(s.active_job_id, "job-a")

            # Ensure host is still training before the competing request.
            status = s.ipc("status", None, timeout_s=8.0)
            status_body = status.get("body") or {}
            if isinstance(status_body, str):
                status_body = json.loads(status_body)
            self.assertTrue(
                isinstance(status_body, dict) and status_body.get("running"),
                status,
            )

            b = s.ipc(
                "solve",
                {"iterations": 2000, "time_limit": 30},
                job_id="job-b",
                timeout_s=15.0,
            )
            self.assertFalse(b.get("ok"), b)
            self.assertEqual(b.get("error_code"), "busy")
            self.assertEqual(s.active_job_id, "job-a")

            cancel = s.ipc("cancel", None, timeout_s=8.0)
            self.assertTrue(cancel.get("ok"), cancel)
            cancel_body = cancel.get("body") or {}
            if isinstance(cancel_body, str):
                cancel_body = json.loads(cancel_body)
            self.assertTrue(
                isinstance(cancel_body, dict) and cancel_body.get("cancelled") is True,
                cancel,
            )
            s.poll_until_idle(timeout_s=30.0)
        finally:
            mgr.shutdown()


if __name__ == "__main__":
    unittest.main()

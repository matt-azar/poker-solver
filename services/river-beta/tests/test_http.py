# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""HTTP API smoke (real engine when present)."""

from __future__ import annotations

import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from bounds import RiverBetaBounds  # noqa: E402
from ipc import default_solver_engine  # noqa: E402
from server import create_server  # noqa: E402


def _engine() -> Path:
    return default_solver_engine()


@unittest.skipUnless(_engine().is_file(), "solver-engine not built")
class HttpApiSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        bounds = RiverBetaBounds(
            max_concurrent_sessions=2,
            max_plan_memory_bytes=0,
            default_iterations=10,
            max_time_limit_sec=15.0,
            default_time_limit_sec=8.0,
        )
        cls.httpd = create_server(
            "127.0.0.1",
            0,
            bounds=bounds,
            engine_binary=_engine(),
            cors_origin="http://127.0.0.1:5173",
        )
        cls.port = cls.httpd.server_address[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.manager.shutdown()
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def _opener(self) -> urllib.request.OpenerDirector:
        jar = CookieJar()
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def _json(
        self,
        opener: urllib.request.OpenerDirector,
        method: str,
        path: str,
        body: dict | None = None,
    ) -> dict:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={"Content-Type": "application/json"} if data else {},
        )
        with opener.open(req, timeout=60) as resp:
            return json.loads(resp.read().decode())

    def test_health_bounds_solve_flow(self) -> None:
        opener = self._opener()
        health = self._json(opener, "GET", "/health")
        self.assertTrue(health["ok"])
        self.assertEqual(health["street"], "river")
        self.assertEqual(health["out_of_scope"], ["turn", "flop"])

        bounds = self._json(opener, "GET", "/v1/bounds")
        self.assertEqual(bounds["max_threads"], 1)

        created = self._json(opener, "POST", "/v1/sessions")
        self.assertTrue(created["ok"])
        sid = created["session"]["session_id"]
        self.assertTrue(sid)

        solved = self._json(
            opener,
            "POST",
            "/v1/sessions/me/solve",
            {"iterations": 10, "time_limit": 8},
        )
        self.assertTrue(solved["ok"], solved)
        self.assertTrue(solved["solve"].get("ok"), solved)

        # Poll until idle
        import time

        for _ in range(200):
            st = self._json(opener, "GET", "/v1/sessions/me/status")
            body = st["envelope"].get("body") or {}
            if isinstance(body, str):
                body = json.loads(body)
            if not body.get("running"):
                break
            time.sleep(0.05)
        else:
            self.fail("solve still running")

        self.assertIn("peak_rss_bytes", st["metrics"])

        node = self._json(
            opener,
            "POST",
            "/v1/sessions/me/ipc",
            {"op": "node", "body": {"node_id": "p0.t-1.r-1"}},
        )
        self.assertTrue(node["envelope"].get("ok"), node)

        deleted = self._json(opener, "DELETE", "/v1/sessions/me")
        self.assertTrue(deleted["ok"])


if __name__ == "__main__":
    unittest.main()

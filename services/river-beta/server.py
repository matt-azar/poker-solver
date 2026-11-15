# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""HTTPS-capable HTTP front for the river beta (typed IPC behind the sessions).

Does not reintroduce holdem-explorer or HTTP :8765 product fallthrough.
Visitors talk REST/JSON; each session owns a solver-engine child over pipes.
"""

from __future__ import annotations

import json
import logging
import ssl
import traceback
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from bounds import RiverBetaBounds
from session import (
    SessionError,
    SessionManager,
    load_default_config,
)

log = logging.getLogger("river_beta.server")


def _json_bytes(payload: Any, status: int = 200) -> tuple[int, bytes, str]:
    return status, json.dumps(payload, separators=(",", ":")).encode(), "application/json"


class RiverBetaHandler(BaseHTTPRequestHandler):
    server_version = "RiverBeta/0.1"
    manager: SessionManager  # set on server
    bounds: RiverBetaBounds
    cors_origin: str = "*"

    def log_message(self, fmt: str, *args: Any) -> None:
        log.info("%s - %s", self.address_string(), fmt % args)

    def _set_common_headers(self, content_type: str, length: int) -> None:
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        origin = self.cors_origin
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header(
                "Access-Control-Allow-Headers",
                "Content-Type, X-River-Beta-Session",
            )
            self.send_header(
                "Access-Control-Allow-Methods",
                "GET, POST, DELETE, OPTIONS",
            )

    def _read_json(self) -> Any:
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0:
            return None
        if length > 2 * 1024 * 1024:
            raise SessionError("invalid_request", "request body too large")
        raw = self.rfile.read(length)
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))

    def _session_id_from_request(self) -> str | None:
        header = self.headers.get("X-River-Beta-Session")
        if header and header.strip():
            return header.strip()
        cookie_header = self.headers.get("Cookie")
        if not cookie_header:
            return None
        cookie = SimpleCookie()
        cookie.load(cookie_header)
        morsel = cookie.get(self.bounds.session_cookie_name)
        if morsel:
            return morsel.value
        return None

    def _send(
        self,
        status: int,
        body: bytes,
        content_type: str,
        *,
        set_session: str | None = None,
        clear_session: bool = False,
    ) -> None:
        self.send_response(status)
        self._set_common_headers(content_type, len(body))
        if set_session:
            self.send_header(
                "Set-Cookie",
                f"{self.bounds.session_cookie_name}={set_session}; "
                "Path=/; HttpOnly; SameSite=Lax",
            )
            self.send_header("X-River-Beta-Session", set_session)
        if clear_session:
            self.send_header(
                "Set-Cookie",
                f"{self.bounds.session_cookie_name}=; Path=/; Max-Age=0",
            )
        self.end_headers()
        self.wfile.write(body)

    def _send_json(
        self,
        payload: Any,
        status: int = 200,
        *,
        set_session: str | None = None,
        clear_session: bool = False,
    ) -> None:
        status_code, body, ctype = _json_bytes(payload, status)
        self._send(
            status_code,
            body,
            ctype,
            set_session=set_session,
            clear_session=clear_session,
        )

    def _error(self, code: str, message: str, status: int = 400) -> None:
        self._send_json({"ok": False, "error_code": code, "error_message": message}, status)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(204, b"", "text/plain")

    def do_GET(self) -> None:  # noqa: N802
        try:
            path = urlparse(self.path).path.rstrip("/") or "/"
            if path in ("/", "/health"):
                self._send_json(
                    {
                        "ok": True,
                        "service": "river-beta",
                        "street": "river",
                        "engine": "solver-engine",
                        "transport": "typed-ipc",
                        "out_of_scope": ["turn", "flop"],
                    }
                )
                return
            if path == "/v1/bounds":
                b = self.bounds
                self._send_json(
                    {
                        "ok": True,
                        "street": "river",
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
                    }
                )
                return
            if path == "/v1/default-config":
                self._send_json(
                    {
                        "ok": True,
                        "config_text": load_default_config(),
                        "street": "river",
                    }
                )
                return
            if path == "/v1/sessions":
                self._send_json({"ok": True, "sessions": self.manager.list_metrics()})
                return
            if path == "/v1/sessions/me":
                session = self.manager.get(self._session_id_from_request())
                if not session:
                    self._error("no_session", "no river-beta session", 404)
                    return
                self._send_json({"ok": True, "session": session.info()})
                return
            if path == "/v1/sessions/me/status":
                session = self.manager.get(self._session_id_from_request())
                if not session:
                    self._error("no_session", "no river-beta session", 404)
                    return
                env = session.ipc("status", None, timeout_s=8.0)
                self._send_json(
                    {
                        "ok": True,
                        "envelope": env,
                        "metrics": session.metrics.to_dict(),
                    }
                )
                return
            self._error("not_found", f"unknown path {path}", 404)
        except SessionError as exc:
            self._error(exc.code, exc.message, 409 if exc.code == "concurrency_bound" else 400)
        except Exception:
            log.exception("GET failed")
            self._error("internal", traceback.format_exc().splitlines()[-1], 500)

    def do_POST(self) -> None:  # noqa: N802
        try:
            path = urlparse(self.path).path.rstrip("/") or "/"
            body = self._read_json()
            if path == "/v1/sessions":
                session = self.manager.create()
                self._send_json(
                    {"ok": True, "session": session.info()},
                    set_session=session.session_id,
                )
                return
            if path == "/v1/sessions/me/ipc":
                session = self.manager.get(self._session_id_from_request())
                if not session:
                    self._error("no_session", "create a session first", 404)
                    return
                if not isinstance(body, dict):
                    self._error("invalid_request", "JSON object required")
                    return
                op = body.get("op")
                if not isinstance(op, str) or not op:
                    self._error("invalid_request", "op required")
                    return
                env = session.ipc(
                    op,
                    body.get("body"),
                    job_id=body.get("job_id"),
                    timeout_s=float(body.get("timeout_s") or 120.0),
                )
                self._send_json(
                    {
                        "ok": True,
                        "envelope": env,
                        "metrics": session.metrics.to_dict(),
                        "active_job_id": session.active_job_id,
                    }
                )
                return
            if path == "/v1/sessions/me/solve":
                session = self.manager.get(self._session_id_from_request())
                if not session:
                    self._error("no_session", "create a session first", 404)
                    return
                payload = body if isinstance(body, dict) else {}
                config_text = payload.get("config_text") or load_default_config()
                begin = session.ipc(
                    "begin_config",
                    {"config_text": config_text},
                    timeout_s=120.0,
                )
                if not begin.get("ok"):
                    self._send_json(
                        {
                            "ok": False,
                            "error_code": begin.get("error_code") or "begin_failed",
                            "error_message": begin.get("error_message"),
                            "envelope": begin,
                            "metrics": session.metrics.to_dict(),
                        },
                        400,
                    )
                    return
                solve = session.ipc(
                    "solve",
                    {
                        k: payload[k]
                        for k in ("iterations", "time_limit", "accuracy", "eval_every")
                        if k in payload
                    },
                    timeout_s=15.0,
                )
                self._send_json(
                    {
                        "ok": bool(solve.get("ok")),
                        "begin": begin,
                        "solve": solve,
                        "active_job_id": session.active_job_id,
                        "metrics": session.metrics.to_dict(),
                    }
                )
                return
            if path == "/v1/sessions/me/cancel":
                session = self.manager.get(self._session_id_from_request())
                if not session:
                    self._error("no_session", "create a session first", 404)
                    return
                payload = body if isinstance(body, dict) else {}
                env = session.ipc(
                    "cancel",
                    None,
                    job_id=payload.get("job_id"),
                    timeout_s=8.0,
                )
                self._send_json(
                    {
                        "ok": bool(env.get("ok")),
                        "envelope": env,
                        "metrics": session.metrics.to_dict(),
                    }
                )
                return
            if path == "/v1/sessions/me/resolve":
                session = self.manager.get(self._session_id_from_request())
                if not session:
                    self._error("no_session", "create a session first", 404)
                    return
                payload = body if isinstance(body, dict) else {}
                env = session.ipc(
                    "resolve_locked",
                    {
                        k: payload[k]
                        for k in ("iterations", "time_limit", "accuracy", "eval_every")
                        if k in payload
                    },
                    timeout_s=15.0,
                )
                self._send_json(
                    {
                        "ok": bool(env.get("ok")),
                        "envelope": env,
                        "active_job_id": session.active_job_id,
                        "metrics": session.metrics.to_dict(),
                    }
                )
                return
            self._error("not_found", f"unknown path {path}", 404)
        except SessionError as exc:
            status = 409 if exc.code == "concurrency_bound" else 400
            self._error(exc.code, exc.message, status)
        except json.JSONDecodeError:
            self._error("invalid_request", "malformed JSON")
        except Exception:
            log.exception("POST failed")
            self._error("internal", traceback.format_exc().splitlines()[-1], 500)

    def do_DELETE(self) -> None:  # noqa: N802
        try:
            path = urlparse(self.path).path.rstrip("/") or "/"
            if path == "/v1/sessions/me":
                sid = self._session_id_from_request()
                if not sid:
                    self._error("no_session", "no river-beta session", 404)
                    return
                ok = self.manager.destroy(sid)
                self._send_json(
                    {"ok": ok},
                    status=200 if ok else 404,
                    clear_session=True,
                )
                return
            self._error("not_found", f"unknown path {path}", 404)
        except Exception:
            log.exception("DELETE failed")
            self._error("internal", traceback.format_exc().splitlines()[-1], 500)


class RiverBetaServer(ThreadingHTTPServer):
    def __init__(
        self,
        address: tuple[str, int],
        manager: SessionManager,
        bounds: RiverBetaBounds,
        *,
        cors_origin: str = "*",
    ) -> None:
        super().__init__(address, RiverBetaHandler)
        self.manager = manager
        self.bounds = bounds
        RiverBetaHandler.manager = manager
        RiverBetaHandler.bounds = bounds
        RiverBetaHandler.cors_origin = cors_origin


def create_server(
    host: str,
    port: int,
    *,
    bounds: RiverBetaBounds | None = None,
    engine_binary: Path | None = None,
    certfile: str | None = None,
    keyfile: str | None = None,
    cors_origin: str = "*",
) -> RiverBetaServer:
    b = bounds or RiverBetaBounds.from_environ()
    manager = SessionManager(b, engine_binary=engine_binary)
    httpd = RiverBetaServer((host, port), manager, b, cors_origin=cors_origin)
    if certfile:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=certfile, keyfile=keyfile or certfile)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    return httpd

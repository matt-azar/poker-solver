#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Start the limited river browser-solving beta service.

Examples:
  python3 services/river-beta/run.py
  python3 services/river-beta/run.py --host 127.0.0.1 --port 8787
  RIVER_BETA_TLS_CERT=cert.pem RIVER_BETA_TLS_KEY=key.pem \\
    python3 services/river-beta/run.py --port 8787
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from bounds import RiverBetaBounds  # noqa: E402
from ipc import default_solver_engine  # noqa: E402
from server import create_server  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="River beta solving service")
    parser.add_argument("--host", default=os.environ.get("RIVER_BETA_HOST", "127.0.0.1"))
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("RIVER_BETA_PORT", "8787")),
    )
    parser.add_argument(
        "--engine",
        default=os.environ.get("RIVER_BETA_SOLVER_ENGINE"),
        help="Path to solver-engine (default: zig-out/bin/solver-engine)",
    )
    parser.add_argument(
        "--cors-origin",
        default=os.environ.get("RIVER_BETA_CORS_ORIGIN", "http://127.0.0.1:5173"),
        help="Browser Origin allowed for credentialed CORS",
    )
    parser.add_argument(
        "--certfile",
        default=os.environ.get("RIVER_BETA_TLS_CERT"),
        help="TLS certificate PEM (enables HTTPS)",
    )
    parser.add_argument(
        "--keyfile",
        default=os.environ.get("RIVER_BETA_TLS_KEY"),
        help="TLS private key PEM (defaults to --certfile)",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    bounds = RiverBetaBounds.from_environ()
    engine = Path(args.engine).expanduser() if args.engine else default_solver_engine()
    if not engine.is_file():
        logging.error(
            "solver-engine not found at %s — run: zig build -Doptimize=ReleaseFast -Dcpu=x86_64_v2",
            engine,
        )
        return 2

    httpd = create_server(
        args.host,
        args.port,
        bounds=bounds,
        engine_binary=engine,
        certfile=args.certfile,
        keyfile=args.keyfile,
        cors_origin=args.cors_origin,
    )
    scheme = "https" if args.certfile else "http"
    logging.info(
        "river-beta listening on %s://%s:%d (engine=%s, max_sessions=%d)",
        scheme,
        args.host,
        args.port,
        engine,
        bounds.max_concurrent_sessions,
    )
    logging.info(
        "bounds: memory<=%d MiB iters<=%d time<=%.1fs threads<=%d combos<=%d",
        bounds.max_memory_mib,
        bounds.max_iterations,
        bounds.max_time_limit_sec,
        bounds.max_threads,
        bounds.max_weighted_combos_per_player,
    )
    logging.info("out of scope: turn / flop live solving")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        logging.info("shutting down")
    finally:
        httpd.manager.shutdown()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

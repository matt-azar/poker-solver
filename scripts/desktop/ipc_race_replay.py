#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""One-command IPC race / bug-case replay.

Runs small, declarative cases against either:
  - the controllable ``ipc-test-sidecar`` (quick withhold / control-path races), or
  - a real ``solver-engine`` binary (engine failures with fixture + actions).

Each case file keeps **input**, **action sequence**, **expected result**, and
an optional **build_sha** together so reproduction is one command::

  python scripts/desktop/ipc_race_replay.py \\
    scripts/desktop/ipc-race-cases/values-hold-status-cancel.json

  python scripts/desktop/ipc_race_replay.py --all --filter-sidecar test
  python scripts/desktop/ipc_race_replay.py case.json --require-sha

**Pass bar (Windows CI):** Status and Cancel complete while EV is withheld
(``values-hold-status-cancel``). UI A→B stale-EV is the browser track, not here.
Longer flop / memory benchmarks stay in their own jobs — do not fold them here.
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
CASES_DIR = Path(__file__).resolve().parent / "ipc-race-cases"
DEFAULT_ENGINE = ROOT / "zig-out" / "bin" / (
    "solver-engine.exe" if os.name == "nt" else "solver-engine"
)
DEFAULT_SIDECAR_CANDIDATES = [
    ROOT
    / "desktop"
    / "ipc-test-sidecar"
    / "target"
    / "release"
    / ("ipc-test-sidecar.exe" if os.name == "nt" else "ipc-test-sidecar"),
    ROOT
    / "desktop"
    / "ipc-test-sidecar"
    / "target"
    / "debug"
    / ("ipc-test-sidecar.exe" if os.name == "nt" else "ipc-test-sidecar"),
    ROOT / "scripts" / "desktop" / "ipc_test_sidecar.py",
]


class RaceError(RuntimeError):
    pass


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr)


def git_sha() -> str | None:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        return out.strip() or None
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return None


def encode(
    op: str,
    body: Any,
    request_id: str,
    job_id: str | None = None,
) -> bytes:
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


def read_frame(stdout) -> dict[str, Any]:
    hdr = stdout.read(4)
    if not hdr or len(hdr) < 4:
        raise RaceError("pipe closed (no length prefix)")
    (n,) = struct.unpack("<I", hdr)
    if n == 0 or n > 16 * 1024 * 1024:
        raise RaceError(f"invalid frame length {n}")
    payload = stdout.read(n)
    if not payload or len(payload) < n:
        raise RaceError("pipe closed (truncated payload)")
    return json.loads(payload)


class Inbox:
    def __init__(self, proc: subprocess.Popen) -> None:
        self._proc = proc
        self._by_id: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        self._error: Exception | None = None
        self.frames: list[dict[str, Any]] = []
        assert proc.stdout is not None
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        try:
            while True:
                env = read_frame(self._proc.stdout)
                with self._cv:
                    self.frames.append(env)
                    rid = env.get("request_id")
                    if env.get("kind") == "reply" and isinstance(rid, str):
                        self._by_id[rid] = env
                        self._cv.notify_all()
                    else:
                        self._cv.notify_all()
        except Exception as exc:  # noqa: BLE001 — surface to waiters
            with self._cv:
                self._error = exc
                self._cv.notify_all()

    def has(self, request_id: str) -> bool:
        with self._lock:
            return request_id in self._by_id

    def get(self, request_id: str) -> dict[str, Any] | None:
        with self._lock:
            return self._by_id.get(request_id)

    def wait(self, request_id: str, timeout: float) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        with self._cv:
            while request_id not in self._by_id:
                if self._error is not None:
                    raise RaceError(f"reader died: {self._error}")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RaceError(
                        f"IPC read timed out waiting for request_id={request_id}"
                    )
                self._cv.wait(timeout=remaining)
            return self._by_id[request_id]

    def still_pending(self, request_id: str, settle_ms: float = 50.0) -> bool:
        """True when no reply arrived after a short settle window."""
        time.sleep(settle_ms / 1000.0)
        return not self.has(request_id)


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


def resolve_path(value: str | None, *, base: Path = ROOT) -> Path | None:
    if not value:
        return None
    p = Path(value)
    if not p.is_absolute():
        p = base / p
    return p


def resolve_test_sidecar(explicit: Path | None) -> Path:
    if explicit is not None:
        if not explicit.is_file():
            raise RaceError(f"test sidecar not found: {explicit}")
        return explicit
    for cand in DEFAULT_SIDECAR_CANDIDATES:
        if cand.is_file():
            return cand
    raise RaceError(
        "ipc-test-sidecar not found — build with "
        "`cargo build --release` in desktop/ipc-test-sidecar "
        "(or keep scripts/desktop/ipc_test_sidecar.py)"
    )


def resolve_engine(explicit: Path | None) -> Path:
    if explicit is not None:
        if not explicit.is_file():
            raise RaceError(f"solver-engine not found: {explicit}")
        return explicit
    if DEFAULT_ENGINE.is_file():
        return DEFAULT_ENGINE
    raise RaceError(
        f"solver-engine not found at {DEFAULT_ENGINE} — "
        "build with `zig build -Dcpu=x86_64_v2`"
    )


def spawn_binary(binary: Path, extra_args: list[str] | None = None) -> subprocess.Popen:
    if binary.suffix.lower() == ".py":
        cmd = [sys.executable, str(binary)]
    else:
        cmd = [str(binary)]
    if extra_args:
        cmd.extend(extra_args)
    return subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )


def drain_stderr(proc: subprocess.Popen, sink: list[str]) -> None:
    def _run() -> None:
        assert proc.stderr is not None
        for line in iter(proc.stderr.readline, b""):
            sink.append(line.decode("utf-8", errors="replace").rstrip())

    threading.Thread(target=_run, daemon=True).start()


def deep_get(obj: Any, dotted: str) -> Any:
    cur = obj
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def match_expect(env: dict[str, Any], expect: Any) -> tuple[bool, str]:
    if expect is None:
        return True, "no expect"
    if expect == "pending":
        return False, "reply arrived but expect was pending"
    if isinstance(expect, bool):
        ok = bool(env.get("ok")) is expect
        return ok, f"ok={env.get('ok')} want={expect}"
    if isinstance(expect, dict):
        for key, want in expect.items():
            if key == "ok":
                got = bool(env.get("ok"))
            else:
                got = deep_get(env, key)
            if got != want:
                return False, f"{key}: got={got!r} want={want!r}"
        return True, "ok"
    return False, f"unsupported expect type: {type(expect)}"


def load_case(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or "id" not in data or "actions" not in data:
        raise RaceError(f"case {path} must be an object with id + actions")
    return data


def prepare_engine_session(
    proc: subprocess.Popen,
    inbox: Inbox,
    case: dict[str, Any],
) -> None:
    """Optional begin_config from case.input.config before scripted actions."""
    inp = case.get("input") or {}
    config_rel = inp.get("config")
    if not config_rel:
        return
    config_path = resolve_path(str(config_rel))
    assert config_path is not None
    if not config_path.is_file():
        raise RaceError(f"case input.config missing: {config_path}")
    text = config_path.read_text(encoding="utf-8")
    rid = f"begin-{uuid.uuid4().hex[:8]}"
    write_req(
        proc,
        "begin_config",
        {"config_text": text},
        rid,
        job_id=inp.get("begin_job_id") or "j-race-begin",
    )
    env = inbox.wait(rid, timeout=float(inp.get("begin_timeout_s", 30)))
    if not env.get("ok"):
        raise RaceError(f"begin_config failed: {env}")


def run_case(
    case: dict[str, Any],
    *,
    case_path: Path,
    sidecar: Path | None,
    engine: Path | None,
    require_sha: bool,
) -> dict[str, Any]:
    case_id = str(case["id"])
    kind = str(case.get("sidecar") or case.get("kind") or "test")
    build_sha = case.get("build_sha")
    head = git_sha()
    report: dict[str, Any] = {
        "ok": True,
        "id": case_id,
        "title": case.get("title"),
        "case_path": str(case_path),
        "sidecar_kind": kind,
        "build_sha": build_sha,
        "head_sha": head,
        "steps": [],
        "pending": [],
        "replies": {},
    }

    if require_sha:
        if not build_sha:
            raise RaceError(f"{case_id}: --require-sha but case has no build_sha")
        if head is None:
            raise RaceError(f"{case_id}: --require-sha but git HEAD unavailable")
        if not str(head).startswith(str(build_sha)) and not str(build_sha).startswith(
            str(head)
        ):
            raise RaceError(
                f"{case_id}: build_sha {build_sha} does not match HEAD {head}"
            )

    extra_args = list(case.get("sidecar_args") or [])
    if kind in ("test", "test-sidecar", "ipc-test-sidecar"):
        binary = resolve_test_sidecar(sidecar)
        if "--launch-id" not in extra_args:
            extra_args = ["--launch-id", f"race-{case_id}", *extra_args]
    elif kind in ("engine", "solver-engine"):
        binary = resolve_engine(engine)
    else:
        raise RaceError(f"{case_id}: unknown sidecar kind {kind!r}")

    report["binary"] = str(binary)
    stderr_lines: list[str] = []
    proc = spawn_binary(binary, extra_args)
    drain_stderr(proc, stderr_lines)
    inbox = Inbox(proc)
    request_ids: dict[str, str] = {}

    try:
        if kind in ("engine", "solver-engine"):
            # Engine cases always handshake ready before optional begin_config.
            rid_ready = f"ready-{uuid.uuid4().hex[:8]}"
            write_req(proc, "ready", None, rid_ready)
            ready_env = inbox.wait(rid_ready, timeout=10.0)
            if not ready_env.get("ok"):
                raise RaceError(f"engine ready failed: {ready_env}")
            report["steps"].append({"op": "ready", "ok": True, "auto": True})
            prepare_engine_session(proc, inbox, case)

        for idx, step in enumerate(case["actions"]):
            if not isinstance(step, dict):
                raise RaceError(f"action[{idx}] must be an object")

            if "sleep_ms" in step and len(step) == 1:
                time.sleep(float(step["sleep_ms"]) / 1000.0)
                report["steps"].append({"sleep_ms": step["sleep_ms"]})
                continue

            if "assert_pending" in step:
                ids = step["assert_pending"]
                if isinstance(ids, str):
                    ids = [ids]
                for label in ids:
                    rid = request_ids.get(label)
                    if rid is None:
                        raise RaceError(f"assert_pending unknown label {label!r}")
                    settle = float(step.get("settle_ms", 80))
                    if not inbox.still_pending(rid, settle_ms=settle):
                        raise RaceError(
                            f"expected {label} still pending; reply arrived: "
                            f"{inbox.get(rid)}"
                        )
                    if label not in report["pending"]:
                        report["pending"].append(label)
                report["steps"].append({"assert_pending": ids, "ok": True})
                continue

            if "assert_replied" in step:
                label = step["assert_replied"]
                rid = request_ids.get(str(label))
                if rid is None:
                    raise RaceError(f"assert_replied unknown label {label!r}")
                timeout = float(step.get("timeout_s", 5.0))
                env = inbox.wait(rid, timeout=timeout)
                expect = step.get("expect", True)
                ok, detail = match_expect(env, expect)
                if not ok:
                    raise RaceError(f"assert_replied {label}: {detail}")
                report["replies"][str(label)] = env
                report["steps"].append(
                    {"assert_replied": label, "ok": True, "detail": detail}
                )
                continue

            op = str(step.get("op") or "")
            if not op:
                raise RaceError(f"action[{idx}] missing op")
            label = str(step.get("id") or f"{op}-{idx}")
            rid = f"{label}-{uuid.uuid4().hex[:6]}"
            request_ids[label] = rid
            body = step.get("body", None)
            job_id = step.get("job_id")
            if isinstance(job_id, str) and not job_id:
                job_id = None
            expect = step.get("expect")

            write_req(proc, op, body, rid, job_id=job_id)

            if expect == "pending" or step.get("pending") is True:
                settle = float(step.get("settle_ms", 100))
                if not inbox.still_pending(rid, settle_ms=settle):
                    raise RaceError(
                        f"{label}: expected pending (withheld) but replied: "
                        f"{inbox.get(rid)}"
                    )
                report["pending"].append(label)
                report["steps"].append(
                    {"id": label, "op": op, "expect": "pending", "ok": True}
                )
                continue

            timeout = float(step.get("timeout_s", 5.0))
            env = inbox.wait(rid, timeout=timeout)
            ok, detail = match_expect(env, True if expect is None else expect)
            if not ok:
                raise RaceError(f"{label}: {detail}; env={env}")
            report["replies"][label] = {
                "ok": env.get("ok"),
                "error_code": env.get("error_code"),
                "body": env.get("body"),
            }
            report["steps"].append(
                {"id": label, "op": op, "ok": True, "detail": detail}
            )

        # Optional top-level expected.pending / expected.replies checks.
        expected = case.get("expected") or {}
        for label in expected.get("pending") or []:
            rid = request_ids.get(str(label))
            if rid is None or not inbox.still_pending(rid, settle_ms=50):
                raise RaceError(f"expected.pending failed for {label}")
        for label, want in (expected.get("replies") or {}).items():
            env = report["replies"].get(str(label))
            if env is None:
                # May only have been assert_replied into replies as full env.
                rid = request_ids.get(str(label))
                if rid is None or not inbox.has(rid):
                    raise RaceError(f"expected.replies missing {label}")
                env = inbox.get(rid) or {}
            ok, detail = match_expect(
                env if "ok" in env or "body" in env else {"ok": True, **env},
                want,
            )
            # Rebuild a reply-shaped dict when we stored a compact reply.
            if not ok and isinstance(env, dict) and "body" in env:
                ok, detail = match_expect(
                    {
                        "ok": env.get("ok"),
                        "body": env.get("body"),
                        "error_code": env.get("error_code"),
                    },
                    want,
                )
            if not ok:
                raise RaceError(f"expected.replies[{label}]: {detail}")

    except Exception as exc:  # noqa: BLE001 — fold into report
        report["ok"] = False
        report["error"] = str(exc)
    finally:
        if proc.poll() is None:
            try:
                if proc.stdin:
                    proc.stdin.close()
            except Exception:
                pass
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
        report["stderr_tail"] = stderr_lines[-40:]

    return report


def discover_cases() -> list[Path]:
    if not CASES_DIR.is_dir():
        return []
    # Skip *.example.json templates (real-engine scaffolding, not CI probes).
    return sorted(
        p
        for p in CASES_DIR.glob("*.json")
        if not p.name.endswith(".example.json")
    )


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Replay IPC race / bug cases (one command)."
    )
    ap.add_argument(
        "case",
        nargs="*",
        type=Path,
        help="Case JSON path(s). Omit with --all to run every case in ipc-race-cases/.",
    )
    ap.add_argument(
        "--all",
        action="store_true",
        help="Run every *.json under scripts/desktop/ipc-race-cases/",
    )
    ap.add_argument(
        "--sidecar",
        type=Path,
        default=None,
        help="Path to ipc-test-sidecar binary or ipc_test_sidecar.py",
    )
    ap.add_argument(
        "--engine",
        type=Path,
        default=None,
        help="Path to solver-engine (engine cases only)",
    )
    ap.add_argument(
        "--require-sha",
        action="store_true",
        help="Fail when case.build_sha does not match git HEAD (engine repros)",
    )
    ap.add_argument(
        "--filter-sidecar",
        choices=("test", "engine", "any"),
        default="any",
        help="With --all, only run cases of this sidecar kind (default any)",
    )
    ap.add_argument("--json-only", action="store_true")
    ap.add_argument("--out", type=Path, help="Write combined JSON report")
    args = ap.parse_args()

    paths: list[Path] = []
    if args.all:
        paths = discover_cases()
        if not paths:
            eprint(f"no cases under {CASES_DIR}")
            return 2
    elif args.case:
        paths = [p if p.is_absolute() else ROOT / p for p in args.case]
    else:
        ap.print_help()
        eprint("\nPass case path(s) or --all")
        return 2

    reports: list[dict[str, Any]] = []
    failed = 0
    for path in paths:
        case = load_case(path)
        kind = str(case.get("sidecar") or case.get("kind") or "test")
        if args.filter_sidecar == "test" and kind not in (
            "test",
            "test-sidecar",
            "ipc-test-sidecar",
        ):
            continue
        if args.filter_sidecar == "engine" and kind not in ("engine", "solver-engine"):
            continue
        report = run_case(
            case,
            case_path=path,
            sidecar=args.sidecar,
            engine=args.engine,
            require_sha=args.require_sha,
        )
        reports.append(report)
        if not report["ok"]:
            failed += 1
        if not args.json_only:
            status = "PASS" if report["ok"] else "FAIL"
            print(f"[{status}] {report['id']}  ({path.name})")
            if report.get("error"):
                print(f"  error: {report['error']}")
            if report.get("head_sha"):
                print(f"  head_sha: {report['head_sha']}")
            if report.get("build_sha"):
                print(f"  build_sha: {report['build_sha']}")

    summary = {
        "ok": failed == 0,
        "failed": failed,
        "ran": len(reports),
        "head_sha": git_sha(),
        "reports": reports,
    }
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        if not args.json_only:
            print(f"wrote: {args.out}")
    if args.json_only:
        json.dump(summary, sys.stdout, indent=2)
        sys.stdout.write("\n")

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

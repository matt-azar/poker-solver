#!/usr/bin/env python3
"""Measure explorer Save/Open peak RSS for a small CFR+ street solve.

Starts explorer, solves a tiny river, saves a PSOL, reopens it, and records
process RSS from /proc. Linux-only probe for the study baseline.
"""

from __future__ import annotations

import json
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def rss_kb(pid: int) -> int:
    status = Path(f"/proc/{pid}/status").read_text()
    for line in status.splitlines():
        if line.startswith("VmRSS:"):
            return int(line.split()[1])
    return 0


def http_json(method: str, url: str, body: dict | None = None) -> tuple[int, dict]:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if body is not None else {},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read().decode() or "{}"
            return response.status, json.loads(raw)
    except urllib.error.HTTPError as error:
        raw = error.read().decode() if error.fp is not None else ""
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"raw": raw}
        return error.code, payload


def wait_status(base: str, timeout: float = 120.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        code, status = http_json("GET", f"{base}/api/status")
        if code != 200:
            raise RuntimeError(f"status HTTP {code}: {status}")
        error = status.get("error") or ""
        if error:
            raise RuntimeError(error)
        if status.get("running") is False and int(status.get("iterations") or 0) > 0:
            return status
        time.sleep(0.25)
    raise TimeoutError("solve did not finish")


def main() -> int:
    explorer = ROOT / "build" / "explorer"
    if not explorer.is_file():
        print("explorer binary missing; build target explorer first", file=sys.stderr)
        return 2
    port = 18765
    base = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory() as tmp:
        psol = Path(tmp) / "probe.psol"
        proc = subprocess.Popen(
            [str(explorer), "--port", str(port)],
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        try:
            for _ in range(80):
                code, _ = http_json("GET", f"{base}/api/status")
                if code == 200:
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError("explorer did not become ready")
            rss_idle = rss_kb(proc.pid)
            job = {
                "board": ["Ah", "Kd", "7c", "4s", "2h"],
                "pot": 100,
                "stack": 100,
                "oop_range": "AcAd",
                "ip_range": "KsKc",
                "oop_bets": [],
                "ip_bets": [],
                "allow_all_in": False,
                "max_raises": 0,
                "iterations": 20,
                "algorithm": "cfr_plus",
                "frozen": True,
                "threads": 1,
                "memory_mib": 64,
                "samples": 1,
            }
            code, created = http_json("POST", f"{base}/api/solve", job)
            if code not in (200, 202):
                raise RuntimeError(f"solve HTTP {code}: {created}")
            status = wait_status(base)
            rss_after_solve = rss_kb(proc.pid)
            solution_id = status.get("solution_id")
            if not solution_id:
                raise RuntimeError(f"no solution_id in {status}")
            code, save = http_json(
                "POST",
                f"{base}/api/solutions/{solution_id}/save",
                {"path": str(psol)},
            )
            if code != 200:
                raise RuntimeError(f"save HTTP {code}: {save}")
            rss_after_save = rss_kb(proc.pid)
            file_bytes = psol.stat().st_size if psol.is_file() else 0
            code, opened = http_json("POST", f"{base}/api/open", {"path": str(psol)})
            if code != 200:
                raise RuntimeError(f"open HTTP {code}: {opened}")
            rss_after_open = rss_kb(proc.pid)
            report = {
                "source_commit": subprocess.check_output(
                    ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
                ).strip(),
                "pid": proc.pid,
                "rss_kb_idle": rss_idle,
                "rss_kb_after_solve": rss_after_solve,
                "rss_kb_after_save": rss_after_save,
                "rss_kb_after_open": rss_after_open,
                "psol_bytes": file_bytes,
                "solution_id": solution_id,
            }
            print(json.dumps(report, indent=2))
            return 0
        finally:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)


if __name__ == "__main__":
    sys.exit(main())

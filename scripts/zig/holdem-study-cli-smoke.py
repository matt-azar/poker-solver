#!/usr/bin/env python3
"""E2E smoke: river HH → job → plan → solve PSOL.

Fixture is BTN vs BB SRP river (position + preflop family — no stakes label).
Requires zig-out/bin/holdem-study-cli and zig-out/bin/solver-engine.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HH = ROOT / "configs" / "examples" / "study-jobs" / "river_btn_bb_srp.hh.txt"


def _first_existing(*candidates: Path) -> Path | None:
    for path in candidates:
        if path.is_file():
            return path
    return None


def resolve_binaries() -> tuple[Path, Path]:
    """Prefer native exe names; fall back to .exe for Windows CI runners."""
    cli = _first_existing(
        ROOT / "zig-out" / "bin" / "holdem-study-cli",
        ROOT / "zig-out" / "bin" / "holdem-study-cli.exe",
    )
    engine = _first_existing(
        ROOT / "zig-out" / "bin" / "solver-engine",
        ROOT / "zig-out" / "bin" / "solver-engine.exe",
    )
    if cli is None or engine is None:
        raise SystemExit(
            "BLOCKER: missing holdem-study-cli / solver-engine under zig-out/bin"
        )
    return cli, engine


def main() -> int:
    cli, engine = resolve_binaries()
    if not HH.is_file():
        print(f"BLOCKER: missing {HH}", file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory(prefix="holdem-study-cli-") as tmp:
        tmp_path = Path(tmp)
        job_path = tmp_path / "job.json"
        psol_path = tmp_path / "study.psol"

        from_hh = subprocess.run(
            [
                str(cli),
                "from-hh",
                str(HH),
                "--out",
                str(job_path),
                "--iterations",
                "20",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if from_hh.returncode != 0:
            print(from_hh.stderr, file=sys.stderr)
            return from_hh.returncode or 1
        job = json.loads(job_path.read_text(encoding="utf-8"))
        assert job["schema"] == "holdem-study-job/1"
        assert job["review"]["street_boundary"] == "river"
        assert job["review"]["positions"]["oop"] == "BB"
        assert "100NL" not in json.dumps(job)

        plan = subprocess.run(
            [str(cli), "plan", str(job_path)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if plan.returncode != 0:
            print(plan.stderr, file=sys.stderr)
            return plan.returncode or 1
        plan_body = json.loads(plan.stdout)
        assert plan_body["schema"] == "holdem-study-plan/1"
        assert len(plan_body["preview"]["nodes"]) >= 1
        root_actions = [
            a["label"] for a in plan_body["preview"]["nodes"][0]["actions"]
        ]
        assert "Check" in root_actions

        solve = subprocess.run(
            [
                str(cli),
                "solve",
                str(job_path),
                "--out",
                str(psol_path),
                "--engine",
                str(engine),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if solve.returncode != 0:
            print(solve.stderr, file=sys.stderr)
            print(solve.stdout, file=sys.stderr)
            return solve.returncode or 1
        solve_body = json.loads(solve.stdout)
        assert solve_body["schema"] == "holdem-study-solve/1"
        assert psol_path.is_file() and psol_path.stat().st_size > 0
        status = solve_body["status"]
        assert status.get("terminal_reason") == "completed"
        assert int(status.get("iterations") or 0) >= 1
        assert "accuracy_chips" in status
        assert solve_body.get("decision_actions") == [
            "Check",
            "Bet 50",
            "Call",
        ]

    print(
        json.dumps(
            {
                "ok": True,
                "fixture": str(HH),
                "root_actions": root_actions,
                "iterations": status.get("iterations"),
                "terminal_reason": status.get("terminal_reason"),
                "accuracy_chips": status.get("accuracy_chips"),
                "decision_actions": solve_body.get("decision_actions"),
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

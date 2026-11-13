#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""One-shot evidence bundle for a Study crash or hang.

Collects (best-effort):
  - live process snapshot
  - copy of diagnostics folder (or note if missing)
  - crash dump search summary
  - optional stack samples if processes are alive
  - optional ipc_probe / train_freeze_probe results if --probes and binary exist

Output: a directory (and optional zip) you can attach to a bug report.

Examples:
  python3 scripts/debug/collect_bundle.py
  python3 scripts/debug/collect_bundle.py --out /tmp/study-bundle --zip
  python3 scripts/debug/collect_bundle.py --probes --stacks
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import (  # noqa: E402
    BundleMeta,
    ROOT,
    crash_dumps_dirs,
    default_solver_engine,
    diagnostics_dir,
    utc_now_iso,
    write_json,
)
from analyze_diagnostics import analyze_dir  # noqa: E402
from capture_snapshot import build_snapshot  # noqa: E402
from find_crash_dumps import _iter_candidates  # noqa: E402


def _copy_tree(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def _zip_dir(src: Path, zip_path: Path) -> None:
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(src.rglob("*")):
            if path.is_file():
                zf.write(path, arcname=str(path.relative_to(src)))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--out",
        type=Path,
        default=Path(tempfile.gettempdir())
        / f"holdem-study-debug-{utc_now_iso().replace(':', '')}",
        help="Output directory for the bundle (default: system temp)",
    )
    ap.add_argument("--zip", action="store_true", help="Also write <out>.zip")
    ap.add_argument("--stacks", action="store_true", help="Sample stacks if live")
    ap.add_argument(
        "--probes",
        action="store_true",
        help="Run ipc_probe (+ train_freeze if config exists)",
    )
    ap.add_argument("--diagnostics-dir", type=Path)
    ap.add_argument("--since-hours", type=float, default=168.0)
    args = ap.parse_args()

    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    meta = BundleMeta()
    write_json(out / "meta.json", meta.__dict__)

    # 1) live snapshot
    snap = build_snapshot(0.5)
    write_json(out / "live-snapshot.json", snap)

    # 2) diagnostics
    diag = diagnostics_dir(args.diagnostics_dir)
    diag_copy = out / "diagnostics"
    if diag.is_dir():
        _copy_tree(diag, diag_copy)
        analysis = analyze_dir(diag_copy)
        write_json(out / "diagnostics-analysis.json", analysis)
    else:
        write_json(
            out / "diagnostics-analysis.json",
            {
                "kind": "diagnostics-analysis",
                "timestamp": utc_now_iso(),
                "diagnosticsDir": str(diag),
                "presentFiles": [],
                "classification": {
                    "primary": "unknown",
                    "tags": ["diagnostics_missing"],
                    "evidence": [f"missing dir {diag}"],
                    "interpretation": "No app diagnostics folder on this host.",
                    "hangEventCount": 0,
                },
            },
        )

    # 3) dumps
    import time

    since = time.time() - args.since_hours * 3600
    dumps = _iter_candidates(crash_dumps_dirs(), since)
    write_json(
        out / "crash-dumps.json",
        {
            "kind": "crash-dump-search",
            "timestamp": utc_now_iso(),
            "dumps": dumps,
            "count": len(dumps),
        },
    )

    # 4) optional stacks
    if args.stacks and snap["processCount"]["total"] > 0:
        from stack_sample import sample_pid

        stacks_dir = out / "stacks"
        stacks_dir.mkdir(exist_ok=True)
        for proc in snap["processes"]:
            text = sample_pid(int(proc["pid"]), timeout=15.0)
            (stacks_dir / f"{proc['role']}-{proc['pid']}.txt").write_text(
                text, encoding="utf-8"
            )

    # 5) optional probes
    if args.probes:
        binary = default_solver_engine()
        if binary.is_file():
            from ipc_probe import run_probe as run_ipc
            from train_freeze_probe import DEFAULT_CONFIG, run_probe as run_train

            write_json(out / "ipc-probe.json", run_ipc(binary, 8.0))
            if DEFAULT_CONFIG.is_file():
                write_json(
                    out / "train-freeze-probe.json",
                    run_train(binary, DEFAULT_CONFIG, 30, 8.0, 4, 0.3),
                )
        else:
            write_json(
                out / "ipc-probe.json",
                {"ok": False, "error": f"missing binary {binary}"},
            )

    # Index
    index = {
        "createdAt": utc_now_iso(),
        "out": str(out),
        "files": sorted(str(p.relative_to(out)) for p in out.rglob("*") if p.is_file()),
        "repoRoot": str(ROOT),
        "primaryHint": None,
    }
    analysis_path = out / "diagnostics-analysis.json"
    if analysis_path.is_file():
        try:
            index["primaryHint"] = json.loads(analysis_path.read_text())[
                "classification"
            ]["primary"]
        except (OSError, KeyError, json.JSONDecodeError):
            pass
    write_json(out / "INDEX.json", index)

    zip_path = None
    if args.zip:
        zip_path = out.with_suffix(".zip")
        if out.suffix == ".zip":
            zip_path = Path(str(out) + ".zip")
        _zip_dir(out, zip_path)

    print(f"bundle: {out}")
    print(f"files: {len(index['files'])}")
    print(f"primaryHint: {index['primaryHint']}")
    if zip_path:
        print(f"zip: {zip_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

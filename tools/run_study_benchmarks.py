#!/usr/bin/env python3
"""Run the postflop study benchmark cases against river_solver and street_solver.

Python standard library only. Processes are started with argument arrays.
Cases run one at a time. The runner does not interpret a shell command string.

NashConv is player0_best_response_utility + player1_best_response_utility.
The quality target is NashConv/pot at most 0.001. When the solver prints
nash_gap and pot, this runner divides them. That quotient is the runner's
derivation, including when the street CLI also prints nash_gap_fraction_of_pot.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import platform
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CASE_DIR = ROOT / "benchmarks" / "study" / "cases"
DEFAULT_OUTPUT_DIR = ROOT / "benchmarks" / "study" / "out"
TARGET = 0.001

METRIC_FIELDS = (
    "game",
    "solver",
    "board",
    "algorithm",
    "traversal",
    "pot",
    "stack",
    "deals",
    "infosets",
    "public_decisions",
    "decision_nodes",
    "terminals",
    "iterations",
    "runtime_seconds",
    "memory_bytes_estimate",
    "construction_seconds",
    "cache_init_seconds",
    "worker_setup_seconds",
    "train_seconds",
    "evaluation_seconds",
    "threads",
    "total_seconds",
    "memory_budget_bytes",
    "allocated_bytes",
    "peak_allocated_bytes",
    "reserved_bytes",
    "estimated_peak_bytes",
    "regret_strategy_sum_bytes",
    "process_peak_working_set_bytes",
    "player0_expected_utility",
    "player0_best_response_utility",
    "player1_best_response_utility",
    "nash_gap",
    "nash_gap_fraction_of_pot",
)

# Street solves expose these. River solves do not. Kept so a missing river
# field stays null instead of being invented.
STREET_ONLY_FIELDS = (
    "solver",
    "public_decisions",
    "construction_seconds",
    "cache_init_seconds",
    "worker_setup_seconds",
    "train_seconds",
    "evaluation_seconds",
    "threads",
    "total_seconds",
    "memory_budget_bytes",
    "allocated_bytes",
    "peak_allocated_bytes",
    "reserved_bytes",
    "estimated_peak_bytes",
    "regret_strategy_sum_bytes",
    "process_peak_working_set_bytes",
    "nash_gap_fraction_of_pot",
)

RIVER_ONLY_FIELDS = ("traversal", "memory_bytes_estimate")

KEY_VALUE = re.compile(r"^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$")
MEMORY_COMPONENT = re.compile(r"^memory_component\s+(\S+)\s+(\d+)\s*$")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bin-dir",
        required=True,
        help="Directory that contains river_solver and street_solver",
    )
    parser.add_argument(
        "--output-dir",
        default=str(DEFAULT_OUTPUT_DIR),
        help="Directory for results.json, summary.md, and raw logs (default: benchmarks/study/out)",
    )
    parser.add_argument(
        "--case-dir",
        default=str(DEFAULT_CASE_DIR),
        help="Directory of case JSON files",
    )
    parser.add_argument(
        "--cases",
        default="reference",
        help="reference, smoke, all, or a comma-separated list of case ids",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=None,
        help="Override --iterations on every selected case",
    )
    parser.add_argument(
        "--threads",
        type=int,
        default=None,
        help="Override --threads on street_solver. Ignored for river_solver, which has no thread flag",
    )
    parser.add_argument(
        "--wall-seconds",
        type=float,
        default=None,
        help="Override each case wall-clock limit, in seconds",
    )
    parser.add_argument(
        "--timing-label",
        default="unspecified",
        choices=("unspecified", "quiet", "contended", "pending"),
        help="Label whether wall times were measured on a quiet machine",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Write the commands and do not start the solvers",
    )
    return parser.parse_args(argv)


def load_cases(case_dir: Path) -> list[dict]:
    paths = sorted(case_dir.glob("*.json"))
    if not paths:
        raise SystemExit(f"no case files in {case_dir}")
    cases = []
    seen: set[str] = set()
    for path in paths:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise SystemExit(f"{path}: {error}") from error
        if not isinstance(data, dict) or "id" not in data or "argv" not in data:
            raise SystemExit(f"{path}: a case needs id and argv")
        if data["id"] in seen:
            raise SystemExit(f"duplicate case id {data['id']}")
        seen.add(data["id"])
        data["source_path"] = str(path)
        cases.append(data)
    return cases


def select_cases(cases: list[dict], spec: str) -> list[dict]:
    key = spec.strip()
    if key == "reference":
        return [case for case in cases if case.get("role") == "reference"]
    if key in ("smoke", "diagnostic"):
        return [case for case in cases if case.get("role") == "diagnostic"]
    if key == "all":
        return list(cases)
    wanted = [part.strip() for part in key.split(",") if part.strip()]
    by_id = {case["id"]: case for case in cases}
    missing = [name for name in wanted if name not in by_id]
    if missing:
        known = ", ".join(case["id"] for case in cases)
        raise SystemExit(f"unknown case id: {', '.join(missing)}. Known ids: {known}")
    return [by_id[name] for name in wanted]


def replace_flag(argv: list[str], flag: str, value: str) -> list[str]:
    output: list[str] = []
    found = False
    index = 0
    while index < len(argv):
        if argv[index] == flag:
            found = True
            output.append(flag)
            output.append(value)
            index += 2
            continue
        output.append(argv[index])
        index += 1
    if not found:
        output.extend([flag, value])
    return output


def flag_value(argv: list[str], flag: str) -> str | None:
    for index, item in enumerate(argv):
        if item == flag and index + 1 < len(argv):
            return argv[index + 1]
    return None


def binary_path(bin_dir: Path, name: str) -> Path:
    base = bin_dir / name
    if os.name == "nt":
        exe = base if base.suffix.lower() == ".exe" else base.with_suffix(".exe")
        return exe
    return base


def apply_overrides(case: dict, args: argparse.Namespace, bin_dir: Path) -> dict:
    argv = [str(item) for item in case["argv"]]
    binary_name = case["binary"]
    notes: list[str] = []
    if args.iterations is not None:
        if args.iterations <= 0:
            raise SystemExit("--iterations must be positive")
        argv = replace_flag(argv, "--iterations", str(args.iterations))
        notes.append(f"--iterations overridden to {args.iterations}")
    threads_requested = args.threads
    threads_applied: int | None = None
    threads_supported = binary_name == "street_solver"
    if threads_requested is not None:
        if threads_requested < 1 or threads_requested > 64:
            raise SystemExit("--threads must be from 1 through 64")
        if threads_supported:
            argv = replace_flag(argv, "--threads", str(threads_requested))
            threads_applied = threads_requested
            notes.append(f"--threads overridden to {threads_requested}")
        else:
            notes.append(
                "river_solver has no --threads flag; the requested thread count was not passed"
            )
    elif threads_supported:
        text = flag_value(argv, "--threads")
        if text is not None:
            threads_applied = int(text)
    wall = args.wall_seconds if args.wall_seconds is not None else case.get("wall_seconds")
    if wall is None or float(wall) <= 0:
        raise SystemExit(f"{case['id']}: wall-seconds must be positive")
    return {
        "argv": argv,
        "binary": binary_path(bin_dir, binary_name),
        "notes": notes,
        "threads_requested": threads_requested,
        "threads_applied": threads_applied,
        "threads_supported": threads_supported,
        "wall_seconds": float(wall),
        "iterations_in_command": flag_value(argv, "--iterations"),
        "memory_mib_in_command": flag_value(argv, "--memory-mib"),
    }


def parse_scalar(text: str) -> int | float | str:
    stripped = text.strip()
    if re.fullmatch(r"[+-]?\d+", stripped):
        return int(stripped)
    try:
        if re.fullmatch(r"[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?", stripped):
            return float(stripped)
    except ValueError:
        pass
    return stripped


def parse_solver_output(text: str) -> dict:
    metrics = {name: None for name in METRIC_FIELDS}
    components: list[dict] = []
    seen_component = False
    for line in text.splitlines():
        component = MEMORY_COMPONENT.match(line.strip())
        if component:
            seen_component = True
            components.append(
                {"name": component.group(1), "bytes": int(component.group(2))}
            )
            continue
        match = KEY_VALUE.match(line.strip())
        if not match:
            continue
        key, raw = match.group(1), match.group(2)
        if key == "phase":
            metrics["phase"] = raw.strip()
            continue
        if key in metrics:
            metrics[key] = parse_scalar(raw)
    metrics["memory_components"] = components if seen_component else None
    if "phase" not in metrics:
        metrics["phase"] = None
    return metrics


def as_float(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def quality_from_metrics(metrics: dict) -> dict:
    """Derive NashConv/pot from printed nash_gap and pot.

    The division is this runner's. Street output may also contain
    nash_gap_fraction_of_pot; that printed value is stored separately.
    """
    nash_gap = as_float(metrics.get("nash_gap"))
    pot = as_float(metrics.get("pot"))
    player0 = as_float(metrics.get("player0_best_response_utility"))
    player1 = as_float(metrics.get("player1_best_response_utility"))
    summed = None
    if player0 is not None and player1 is not None:
        summed = player0 + player1
    nashconv = summed if summed is not None else nash_gap
    derived = None
    if nash_gap is not None and pot is not None and pot != 0:
        derived = nash_gap / pot
    printed = as_float(metrics.get("nash_gap_fraction_of_pot"))
    measured = derived is not None
    reached = bool(measured and nash_gap is not None and nash_gap <= TARGET * pot)
    return {
        "nashconv": nashconv,
        "nashconv_from_best_responses": summed,
        "nashconv_printed_nash_gap": nash_gap,
        "nashconv_over_pot": derived,
        "nashconv_over_pot_source": "runner_derived_from_nash_gap_and_pot" if measured else None,
        "printed_nash_gap_fraction_of_pot": printed,
        "quality_target": TARGET,
        "quality_measured": measured,
        "quality_reached": reached,
        "player0_expected_utility": as_float(metrics.get("player0_expected_utility")),
    }


def classify(exit_code: int | None, timed_out: bool, stdout: str, stderr: str, quality: dict) -> str:
    if timed_out:
        return "timeout"
    if exit_code == 0:
        if quality["quality_measured"] and quality["quality_reached"]:
            return "success"
        return "target-not-reached"
    combined = f"{stdout}\n{stderr}".lower()
    if (
        "memory budget exceeded" in combined
        or "bad_alloc" in combined
        or "allocation failed" in combined
    ):
        return "resource-rejection"
    if exit_code == 2 or "usage:" in combined:
        return "invalid-input"
    return "process-failure"


def unavailable_fields(metrics: dict, binary_name: str) -> list[str]:
    missing = [name for name in METRIC_FIELDS if metrics.get(name) is None]
    if binary_name == "river_solver":
        # These stays null because the river CLI does not print them.
        return missing
    return missing


def run_process(command: list[str], wall_seconds: float) -> dict:
    started = time.perf_counter()
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            shell=False,
        )
    except OSError as error:
        return {
            "exit_code": None,
            "timed_out": False,
            "wall_seconds": time.perf_counter() - started,
            "stdout": "",
            "stderr": str(error),
            "launch_error": True,
        }
    try:
        stdout, stderr = process.communicate(timeout=wall_seconds)
        return {
            "exit_code": process.returncode,
            "timed_out": False,
            "wall_seconds": time.perf_counter() - started,
            "stdout": stdout or "",
            "stderr": stderr or "",
            "launch_error": False,
        }
    except subprocess.TimeoutExpired:
        process.kill()
        stdout, stderr = process.communicate()
        return {
            "exit_code": process.returncode,
            "timed_out": True,
            "wall_seconds": time.perf_counter() - started,
            "stdout": stdout or "",
            "stderr": stderr or "",
            "launch_error": False,
        }


def read_cmake_cache(bin_dir: Path) -> dict:
    current = bin_dir.resolve()
    cache = None
    for _ in range(5):
        candidate = current / "CMakeCache.txt"
        if candidate.is_file():
            cache = candidate
            break
        if current == ROOT or current.parent == current:
            break
        current = current.parent
    info = {
        "cmake_cache": str(cache) if cache else None,
        "compiler_path": None,
        "compiler_id": None,
        "compiler_version": None,
        "generator": None,
        "build_type": None,
    }
    if cache is None:
        return info
    values: dict[str, str] = {}
    for line in cache.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line or line.startswith("#") or line.startswith("//"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.split(":", 1)[0]
        values[key] = value
    info["compiler_path"] = values.get("CMAKE_CXX_COMPILER") or None
    info["compiler_id"] = values.get("CMAKE_CXX_COMPILER_ID") or None
    info["compiler_version"] = values.get("CMAKE_CXX_COMPILER_VERSION") or None
    info["generator"] = values.get("CMAKE_GENERATOR") or None
    info["build_type"] = values.get("CMAKE_BUILD_TYPE") or None
    if not info["build_type"] and bin_dir.name.lower() in ("release", "debug", "relwithdebinfo", "minsizerel"):
        info["build_type"] = bin_dir.name
    return info


def compiler_banner(compiler_path: str | None) -> str | None:
    if not compiler_path:
        return None
    try:
        completed = subprocess.run(
            [compiler_path],
            capture_output=True,
            text=True,
            timeout=20,
            shell=False,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    text = (completed.stderr or "") + "\n" + (completed.stdout or "")
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return None


def cpu_and_ram() -> dict:
    cpu_name = platform.processor() or None
    if os.name == "nt":
        try:
            completed = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    "(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name)",
                ],
                capture_output=True,
                text=True,
                timeout=20,
                shell=False,
                check=False,
            )
            name = completed.stdout.strip()
            if name:
                cpu_name = name
        except (OSError, subprocess.TimeoutExpired):
            pass
    total = None
    available = None
    if os.name == "nt":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        status = MemoryStatus()
        status.dwLength = ctypes.sizeof(MemoryStatus)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            total = int(status.ullTotalPhys)
            available = int(status.ullAvailPhys)
    elif Path("/proc/meminfo").is_file():
        info = {}
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            if ":" in line:
                key, value = line.split(":", 1)
                info[key.strip()] = value.strip()
        def kib(key: str) -> int | None:
            raw = info.get(key)
            if not raw:
                return None
            return int(raw.split()[0]) * 1024
        total = kib("MemTotal")
        available = kib("MemAvailable")
    return {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "cpu": cpu_name,
        "logical_cpus": os.cpu_count(),
        "ram_bytes": total,
        "ram_available_bytes": available,
    }


def source_commit() -> dict:
    def git(*args: str) -> str | None:
        try:
            completed = subprocess.run(
                ["git", *args],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=20,
                shell=False,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        if completed.returncode != 0:
            return None
        text = completed.stdout.strip()
        return text or None

    return {
        "commit": git("rev-parse", "HEAD"),
        "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
    }


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def format_number(value: object) -> str:
    if value is None:
        return "unavailable"
    if isinstance(value, float):
        return f"{value:.6g}"
    return str(value)


def write_summary(path: Path, payload: dict) -> None:
    lines = [
        "# Study benchmark run",
        "",
        f"Timing label: `{payload['timing_label']}`. "
        "Contended and pending wall times are not performance conclusions.",
        "",
        "NashConv is `player0_best_response_utility + player1_best_response_utility`, "
        "the sum of the two unilateral deviation gains. "
        "The target is NashConv/pot at most 0.001. "
        "The pot fraction in this file is derived by the runner from printed `nash_gap` and `pot` "
        "when both are present.",
        "",
        f"Source commit: `{payload['source'].get('commit')}` "
        f"({payload['source'].get('branch')})",
        f"Platform: {payload['host'].get('platform')}",
        f"CPU: {payload['host'].get('cpu')} ({payload['host'].get('logical_cpus')} logical)",
        f"RAM bytes: {format_number(payload['host'].get('ram_bytes'))} "
        f"(available at collection {format_number(payload['host'].get('ram_available_bytes'))})",
        f"Compiler: {payload['build'].get('compiler_id') or 'unavailable'} "
        f"{payload['build'].get('compiler_version') or ''} "
        f"build type {payload['build'].get('build_type') or 'unavailable'}",
        f"Compiler banner: {payload['build'].get('compiler_banner') or 'unavailable'}",
        f"Generator: {payload['build'].get('generator') or 'unavailable'}",
        "",
        "`wall_seconds` is cold process time measured outside the solver. "
        "`runtime_seconds` and `total_seconds` are solver clocks. "
        "`total_seconds` sums construction, cache init, worker setup, training, and evaluation. "
        "It is not process wall time. "
        "`allocated_bytes` and `peak_allocated_bytes` are engine allocator requests. "
        "`estimated_peak_bytes` is a labeled plan. "
        "`memory_bytes_estimate` on the river CLI is the regret table plus the strategy-sum table only. "
        "`process_peak_working_set_bytes` is process working set and is printed by the street CLI only. "
        "The street `--memory-mib` value is an engine allocation budget, not an operating-system limit.",
        "",
    ]
    for case in payload["cases"]:
        metrics = case["metrics"]
        lines.extend(
            [
                f"## {case['id']}",
                "",
                f"- Outcome: `{case['outcome']}`",
                f"- Exit code: {format_number(case['exit_code'])}",
                f"- Wall seconds: {format_number(case['wall_seconds'])} "
                f"(limit {format_number(case['wall_limit_seconds'])})",
                f"- Iterations requested: {format_number(case['iterations_in_command'])}",
                f"- Iterations completed: {format_number(metrics.get('iterations'))}",
                f"- Last flushed phase: {format_number(metrics.get('phase'))}",
                f"- Threads applied: {format_number(case['threads_applied'])}",
                f"- Engine memory budget MiB: {format_number(case['memory_mib_in_command'])}",
                f"- Player 0 EV: {format_number(case['quality']['player0_expected_utility'])}",
                f"- NashConv: {format_number(case['quality']['nashconv'])}",
                f"- NashConv/pot (runner-derived): {format_number(case['quality']['nashconv_over_pot'])}",
                f"- Quality measured: {case['quality']['quality_measured']}",
                f"- Quality reached: {case['quality']['quality_reached']}",
                f"- Deals: {format_number(metrics.get('deals'))}",
                f"- Information sets: {format_number(metrics.get('infosets'))}",
                f"- Construction seconds: {format_number(metrics.get('construction_seconds'))}",
                f"- Cache init seconds: {format_number(metrics.get('cache_init_seconds'))}",
                f"- Train seconds: {format_number(metrics.get('train_seconds'))}",
                f"- Evaluation seconds: {format_number(metrics.get('evaluation_seconds'))}",
                f"- Solver total_seconds: {format_number(metrics.get('total_seconds'))}",
                f"- Solver runtime_seconds: {format_number(metrics.get('runtime_seconds'))}",
                f"- Allocated bytes: {format_number(metrics.get('allocated_bytes'))}",
                f"- Peak allocated bytes: {format_number(metrics.get('peak_allocated_bytes'))}",
                f"- Estimated peak bytes: {format_number(metrics.get('estimated_peak_bytes'))}",
                f"- River table estimate bytes: {format_number(metrics.get('memory_bytes_estimate'))}",
                f"- Process peak working set bytes: {format_number(metrics.get('process_peak_working_set_bytes'))}",
                f"- Accuracy cadence: {format_number(case['case'].get('eval_interval'))} "
                f"({case['case'].get('eval_interval_source') or 'not recorded'})",
                "",
                "Command:",
                "",
                "```text",
                shlex.join(case["command"]),
                "```",
                "",
            ]
        )
        if case["outcome"] == "timeout":
            lines.append(
                "Timeout: the process was killed at the wall limit. "
                "This is not a completed solve. Metrics above are the last flushed phase. "
                "`phase: final` is a finished report. "
                "`start`, `construction`, `cache_init`, `training`, and `checkpoint` were interrupted. "
                "A checkpoint records the last accuracy evaluation, not an iteration still in progress."
            )
            lines.append("")
        if case["outcome"] in ("invalid-input", "resource-rejection", "process-failure"):
            diagnostic = (case.get("stderr_excerpt") or "").strip()
            if diagnostic:
                lines.append("Diagnostic:")
                lines.append("")
                lines.append("```text")
                lines.append(diagnostic)
                lines.append("```")
                lines.append("")
        unavailable = case.get("unavailable") or []
        if unavailable:
            lines.append("Unavailable from this solver output: " + ", ".join(f"`{name}`" for name in unavailable) + ".")
            lines.append("")
    write_text(path, "\n".join(lines) + "\n")


def excerpt(text: str, limit: int = 800) -> str:
    stripped = text.strip()
    if len(stripped) <= limit:
        return stripped
    return stripped[:limit] + "\n..."


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    bin_dir = Path(args.bin_dir)
    output_dir = Path(args.output_dir)
    if not output_dir.is_absolute():
        output_dir = Path.cwd() / output_dir
    cases = select_cases(load_cases(Path(args.case_dir)), args.cases)
    if not cases:
        raise SystemExit(f"no cases selected for {args.cases!r}")
    output_dir.mkdir(parents=True, exist_ok=True)

    build = read_cmake_cache(bin_dir if bin_dir.is_absolute() else Path.cwd() / bin_dir)
    build["compiler_banner"] = compiler_banner(build.get("compiler_path"))
    host = cpu_and_ram()
    source = source_commit()
    records = []

    for case in cases:
        prepared = apply_overrides(case, args, bin_dir if bin_dir.is_absolute() else Path.cwd() / bin_dir)
        command = [str(prepared["binary"]), *prepared["argv"]]
        stdout_path = output_dir / f"{case['id']}.stdout.txt"
        stderr_path = output_dir / f"{case['id']}.stderr.txt"
        if args.dry_run:
            executed = {
                "exit_code": None,
                "timed_out": False,
                "wall_seconds": None,
                "stdout": "",
                "stderr": "",
                "launch_error": False,
            }
            metrics = {name: None for name in METRIC_FIELDS}
            metrics["memory_components"] = None
            metrics["phase"] = None
            quality = quality_from_metrics(metrics)
            outcome = "dry-run"
        else:
            executed = run_process(command, prepared["wall_seconds"])
            metrics = parse_solver_output(executed["stdout"])
            quality = quality_from_metrics(metrics)
            if executed["launch_error"]:
                outcome = "process-failure"
            else:
                outcome = classify(
                    executed["exit_code"],
                    executed["timed_out"],
                    executed["stdout"],
                    executed["stderr"],
                    quality,
                )
        write_text(stdout_path, executed["stdout"])
        write_text(stderr_path, executed["stderr"])
        record = {
            "id": case["id"],
            "role": case.get("role"),
            "outcome": outcome,
            "exit_code": executed["exit_code"],
            "timed_out": executed["timed_out"],
            "wall_seconds": executed["wall_seconds"],
            "wall_limit_seconds": prepared["wall_seconds"],
            "command": command,
            "override_notes": prepared["notes"],
            "iterations_in_command": prepared["iterations_in_command"],
            "threads_supported": prepared["threads_supported"],
            "threads_requested": prepared["threads_requested"],
            "threads_applied": prepared["threads_applied"],
            "memory_mib_in_command": prepared["memory_mib_in_command"],
            "quality": quality,
            "metrics": metrics,
            "unavailable": unavailable_fields(metrics, case["binary"]),
            "stdout_path": str(stdout_path),
            "stderr_path": str(stderr_path),
            "stderr_excerpt": excerpt(executed["stderr"]),
            "case": {
                "why": case.get("why"),
                "study_inputs_note": case.get("study_inputs_note"),
                "pot": case.get("pot"),
                "effective_stack": case.get("effective_stack"),
                "board": case.get("board"),
                "oop_range": case.get("oop_range"),
                "ip_range": case.get("ip_range"),
                "algorithm": case.get("algorithm"),
                "iteration_cap": case.get("iteration_cap"),
                "eval_interval": case.get("eval_interval"),
                "eval_interval_source": case.get("eval_interval_source"),
                "memory_mib": case.get("memory_mib"),
                "memory_note": case.get("memory_note"),
                "betting_note": case.get("betting_note"),
                "source_path": case.get("source_path"),
            },
        }
        records.append(record)
        print(
            f"{case['id']}: {outcome} exit={executed['exit_code']} "
            f"wall={executed['wall_seconds']}",
            flush=True,
        )

    payload = {
        "schema": "study-benchmark-results-1",
        "nashconv_definition": (
            "player0_best_response_utility + player1_best_response_utility"
        ),
        "quality_target_nashconv_over_pot": TARGET,
        "nashconv_over_pot_derivation": (
            "The runner computes nash_gap / pot when both were printed. "
            "That quotient is not a solver field."
        ),
        "timing_label": args.timing_label,
        "dry_run": bool(args.dry_run),
        "source": source,
        "host": host,
        "build": build,
        "cases": records,
    }
    results_path = output_dir / "results.json"
    summary_path = output_dir / "summary.md"
    write_text(results_path, json.dumps(payload, indent=2) + "\n")
    write_summary(summary_path, payload)
    print(f"wrote {results_path}")
    print(f"wrote {summary_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

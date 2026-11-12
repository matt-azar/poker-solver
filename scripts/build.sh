#!/usr/bin/env bash
# Local Zig build + test entry point (mirrors .github/workflows/zig.yml defaults).
# Default -Dcpu=x86_64_v2 matches Windows CI/installer so local packs stay portable
# (override with ZIG_CPU=native for host-only digs).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CPU="${ZIG_CPU:-x86_64_v2}"
zig build -Doptimize="${ZIG_OPTIMIZE:-ReleaseFast}" -Dcpu="${CPU}"
zig build test -Dcpu="${CPU}"

if [[ -x ./zig-out/bin/solver-engine ]]; then
  BIN=./zig-out/bin/solver-engine
elif [[ -x ./zig-out/bin/solver-engine.exe ]]; then
  BIN=./zig-out/bin/solver-engine.exe
else
  echo "solver-engine missing under zig-out/bin" >&2
  exit 1
fi
python3 scripts/zig/ready-smoke.py "$BIN"
python3 scripts/zig/study-contract-smoke.py "$BIN"
# ZR-143: kill sidecar mid-session → cold restart cannot restore unsaved;
# open last saved checkpoint restores disk only (Linux cloud; Windows installer
# kill remains ZR-147).
python3 scripts/zig/engine-crash-recovery-smoke.py "$BIN"
# ZR-152: overlapping Solve/Stop/Continue/Open/nav with analysis in flight;
# late replies must not overwrite solution; memory settles; stdin EOF exits.
# Windows packaged Study overlap suite waits for ma1pc (ZR-147 follow-up).
python3 scripts/zig/study-overlap-actions-smoke.py "$BIN"

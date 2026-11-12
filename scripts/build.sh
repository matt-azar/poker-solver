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
  python3 scripts/zig/ready-smoke.py ./zig-out/bin/solver-engine
elif [[ -x ./zig-out/bin/solver-engine.exe ]]; then
  python3 scripts/zig/ready-smoke.py ./zig-out/bin/solver-engine.exe
else
  echo "solver-engine missing under zig-out/bin" >&2
  exit 1
fi

#!/usr/bin/env bash
# Local Zig build + test entry point (mirrors .github/workflows/zig.yml defaults).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

zig build -Doptimize="${ZIG_OPTIMIZE:-ReleaseFast}"
zig build test

if [[ -x ./zig-out/bin/solver-engine ]]; then
  python3 scripts/zig/ready-smoke.py ./zig-out/bin/solver-engine
elif [[ -x ./zig-out/bin/solver-engine.exe ]]; then
  python3 scripts/zig/ready-smoke.py ./zig-out/bin/solver-engine.exe
else
  echo "solver-engine missing under zig-out/bin" >&2
  exit 1
fi

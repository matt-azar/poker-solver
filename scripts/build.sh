#!/usr/bin/env bash
# Shared local configure/build/test entry point (mirrors CI Release defaults).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-$ROOT/build}"
BUILD_TYPE="${BUILD_TYPE:-Release}"
BUILD_BENCHMARKS="${BUILD_BENCHMARKS:-ON}"
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"

cmake -S "$ROOT" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
  -DBUILD_TESTING=ON \
  -DPOKER_SOLVER_BUILD_BENCHMARKS="$BUILD_BENCHMARKS"

cmake --build "$BUILD_DIR" --parallel "$JOBS" \
  --target river_solver \
  --target street_solver --target explorer --target equity_calculator \
  --target poker_solver_tests --target poker_engine_tests \
  --target poker_study_tests --target poker_http_tests \
  --target equity_tests --target equity_calculator_tests

if [[ "$BUILD_BENCHMARKS" == "ON" ]]; then
  cmake --build "$BUILD_DIR" --parallel "$JOBS" \
    --target street_memory_bench --target street_betting_bench \
    --target street_parallel_bench
fi

ctest --test-dir "$BUILD_DIR" --output-on-failure

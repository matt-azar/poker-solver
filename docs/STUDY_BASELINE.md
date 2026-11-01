# Study baseline

Everyday postflop study surface after the river / street / pause / locking integrates on `main`.

Product entry points: `explorer` + Study UI (`desktop/`), `street_solver`, and `river_solver` (thin five-card CLI onto `StreetBatchSolver`). Living status: [FEATURE_PARITY.md](FEATURE_PARITY.md). Ordered work: [ROADMAP.md](ROADMAP.md).

## In place

- Shared flop/turn/river public tree (`StreetBatchSolver`); five-card pins against `RiverGame`
- Conditional action EV, check-down equity (+ buckets), made-hand categories on five-card boards
- Stop-and-keep, pause/continue, accuracy and wall-clock stopping
- Versioned PSOL save/open/continue; recent-files list; street-config templates; named range presets
- Node locks, resolve-locked, baseline compare (street-first in explorer)
- Pot rake, optional ICM, optional action-label incentives on street/river terminals
- Windows NSIS installer for Holdem Study ([DESKTOP_UI.md](DESKTOP_UI.md))

## Still open

- Visual tree editor; compact/lazy saves; runout aggregation and durable batch queue
- Draw/backdoor categories; richer strategy editing beyond lock rows
- Dual-utility best response under incentives; explorer incentive Job JSON
- Trainer packs/drills; preflop
- Code-signed Windows release; Pio matched quality/timing runs

## Validation

```sh
CXX=g++ cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
./build/poker_solver_tests
```

Explorer HTTP tests spawn on Linux and Windows. Prefer the weighted multi-combo persistence case in `tests/unit/test_explorer_http.cpp` when changing Continue/Open/session.

Study-corpus measurements: [benchmarks/study/RESULTS.md](../benchmarks/study/RESULTS.md).

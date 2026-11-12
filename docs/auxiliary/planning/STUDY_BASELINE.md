# Study baseline

Everyday postflop study surface after the river / street / pause / locking integrates on `main`.

Product entry points: Study UI (`desktop/`), C++ `explorer` (browser development and packaged HTTP fallback), Zig `solver-engine` (packaged shell, started first), `street_solver`, and `river_solver` (thin five-card CLI onto `StreetBatchSolver`). Living status: [FEATURE_PARITY.md](FEATURE_PARITY.md). Ordered work: [ROADMAP.md](ROADMAP.md).

## In place

- Shared flop/turn/river public tree (`StreetBatchSolver`); five-card pins against `RiverGame`
- Conditional action EV, check-down equity (+ buckets and an OOP vs IP chart), made-hand categories on five-card boards, flop/turn draw and backdoor tags
- Stop-and-keep, pause/continue, accuracy and wall-clock stopping
- Versioned PSOL save/open/continue; recent-files list; street-config templates; named range presets; Build betting-tree catalogue
- Node locks, resolve-locked, baseline compare, and session strategy edits (street-first in explorer)
- Build preview tree with force/remove/add-size edits and a memory-plan dry run
- Pot rake, optional ICM, optional action-label incentives on street/river terminals, including explorer job JSON
- Windows NSIS installer for Holdem Study ([DESKTOP_UI.md](../../DESKTOP_UI.md)). The published `v0.1.2-windows` build starts `holdem-explorer` on port 8765. This tree's installer also ships `solver-engine` and starts that sidecar first.
- Zig `solver-engine`: CFR+ over IPC protocol 2, PSOL v4. The Study client sends status, solve, and root action values over IPC. Other Study calls still use HTTP. Quality cutover is not recorded ([ZIG_RELEASE_GATES.md](../engineering/ZIG_RELEASE_GATES.md)).

## Still open

- Compact/lazy saves; a dedicated runout-aggregation endpoint and a durable batch queue
- Trainer packs/drills; preflop
- Code-signed Windows release; Pio matched quality/timing runs

## Validation

```sh
CXX=g++ cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

`poker_solver_tests` is a CMake target that builds `poker_engine_tests`, `poker_study_tests`, and `poker_http_tests`. It is not an executable.

Explorer HTTP tests spawn on Linux and Windows. Prefer the weighted multi-combo persistence case in `tests/unit/test_explorer_http.cpp` when changing Continue/Open/session. Desktop lifecycle acceptance (Build → solve → pause/inspect → save/open/continue → lock/compare) is `tests/unit/test_explorer_workflow.cpp`; Windows packaged Tauri/NSIS remains a manual release gate.

Study-corpus measurements: [benchmarks/study/RESULTS.md](../../../benchmarks/study/RESULTS.md).

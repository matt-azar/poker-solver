# Study baseline

Everyday postflop study surface on `zig-rewrite`.

Product entry points: Zig `solver-engine` + Study UI (`desktop/`). Living status: [FEATURE_PARITY.md](FEATURE_PARITY.md). Ordered work: [ROADMAP.md](ROADMAP.md). The C++ `explorer` / `street_solver` / CMake validation path is removed.

## In place

- Shared flop/turn/river public tree (`StreetBatchSolver`); five-card pins against `RiverGame`
- Conditional action EV, check-down equity (+ buckets and an OOP vs IP chart), made-hand categories on five-card boards, flop/turn draw and backdoor tags
- Stop-and-keep, pause/continue, accuracy and wall-clock stopping
- Versioned PSOL save/open/continue; recent-files list; street-config templates; named range presets; Build betting-tree catalogue
- Node locks, resolve-locked, baseline compare, and session strategy edits (street-first in explorer)
- Build preview tree with force/remove/add-size edits and a memory-plan dry run
- Pot rake, optional ICM, optional action-label incentives on street/river terminals, including explorer job JSON
- Windows NSIS installer for Holdem Study ([DESKTOP_UI.md](../../DESKTOP_UI.md))

## Still open

- Compact/lazy saves; a dedicated runout-aggregation endpoint and a durable batch queue
- Trainer packs/drills; preflop
- Code-signed Windows release; Pio matched quality/timing runs

## Validation

```sh
zig build -Doptimize=ReleaseFast
zig build test
cd desktop && npm ci && npm test && npm run build
```

Windows packaged Tauri/NSIS remains a manual release gate (Actions → **Windows Installer**).

Study-corpus measurements: [benchmarks/study/RESULTS.md](../../../benchmarks/study/RESULTS.md).

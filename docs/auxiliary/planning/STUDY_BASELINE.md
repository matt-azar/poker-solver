# Study baseline

Everyday postflop study surface on `zig-rewrite`.

Product entry points: Zig `solver-engine` + Study UI (`desktop/`). Living status: [FEATURE_PARITY.md](FEATURE_PARITY.md). Ordered work: [ROADMAP.md](ROADMAP.md). The C++ `explorer` / `street_solver` / CMake validation path is removed.

## In place

- Shared flop/turn/river public tree in Zig Session; math docs may still say `StreetBatchSolver` / `RiverGame` as historical vocabulary
- Conditional action EV, check-down equity (+ buckets and an OOP vs IP chart), made-hand categories on five-card boards, flop/turn draw and backdoor tags
- Stop-and-keep, pause/continue, accuracy and wall-clock stopping (Acc walls are not cutover blockers)
- Versioned PSOL save/open/continue; recent-files list; street-config templates; named range presets; Build betting-tree catalogue
- Node locks, resolve-locked, and session strategy edits over typed IPC
- Build preview tree with force/remove/add-size edits and a memory-plan dry run (`tree_preview` / `plan_memory`)
- Pot rake on the Zig compile/terminal path
- Windows NSIS installer for Holdem Study — Zig `solver-engine` only ([DESKTOP_UI.md](../../DESKTOP_UI.md))

## Still open

- Compact/lazy saves; durable batch queue; dual-session Compare over IPC; host `runouts`
- **ICM Study solves (ZR-93):** reject until complete; low priority — not a near-term release blocker
- Trainer packs/drills; preflop
- Code-signed Windows release; Pio matched quality/timing runs

## Validation

```sh
zig build -Doptimize=ReleaseFast -Dcpu=x86_64_v2
zig build test -Dcpu=x86_64_v2
python3 scripts/zig/study-contract-smoke.py ./zig-out/bin/solver-engine
cd desktop && npm ci && npm test && npx tsc -b && npm run build
```

Windows packaged Tauri/NSIS remains a release gate (Actions → **Windows Installer**). See [TESTING.md](../engineering/TESTING.md).

Study-corpus fixtures: [benchmarks/study/](../../../benchmarks/study/) (historical C++ runner notes are not the Zig ship path).

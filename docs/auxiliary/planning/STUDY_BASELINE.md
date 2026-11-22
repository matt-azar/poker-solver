# Study baseline

Everyday postflop study surface on `main`.

Product entry points: Zig `solver-engine` and the Study UI (`desktop/`). Living status: [FEATURE_PARITY.md](FEATURE_PARITY.md). Ordered work: [ROADMAP.md](ROADMAP.md).

## In place

- Study page: node navigation above the range matrix, a permanent right rail (Actions and the combo inspector), and a lower dock. The status bar holds Solve, Continue, Pause, Stop, Iter, EV, and Acc. Chrome is dark-only
- Shared flop, turn, and river public tree in the Zig Session
- Conditional action EV, check-down equity (+ buckets and an OOP vs IP chart), made-hand categories on five-card boards, flop/turn draw and backdoor tags. There is no Runouts tab.
- Stop-and-keep, pause/continue, accuracy and wall-clock stopping (Acc walls are not cutover blockers)
- Versioned PSOL save/open/continue. Save mode **Study** sends `study_only: true` and drops trainer tables. Save mode **Continue** keeps them. In-app solutions catalogue (folders) plus Library recent list; street-config templates; named range presets; Build betting-tree catalogue
- Precomputed public Study demo (`desktop/src/demo/README.md`) and a limited five-card river browser beta (`services/river-beta/README.md`). Neither replaces the Windows Tauri product.
- Node locks, resolve-locked, and session strategy edits over typed IPC
- Build preview tree with force/remove/add-size edits and a memory-plan dry run (`tree_preview` / `plan_memory`). The preview section and its decision branches start collapsed. The plan strip shows Plan peak, Budget, decision count, deal count, pot, and stack.
- Portable `holdem-study-job/1` files. Build Export job / Import job and `holdem-study-cli` (`plan`, `solve`, `from-hh`) share that JSON. `from-hh` accepts five-card `hand-history 1` only. Settings shows CFR+ only.
- Pot rake, ICM, and path incentives when `street-config 1` lists them. Settings has a Use ICM checkbox. NashConv is then modeled utility. Continue stays off on ICM saves that lack `flag_icm_modeled_train`
- Windows NSIS installer for Holdem Study — Zig `solver-engine` only ([DESKTOP_UI.md](../../DESKTOP_UI.md))

## Still open

- Pio multi-file compact library; durable batch queue; a host `runouts` op (the host has none; Study has no Runouts tab)
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

Study-corpus fixtures: [benchmarks/study/](../../../benchmarks/study/).

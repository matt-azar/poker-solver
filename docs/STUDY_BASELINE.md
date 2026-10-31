# Study baseline

Branch: `main` at `abe999f` (merge of locking integrate #38). Planning date: October 30, 2026.

This is the consolidated everyday-study baseline after the river / study / pause / capacity / locking integrate set.

## Included

1. River / five-card / payoff / solve-control integrate (`cursor/river-integrate-c006`, #34)
2. Linux explorer HTTP coverage (#6) and weighted multi-combo save/open/continue under value load
3. Equity work-limit default for full-range rivers (#32)
4. Range undo/redo (#11)
5. Hand categories (#7)
6. Equity distribution buckets (#18)
7. Recent PSOL files (#21)
8. Street-config templates (#17)
9. Named range presets (#25)
10. GUI pause at a completed chunk with Continue on the same solution (#36 / #13)
11. Study street-config cases and `--plan-memory` (#37 / #2 / #30)
12. Node-lock model and enforcement in `CfrTrainer` and `StreetBatchSolver` (#38 / #14 / #23 / #33)

## Explicitly deferred / partial

- Node locking end-to-end is on the locking branch (GUI lock inputs, PSOL v2, resolve-locked + baseline compare); RiverBatch still ignores locks; warm-start remains reset-from-zero
- Memory planning still constructs a temporary engine; it is not a cheap pre-allocation feasibility check
- Full-range river equity is admitted by default; full-range turn equity still exceeds the default work limit
- Rake is not connected to solving; ICM and incentives remain separate open PRs
- Tree editing (#19/#27), hand-history export (#26), shortcuts (#22), themes (#31), and agent lessons (#9) remain open

## Validation

The final integration branch passed Windows, Linux, and Linux-sanitizer CI. Its PR reports 440,776 assertions, zero failures. No separate CI run was returned for merge commit `abe999f` itself.

```sh
CXX=g++ cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
./build/poker_solver_tests
```

Explorer HTTP tests spawn on Linux and Windows. Prefer the weighted multi-combo persistence case in `tests/unit/test_explorer_http.cpp` when changing Continue/Open/session.

## Follow-ups on this baseline

1. Study-corpus measurements at `abe999f` are recorded in `benchmarks/study/RESULTS.md` (Linux quiet host). Finish the flop case to the iteration cap or 0.001 target on a machine with more free RAM / wall.
2. Explorer GUI/API now exposes `time_limit` and `samples` (eval chunks) with `time_limit_reached` on status.
3. Node locking end-to-end landed on the locking branch (GUI, PSOL v2, resolve-locked + baseline compare). Remaining: RiverBatch locks, richer strategy editing, warm-start from prior regrets

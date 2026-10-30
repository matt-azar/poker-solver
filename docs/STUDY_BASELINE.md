# Study baseline

Branch: `cursor/study-baseline-c006`. Planning date: October 30, 2026.

This branch is the integrated everyday-study baseline recommended after river integration (#34).

## Included

1. River / five-card / payoff / solve-control integrate (`cursor/river-integrate-c006`, #34)
2. Linux explorer HTTP coverage (#6)
3. Automated weighted multi-combo solve → EV → save → open → continue workflow (with pending `/values` during Open/Continue)
4. Equity work-limit default for full-range rivers (#32)
5. Range undo/redo (#11)
6. Hand categories (#7)
7. Equity distribution buckets (#18)
8. Recent PSOL files (#21)
9. Street-config templates (#17)
10. Named range presets (#25)

## Explicitly deferred / partial

- Pause (#13): must be reconciled carefully with claim/quiet session changes
- Node locking / tree-edit apply: not a finished study feature; `AddSize` may be stored without apply
- Rake / ICM / incentives: not safe configuration switches while training uses zero-sum scalar utilities
- Themes, shortcuts, hand-history, memory-plan: useful, not required for the configure/solve/inspect/save/continue criterion

## Validation

```sh
CXX=g++ cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
./build/poker_solver_tests
```

Explorer HTTP tests spawn on Linux and Windows. Prefer the weighted multi-combo persistence case in `tests/unit/test_explorer_http.cpp` when changing Continue/Open/session.

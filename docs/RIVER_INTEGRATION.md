# River-overlapping branch integration

Branch: `cursor/river-integrate-c006`. Planning date: October 30, 2026.

This branch merges the open stacks that share river / five-card / payoff / solve-control surfaces so they can be validated together before landing on `main` one-by-one.

## Merge order

1. `#5` `payoff-dual-utility` — `PlayerPayoff` / `ChipPayoff` on `RiverGame`
2. `#12` `street-payoff` — `StreetGame::terminal_payoff` via `ChipPayoff`
3. `#15` `rake-payoff` — pot-rake on `ChipPayoff` (sibling of `#12`; docs/tests combined)
4. `#8` `explorer-street-river` (includes `#4` five-card) — explorer + `StreetBatch` for 3/4/5-card boards
5. `#3` `river-action-ev` — `RiverBatch` conditional EV fixtures; explorer keeps the shared street path for five-card
6. `#29` `eval-cadence` (includes `#10` time-limit + `#16` nash-history)
7. `#24` `strategy-report` — `--report` coexists with `--time-limit` / `--eval-every`

## Resolution rules used

- **Explorer five-card path:** always `StreetBatchSolver` for new solves (`#8`). `RiverBatchSolver` remains for older river-kind PSOL open and for `river_solver` CLI / oracle tests from `#3`.
- **M8 siblings `#12` + `#15`:** keep StreetGame pins and call `run_rake_tests()`.
- **CLI usage:** union of flags (`--time-limit`, `--eval-every`, `--report`).

## Validation

```sh
CXX=g++ cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
./build/poker_solver_tests
# expected: failed=0 (explorer HTTP still SKIP on Linux in this suite)
```

Not yet folded in (separate stacks, less river-overlap): node locks (`#14`/`#23`/`#33`), ICM/incentives (`#20`/`#28`), UI-only tracks, templates/range libs.

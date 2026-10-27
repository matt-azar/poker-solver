# Roadmap

| Phase | Status |
| --- | --- |
| 1. Repository, CMake, tests | Complete |
| 2. Kuhn Poker + vanilla CFR | Complete |
| 3. Generalized CFR engine + CFR+ | Complete |
| 4. Leduc Hold’em | Complete |
| 5. Hold’em cards, evaluator, ranges | Complete |
| 6. Heads-up river solver | Complete |
| 7. Performance optimization | Complete |
| 8. Turn and flop solving | Not started |
| 9. Graphical strategy explorer | Not started |
| 10. Full HUNL research | Not started |

Phase 7 is complete: `RiverBatchSolver` stores the river betting tree once, applies the same per-deal CFR update as `CfrTrainer<RiverGame>`, and replaces the per-information-set best response with one walk of that tree. `--reference` keeps the enumerator. Measured times are in [BENCHMARKS.md](BENCHMARKS.md).

## Next work (Phase 8)

- Add a turn tree: four-card board, turn betting, then a uniform river, then river betting
- Add a flop tree that deals the turn and the river
- Keep information sets free of the opponent's cards and of cards that are not yet dealt
- Check exact values on tiny ranges before any bucketing

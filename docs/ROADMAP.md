# Roadmap

| Phase | Status |
| --- | --- |
| 1. Repository, CMake, tests | Complete |
| 2. Kuhn Poker + vanilla CFR | Complete |
| 3. Generalized CFR engine + CFR+ | Complete |
| 4. Leduc Hold’em | Complete |
| 5. Hold’em cards, evaluator, ranges | Complete |
| 6. Heads-up river solver | Complete |
| 7. Performance optimization | Not started |
| 8. Turn and flop solving | Not started |
| 9. Graphical strategy explorer | Not started |
| 10. Full HUNL research | Not started |

Phase 6 is complete: `river_solver` solves a configurable heads-up river on `CfrTrainer`, with card removal, exact best response, and a Nash gap that falls on the tested trees. See [RIVER.md](RIVER.md).

## Next work (Phase 7)

- Profile the river traversal before changing it
- Keep this enumeration as the reference solver
- Speed up wide ranges without changing the reported strategies on the games already tested

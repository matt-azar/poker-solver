# Roadmap

| Phase | Status |
| --- | --- |
| 1. Repository, CMake, tests | Complete |
| 2. Kuhn Poker + vanilla CFR | Complete |
| 3. Generalized CFR engine + CFR+ | Complete |
| 4. Leduc Hold’em | Complete |
| 5. Hold’em cards, evaluator, ranges | Complete |
| 6. Heads-up river solver | Not started |
| 7. Performance optimization | Not started |
| 8. Turn and flop solving | Not started |
| 9. Graphical strategy explorer | Not started |
| 10. Full HUNL research | Not started |

Phase 5 is complete: card ids, the seven-card evaluator, and 1,326-hand ranges pass `tests/unit/test_holdem.cpp`. The river solver has not been started. See [HOLDEM.md](HOLDEM.md).

## Next work (Phase 6)

- A heads-up no-limit river tree on the shared `CfrTrainer`
- Fixed bet sizes, card removal, and ranges as the chance distribution
- Exact best response and Nash gap on that river tree

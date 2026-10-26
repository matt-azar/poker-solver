# Roadmap

| Phase | Status |
| --- | --- |
| 1. Repository, CMake, tests | Complete |
| 2. Kuhn Poker + vanilla CFR | Complete |
| 3. Generalized CFR engine + CFR+ | Not started |
| 4. Leduc Hold’em | Not started |
| 5. Hold’em cards, evaluator, ranges | Not started |
| 6. Heads-up river solver | Not started |
| 7. Performance optimization | Not started |
| 8. Turn and flop solving | Not started |
| 9. Graphical strategy explorer | Not started |
| 10. Full HUNL research | Not started |

Phase 3 must not start until Phase 2 completion criteria remain green: \(u_1 \to -1/18\), Nash gap \(\to 0\), reproducible runs, no hardcoded strategies.

## Next work (Phase 3)

- Extract game-state, legal actions, infosets, chance, and terminals behind an interface
- Run Kuhn through that interface with vanilla CFR and CFR+
- Iteration-weighted averaging for CFR+
- Configurable max iterations and Nash-gap threshold
- Report iteration count, runtime, memory estimate, average strategy, Nash gap, and expected utility on every solver test

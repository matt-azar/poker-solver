# Roadmap

| Phase | Status |
| --- | --- |
| 1. Repository, CMake, tests | Complete |
| 2. Kuhn Poker + vanilla CFR | Complete |
| 3. Generalized CFR engine + CFR+ | Complete |
| 4. Leduc Hold’em | Complete |
| 5. Hold’em cards, evaluator, ranges | Not started |
| 6. Heads-up river solver | Not started |
| 7. Performance optimization | Not started |
| 8. Turn and flop solving | Not started |
| 9. Graphical strategy explorer | Not started |
| 10. Full HUNL research | Not started |

Phase 4 is complete when Leduc runs on `CfrTrainer` without a change to the regret update, chance and card removal are tested, information sets hide the opponent's card, terminal payoffs sum to zero, and the Nash gap falls.

## Next work (Phase 5)

- Cards 0..51 with rank and suit
- A seven-card hand evaluator, tested on wheels, full houses, flushes, and board ties
- 1,326-hand ranges, dead-card removal, and the joint distribution `w1(h1) w2(h2)` on disjoint hands

# Roadmap

| Phase | Status |
| --- | --- |
| 1. Repository, CMake, tests | Complete |
| 2. Kuhn Poker + vanilla CFR | Complete |
| 3. Generalized CFR engine + CFR+ | Complete |
| 4. Leduc Hold’em | Not started |
| 5. Hold’em cards, evaluator, ranges | Not started |
| 6. Heads-up river solver | Not started |
| 7. Performance optimization | Not started |
| 8. Turn and flop solving | Not started |
| 9. Graphical strategy explorer | Not started |
| 10. Full HUNL research | Not started |

Phase 3 is complete when Kuhn’s value still approaches \(-1/18\) and the Nash gap still falls, for both vanilla CFR and CFR+, through `CfrTrainer` rather than a Kuhn-only traversal.

## Next work (Phase 4)

- Six-card Leduc: two copies of three ranks, one private card, one public card, two fixed-limit betting rounds
- Document antes, bet sizes, and the raise cap
- Reuse `CfrTrainer` without changing the regret update
- Check chance probabilities, card removal, hidden-card information sets, zero-sum terminals, and a shrinking Nash gap

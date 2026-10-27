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
| 8. Turn and flop solving | Complete |
| 9. Graphical strategy explorer | Not started |
| 10. Full HUNL research | Not started |

Phase 8 is complete: `StreetGame` deals the river after a turn, or the turn and the river after a flop, and bets on each street. Information sets omit the opponent's cards and any card not yet dealt. Check-down values match an independent runout average. See [STREETS.md](STREETS.md).

## Next work (Phase 9)

- A local strategy explorer that does not link into the CFR core
- Configure a river (board, ranges, pot, stacks, bet sizes), run it, and stop it
- Inspect the average strategy, per-hand frequencies, and the Nash gap from that UI

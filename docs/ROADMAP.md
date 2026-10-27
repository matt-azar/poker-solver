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
| 9. Graphical strategy explorer | Complete |
| 10. Full HUNL research | Not started |

Phase 9 is complete: `explorer` serves `ui/` on `127.0.0.1` and solves a river with `RiverBatchSolver`. The page sets the spot, runs or stops, and shows the matrix, the line, and the Nash gap. The CFR core does not include the page. See [EXPLORER.md](EXPLORER.md).

## Next work (Phase 10)

- Write down why unrestricted no-limit Hold'em is not solved by the trees in this repository
- Compare one additional CFR weighting, with a measured run, against vanilla CFR on a game already solved here
- Leave abstraction, sampling, subgame solving, and storage as research notes rather than a claimed full solve

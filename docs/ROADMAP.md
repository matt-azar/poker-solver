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
| 10. Full HUNL research | Complete |

Phase 10 is a limit, not a solve. Unrestricted heads-up no-limit Hold'em is not computed by these trees. [HUNL.md](HUNL.md) records that, and records one measured alternative weighting, linear CFR, on Kuhn.

## Toward a Pio-style heads-up solver

PioSOLVER solves an action abstraction of heads-up no-limit Hold'em, not every legal chip amount. Matching it means a player can set a postflop tree, solve to a pot-fraction Nash gap, read the strategy, and do the same from a preflop tree into a chosen set of flops. It does not mean reproducing PioSOLVER's unpublished CFR code.

1. Combo-parallel postflop CFR. One pass over the public tree, strategy held fixed during the pass, every combo updated together. `StreetGame` stays the exact per-deal reference for small trees, with its own 200,000-terminal enumerator limit. The batch solver's limit is a 1024 MiB solver-owned heap budget. A uniform full-range check-down on `Ah Kd 7c` builds, trains one frozen CFR+ iteration, and evaluates value and best response inside that budget. The frozen pass splits the first future public card across the requested threads. A narrower regret type is still open. On the half-pot turn and the paired flop, 300 frozen CFR+ iterations reached NashConv/pot below 0.001, and training was more than 95 percent of the wall time while the allocation stayed flat.
2. The public tree builder has donk sizes, a fixed chip amount, a raise multiple, a pot cap, and a switch that removes the 3-bet. Lines stay the same on every runout. Merging two sizes that land on the same chip amount is already how equal amounts are stored.
3. The explorer solves a flop, a turn, or a river, and ranges are painted on a 13×13 grid. Node locking is still open.
4. Nested saves. Solve a flop, keep the reaching ranges, re-solve one turn card, then one river. That is a subgame with the ranges it was given, not a safe gadget.
5. Preflop with a listed set of flops. Blinds, a short bet list, and the postflop solver on each listed flop. Isomorphic flops come after a measured subset.
6. A narrower regret type, if a test still shows the Nash gap falling. The frozen pass already takes a thread count, and the showdown walk uses the compact card prefixes. Evaluation and DCFR are still open. The paired reset-30 comparison of that kernel against `e2ad8df` is in [BENCHMARKS.md](BENCHMARKS.md).

Unrestricted heads-up no-limit, with every chip size legal, stays out of reach. A solved tree is an equilibrium of the sizes that were offered.

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

1. Combo-parallel postflop CFR. One pass over the public tree, strategy held fixed during the pass, every combo updated together. `StreetGame` stays the exact per-deal reference for small trees. The parallel pass is checked by value and Nash gap. This is the step that lets a flop with ordinary ranges finish. The first pass is `--frozen`: it is measured on the one-combo turn lock, and it is not yet the fast path for a wide flop.
2. The rest of the public tree builder. Donk sizes, a fixed chip amount, a raise that is a multiple of the bet, a cap on bets, and a switch that removes the 3-bet. Lines stay the same on every runout.
3. The explorer on the turn and the flop, then node locking.
4. Nested saves. Solve a flop, keep the reaching ranges, re-solve one turn card, then one river. That is a subgame with the ranges it was given, not a safe gadget.
5. Preflop with a listed set of flops. Blinds, a short bet list, and the postflop solver on each listed flop. Isomorphic flops come after a measured subset.
6. Threads, then a narrower regret type if a test still shows the Nash gap falling.

Unrestricted heads-up no-limit, with every chip size legal, stays out of reach. A solved tree is an equilibrium of the sizes that were offered.

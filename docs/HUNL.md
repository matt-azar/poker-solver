# Unrestricted heads-up no-limit Hold'em

The solvers in this repository find an equilibrium of a finite game: Kuhn, six-card Leduc, a river with a fixed list of bet sizes, or a turn or flop small enough to enumerate. That is not an equilibrium of unrestricted heads-up no-limit Texas Hold'em.

Unrestricted HUNL deals two hole cards from a 52-card deck and then three streets of board cards. At every decision a player may fold, call, or bet any legal chip amount up to the stack. The exact extensive form of that game does not fit in memory on a commodity machine, and this repository does not claim to solve it. The largest exact trees measured here are a `22+` versus `22+` river with two bet sizes (882 information sets) and a check-only flop with one combo each (4,052 information sets). Both are abstractions. See [BENCHMARKS.md](BENCHMARKS.md).

## What would still have to be chosen

**Action abstraction.** The river, turn, and flop solvers offer a list of pot fractions, not every chip amount. An equilibrium of that list is not an equilibrium of the game in which the opponent can choose a size that was left out.

**Hand abstraction and bucketing.** The river solver keeps one information set per combo. Bucketing would merge combos that the real game can tell apart, on the flop or turn or by a feature such as equity. That changes the game. The error is the exploitability of the resulting strategy in the unbucketed game. It is not measured here, because the unbucketed multi-street game is the one that does not fit.

**Preflop.** A preflop tree multiplies the hand pairs by the flop, turn, and river runouts and by every later betting line. Solving it exactly, with no abstraction, is the same obstacle as the full game. A preflop abstract game would need both a bet-size list and a hand abstraction, and then a measured check against a finer game. This repository does not build that preflop tree.

**Monte Carlo CFR.** MCCFR samples outcomes or information sets instead of walking every one. The traversals here are exact. Sampling would trade variance for a larger tree. It is not implemented, and there is no sampled run to report.

**Discounted CFR.** Discounted CFR scales the current regrets and the average strategy by a function of the iteration. Linear CFR is the case that weights iteration `t` by `t`. It is implemented for the shared trainer, on Kuhn, below. It is not a solution of HUNL.

**Subgame solving.** Libratus-style resolving, continual resolving, and safe subgames re-solve the public state in front of the players, with a gadget that accounts for the opponent's range, instead of storing the whole game. The river solver takes a pot and two ranges and solves that river exactly. It does not build a gadget, and it does not claim that the input ranges are safe.

**Exploitability.** The Nash gap reported everywhere in this repository is NashConv, `u0(BR0) + u1(BR1)`, computed by an exact best response on the game that was solved. It is not an estimate of exploitability in unrestricted HUNL.

**Storage and threads.** Regrets and the average strategy are two arrays of doubles in memory. A larger abstract game needs compression or disk-backed tables, and a parallel traversal needs a split of the tree that still applies the same regret update. Neither is implemented. There is no measured speedup to report.

## Linear CFR on Kuhn

Linear CFR uses the same regret-matching rule as vanilla CFR. On iteration `t` (starting at 1) it multiplies both the new regret and the average-strategy contribution by `t`. It does not floor regrets. Both players update in one traversal. CFR+ is unchanged: it floors regrets, weights only the average strategy by `t`, and alternates the player who updates.

Same machine as the other Kuhn rows. Command: `kuhn_solver --iterations 10000 --algorithm <name>`.

| Algorithm | Iterations | Runtime (s) | Iterations/s | Player 1 value | Nash gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| vanilla CFR | 10000 | 0.0140505 | 7.117e5 | -0.0555306025757 | 0.00297179826288 |
| linear CFR | 10000 | 0.0166417 | 6.009e5 | -0.0555625698041 | 0.00591309307769 |

`-1/18` is -0.0555555555556. At 10,000 iterations linear CFR is closer to that value. Vanilla CFR has the smaller Nash gap. The unit test also checks that 2,000 iterations of linear CFR are deterministic, that its strategy is not the vanilla strategy, and that some cumulative regret is still negative.

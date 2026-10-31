# Unrestricted heads-up no-limit Hold'em

The solvers in this repository find an equilibrium of a finite game: Kuhn, six-card Leduc, a river with a fixed list of bet sizes, or a turn or flop small enough to enumerate.

Unrestricted HUNL deals two hole cards from a 52-card deck and then three streets of board cards. At every decision a player may fold, call, or bet any legal chip amount up to the stack. The exact extensive form of that game exceeds the memory of a commodity machine. The largest exact tree measured here is a uniform full-range check-down on `Ah Kd 7c`: 5,197,920 stored information sets and about 399 MiB of solver-owned heap, inside the default 1024 MiB budget. Expanded histories on that tree are in the billions. The solver stores the information sets. A `22+` versus `22+` river with two bet sizes (882 information sets) and a one-combo check-only flop (4,052 information sets) remain small checked abstractions. See [BENCHMARKS.md](BENCHMARKS.md).

## What would still have to be chosen

**Action abstraction.** The river, turn, and flop solvers offer a list of pot fractions. The turn and flop tree uses one betting structure for every runout, with a separate list per street, a geometric size, and an all-in threshold. Those are the public tree-building rules of PioSOLVER. An equilibrium of that list is an equilibrium of the offered sizes. The CFR code in this repository is this project's.

**Hand abstraction and bucketing.** The river solver keeps one information set per combo. Bucketing would merge combos that the real game can tell apart, on the flop or turn or by a feature such as equity. That changes the game. The error is the exploitability of the resulting strategy in the unbucketed game. Measuring it requires the unbucketed multi-street game, which exceeds commodity memory.

**Preflop.** A preflop tree multiplies the hand pairs by the flop, turn, and river runouts and by every later betting line. Solving it exactly, with the cards left unbucketed, meets the same memory limit as the full game. A preflop abstract game would need both a bet-size list and a hand abstraction, and then a measured check against a finer game. The current code has no preflop tree.

**Monte Carlo CFR.** MCCFR samples outcomes or information sets. The traversals here walk every outcome. A sampled run would trade variance for a larger tree. This repository has no sampled run.

**Discounted CFR.** Discounted CFR scales the current regrets and the average strategy by a function of the iteration. Linear CFR is the case that weights iteration `t` by `t` on both the regret increment and the average. Fixed DCFR(α=1.5, β=0, γ=2) (Brown and Sandholm, AAAI 2019) is an optional production algorithm: alternating OOP/IP frozen passes, signed regrets discounted once per completed pass with `t^1.5/(t^1.5+1)` on positives and `0.5` on non-positives, and average weight `t^2`. CFR+ remains the default. See [STREETS.md](STREETS.md).

**Subgame solving.** Libratus-style resolving, continual resolving, and safe subgames re-solve the public state in front of the players, with a gadget that accounts for the opponent's range. The river solver takes a pot and two ranges and solves that river. The caller supplies the ranges.

**Exploitability.** The Nash gap reported everywhere in this repository is NashConv, `u0(BR0) + u1(BR1)`, computed by an exact best response on the game that was solved.

**Storage and threads.** The street solver charges bytes it requests from its allocator against `memory_mib`. `allocated_bytes` is that live total. `estimated_peak_bytes` is a separate plan. `reserved_bytes` is unused reservation credit. The regret array plus the strategy-sum array is one component, reported as `regret_strategy_sum_bytes`. Process RSS is reported separately when the operating system provides it. The frozen pass can split the first future public card across 1 to 64 threads, and the same pool partitions independent freeze / floor slot scans. One thread is the default. Extra worker scratch and the card-result buffer are charged to the budget. Native thread stacks sit outside the budget. The measured speedup is in [BENCHMARKS.md](BENCHMARKS.md). Evaluation stays on the caller.

## Linear CFR on Kuhn

Linear CFR uses the same regret-matching rule as vanilla CFR. On iteration `t` (starting at 1) it multiplies both the new regret and the average-strategy contribution by `t`. Regrets stay signed. Both players update in one traversal. CFR+ floors only the updating player after that player's pass, weights only the average strategy by `t`, and alternates the player who updates.

The 10,000-iteration table below is historical, from before that pass-level floor. The current 200,000-iteration Kuhn rows are in [BENCHMARKS.md](BENCHMARKS.md). Command for this historical table: `kuhn_solver --iterations 10000 --algorithm <name>`.

| Algorithm | Iterations | Runtime (s) | Iterations/s | Player 1 value | Nash gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| vanilla CFR | 10000 | 0.0140505 | 7.117e5 | -0.0555306025757 | 0.00297179826288 |
| linear CFR | 10000 | 0.0166417 | 6.009e5 | -0.0555625698041 | 0.00591309307769 |

`-1/18` is -0.0555555555556. At 10,000 iterations linear CFR is closer to that value. Vanilla CFR has the smaller Nash gap. The unit test also checks that 2,000 iterations of linear CFR are deterministic, that the strategy differs from vanilla CFR, and that some cumulative regret is still negative.

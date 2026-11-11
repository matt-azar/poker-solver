# Unrestricted heads-up no-limit Hold'em

The production solvers find an equilibrium of a finite bet-size tree: a river, turn, or flop small enough to store under the engine budget. Unrestricted HUNL — any legal chip amount at every decision, full unbucketed postflop — exceeds commodity memory. The largest exact tree measured here is a uniform full-range check-down on `Ah Kd 7c`: 5,197,920 stored information sets and about 399 MiB of solver-owned heap inside the default 1024 MiB budget. Expanded histories on that tree are in the billions. Smaller checked abstractions include a `22+` versus `22+` river with two bet sizes (882 information sets) and a one-combo check-only flop (4,052). See [BENCHMARKS.md](../engineering/BENCHMARKS.md).

## Abstraction choices

**Action abstraction.** The street and river trees offer pot fractions, per-street lists, geometric sizes, and an all-in threshold — the public tree-building rules used by PioSOLVER-style postflop trees. An equilibrium of that list is an equilibrium of the offered sizes. The CFR code in this repository is this project's.

**Hand abstraction and bucketing.** Production solvers keep one information set per combo. Bucketing would merge combos the real game can tell apart. That changes the game; the error is exploitability of the resulting strategy in the unbucketed game, which needs the unbucketed multi-street game and exceeds commodity memory.

**Preflop.** A preflop tree multiplies hand pairs by flop/turn/river runouts and every later betting line. Exact unbucketed preflop hits the same memory wall. This repository has no preflop tree. See roadmap M12.

**Monte Carlo CFR.** MCCFR samples outcomes or information sets. Traversals here walk every outcome. This repository has no sampled run.

**Discounted CFR.** Linear CFR weights iteration `t` by `t` on both the regret increment and the average. Fixed DCFR(α=1.5, β=0, γ=2) is an optional production algorithm: alternating OOP/IP frozen passes, signed regrets discounted once per completed pass with `t^1.5/(t^1.5+1)` on positives and `0.5` on non-positives, and average weight `t^2`. CFR+ remains the default. See [STREETS.md](../../STREETS.md).

**Subgame solving.** Libratus-style resolving re-solves a public state with a gadget for the opponent's range. The river/street solvers take a pot and two ranges and solve that subtree; the caller supplies the ranges.

**Exploitability.** The Nash gap diagnostic is NashConv, `(u0(BR0)-u0(σ̄)) + (u1(BR1)-u1(σ̄))`, from an exact best response on the game that was solved. Under zero-sum chips that equals `u0(BR0) + u1(BR1)`. Pio Accuracy / stop criterion is half of that sum.

**Storage and threads.** The street solver charges bytes it requests from its allocator against `memory_mib`. `allocated_bytes` is that live total. `estimated_peak_bytes` is a separate plan. `reserved_bytes` is unused reservation credit. Persistent StreetBatch tables use 32-bit `TableScalar` storage; regret plus strategy-sum is `regret_strategy_sum_bytes`, and the shared frozen/average cache is `sigma_workspace_bytes` (together 12 bytes per hand-action entry). Process RSS is reported separately when the OS provides it. The frozen pass can split the first future public card across 1 to 64 threads; one thread is the default. Extra worker scratch and the card-result buffer are charged to the budget. Native thread stacks sit outside the budget. Measured speedup: [BENCHMARKS.md](../engineering/BENCHMARKS.md). Evaluation stays on the caller.

## Linear CFR (reference measurement)

Linear CFR uses the same regret-matching rule as vanilla CFR. On iteration `t` (starting at 1) it multiplies both the new regret and the average-strategy contribution by `t`. Regrets stay signed. Both players update in one traversal. CFR+ floors only the updating player after that player's pass, weights only the average strategy by `t`, and alternates who updates.

`tests/unit/test_cfr.cpp` checks that Linear CFR on a tiny river `StreetGame` is deterministic, differs from vanilla CFR at the same iteration count, and still records at least one negative cumulative regret.


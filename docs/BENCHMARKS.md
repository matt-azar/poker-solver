## Kuhn vanilla CFR and CFR+

Measured with `build\Release\kuhn_solver.exe` on Windows 10.0.26200, MSVC 19.40.33811.0, Release, x64. Runtime is the regret-update loop. Memory is the regret table, the strategy-sum table, and the information-set offset table: `2 * 24 * 8 + 13 * 4` = 436 bytes. It is not process RSS.

| Algorithm | Iterations | Runtime (s) | Iterations/s | \(u_1\) | Nash gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| vanilla CFR | 10000 | 0.0151241 | 6.611e5 | -0.0555306025757 | 0.00297179826288 |
| vanilla CFR | 50000 | 0.0720609 | 6.939e5 | -0.0555553612639 | 0.00201551812054 |
| vanilla CFR | 100000 | 0.147987 | 6.757e5 | -0.0555535451992 | 0.00126531026002 |
| vanilla CFR | 200000 | 0.389424 | 5.136e5 | -0.0555553050479 | 0.000950614671129 |
| CFR+ | 10000 | 0.0280012 | 3.571e5 | -0.0556839065728 | 0.00304938147655 |
| CFR+ | 50000 | 0.1453823 | 3.439e5 | -0.0556123433833 | 0.00136656280438 |
| CFR+ | 100000 | 0.3687451 | 2.712e5 | -0.055595601859 | 0.000967395475419 |
| CFR+ | 200000 | 0.6254145 | 3.198e5 | -0.0555838196919 | 0.000683744741163 |

\(-1/18\) is -0.0555555555556. Both algorithms are within \(10^{-3}\) of that value by 10,000 iterations. The Nash gap (NashConv, not NashConv/2) drops below \(10^{-3}\) at 200,000 vanilla iterations and at 100,000 CFR+ iterations.

CFR+ walks the tree twice per iteration (one pass for each player), so its iteration rate is lower. At 200,000 iterations its Nash gap is smaller than vanilla CFR’s. On this 12-information-set game the wall-clock advantage is small. These times are not a prediction for Leduc or Hold’em.

## Linear CFR on Kuhn

Same machine and compiler, measured together. `kuhn_solver --iterations 10000 --algorithm <name>`. Linear CFR weights iteration `t` on both the new regret and the average strategy. It does not floor regrets. Both players update in one pass.

| Algorithm | Iterations | Runtime (s) | Iterations/s | \(u_1\) | Nash gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| vanilla CFR | 10000 | 0.0140505 | 7.117e5 | -0.0555306025757 | 0.00297179826288 |
| linear CFR | 10000 | 0.0166417 | 6.009e5 | -0.0555625698041 | 0.00591309307769 |

Linear CFR is closer to \(-1/18\) at this length. Vanilla CFR has the smaller Nash gap. The 10,000-iteration vanilla row above is an older run of the same value and the same gap. See [HUNL.md](HUNL.md).

## Leduc

Same machine and compiler. Command: `build\Release\leduc_solver.exe --algorithm <name> --iterations N`. Default rules: ante 1, round-1 raise 2, round-2 raise 4, two raises per street. 936 decision information sets. Memory estimate 38692 bytes is the regret table, strategy-sum table, and offset table.

| Algorithm | Iterations | Runtime (s) | Iterations/s | Player 0 value | Nash gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| vanilla CFR | 1000 | 0.7050075 | 1.418e3 | -0.0891149365429 | 0.0537834490152 |
| CFR+ | 1000 | 1.3089424 | 7.640e2 | -0.0862957760813 | 0.0921236987006 |

Published solves put the equilibrium value near -0.0856. One thousand iterations is not a full solve. At this length, CFR+ is closer in value and vanilla CFR has the smaller Nash gap. The unit tests check the gap against a 20-iteration run of the same algorithm, where both gaps are still above 0.15 and then fall. See [LEDUC.md](LEDUC.md).

## Five-card evaluator

Same machine and compiler. `poker_solver_tests` evaluates all `C(52, 5) = 2,598,960` five-card hands in two card orders, which is 5,197,920 calls to `evaluate`. Measured time: 0.5565473 seconds, about 9.340e6 evaluations per second. The check is that reordering a hand does not change its value. It is not a solve and it does not include six- or seven-card subset enumeration.

## River

Same machine and compiler. Command: `river_solver --config configs/river_default.json`, and the same tree with `--iterations 2000`. `AA` versus `KK` on `Ah Kd 7c 4s 2h`, pot 100, stack 200, bet sizes 0.5 and 1.0, the same fractions for raises, all-in allowed, and two raises. Nine deals, 42 information sets, 126 decision nodes, 225 terminals. Memory estimate 1996 bytes is the regret table, strategy-sum table, and offset table. Aces always beat kings, so the out-of-position value of a perfect defense is +50.

| Algorithm | Iterations | Runtime (s) | Iterations/s | Player 0 value | Nash gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| CFR+ | 500 | 0.0209566 | 2.386e4 | 50.0013916447 | 0.00145265025502 |
| CFR+ | 2000 | 0.076925 | 2.600e4 | 50.0000871092 | 9.09267588227e-05 |

The unit-test toy (aces or fives versus kings, one all-in) is smaller: 4 information sets, 6 decision nodes, memory estimate 132 bytes. CFR+ for 4,000 iterations took 0.003934 seconds, about 1.017e6 iterations per second, and reached value 24.9999102275 with Nash gap 0.196997733488. The same algorithm at 40 iterations had gap 2.45089917903. These times enumerate every hand pair on every iteration. They will not hold for wide ranges. See [RIVER.md](RIVER.md).

## Public-tree river traversal

Same machine and compiler, measured after `RiverBatchSolver` became the default. `runtime_seconds` is the regret loop. Wall time is the process from start to exit, so it includes tree construction and the final best-response pass. The reference rows use `river_solver --reference`. The public-tree rows use the default traversal. Strategies on the unit-test trees matched the reference with a maximum absolute difference of 0. The values below are from these CLI runs.

`22+` versus `22+`, same board, pot, stack, and sizes as the table above, 30 vanilla CFR iterations. 3,684 deals, 882 information sets, 51,576 decision nodes, 92,100 terminals.

| Traversal | Runtime (s) | Iterations/s | Wall (s) | Memory | Player 0 value | Nash gap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| reference enumerator | 0.2478413 | 1.210e2 | 4.8578796 | 41836 | -3.77420762001 | 3.69437852445 |
| public tree | 0.068139 | 4.403e2 | 0.1083287 | 38304 | -3.77420762001 | 3.69437852445 |

The regret loop is about 3.64 times faster. Wall clock is about 45 times faster because best response is one walk of the 14-node public tree instead of one full-tree walk per information set. Public-tree memory is the regret table plus the strategy-sum table (`2 * entries * 8` bytes) and omits the reference offset table.

The default `AA` versus `KK` tree, CFR+, 500 iterations:

| Traversal | Runtime (s) | Iterations/s | Wall (s) | Memory | Player 0 value | Nash gap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| reference enumerator | 0.0195573 | 2.557e4 | 0.0380295 | 1996 | 50.0013916447 | 0.00145265025502 |
| public tree | 0.0037114 | 1.347e5 | 0.0206115 | 1824 | 50.0013916447 | 0.00145265025505 |

The regret loop is about 5.27 times faster. The Nash gaps differ by `3e-14`, from adding the same best-response values in a different order. The 500-iteration row in the previous table is an earlier reference-enumerator run of this same tree.

## Turn and flop

Same machine and compiler. `street_solver` with no arguments is `AhAd` versus `2c3d` on `Kh Kd 7c 4s`, pot 100, stack 100, one pot-sized bet, CFR+, 400 iterations. 1 deal, 223 information sets, 223 decision nodes, 177 terminals. Memory estimate 5904 bytes.

| Algorithm | Iterations | Runtime (s) | Iterations/s | Player 0 value | Nash gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| CFR+ | 400 | 0.517897 | 7.724e2 | 50.0016209123 | 0.00187032418952 |

The equilibrium value of this tree is +50, because the out-of-position hand wins every river and a fold wins the same half-pot as a check-down. The Nash gap at 20 iterations, from the unit test, was 0.714285714286.

Check-only queens versus jacks on the flop `Ah Kd 7c`, one vanilla iteration:

```sh
street_solver --board Ah,Kd,7c --oop-range QcQd --ip-range JcJd --no-all-in --max-raises 0 --iterations 1 --algorithm vanilla
```

1,980 terminals, 4,052 information sets, runtime 0.0090838 seconds, value 41.6161616162, Nash gap 0. That value is the average of every turn and river. See [STREETS.md](STREETS.md).

## Public-tree turn traversal

Measured together on the turn lock above, Release, this machine. Both solvers report the same value and the same Nash gap. The public tree has 8 betting decisions. Unit tests on check-down, two hands that share a turn infoset, per-street sizes, a geometric size, and a check-only flop all matched `StreetGame` with maximum strategy difference 0.

| Solver | Runtime (s) | Wall (s) | Memory | Player 0 value | Nash gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| `StreetGame` (`--reference`) | 0.7483883 | 0.7867865 | 5904 | 50.0016209123 | 0.00187032418952 |
| Public tree | 0.5261684 | 0.6829143 | 5008 | 50.0016209123 | 0.00187032418952 |

About 1.42× on the regret loop. The public-tree memory figure omits the reference offset table, which is the 896-byte difference. The earlier 0.517897 s row is a different run of the reference solver and is not this comparison.

## Frozen combo pass

`street_solver --frozen` holds the strategy fixed for a pass and updates every combo on that pass. Each action keeps an exploration probability of `0.05 / actions`, so a line the strategy has left is still updated. On this one-combo lock the pass is slower than the per-deal walk; the pass is the one that can take a wider range. The timer below is 20 iterations plus 400 iterations.

The 20-iteration Nash gap is 0.360187888642. The 400-iteration value is 50.0009429068 and the Nash gap is 0.000943154882123. Training both of those runs took 1.5202292 seconds.

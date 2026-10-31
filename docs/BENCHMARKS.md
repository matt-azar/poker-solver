## Kuhn vanilla CFR and CFR+

The table below is historical. It was measured when CFR+ floored each regret during the traversal. The current update freezes the strategy for a pass and floors only the player who just finished that pass.

Historical measurement: `build\Release\kuhn_solver.exe` on Windows 10.0.26200, MSVC 19.40.33811.0, Release, x64. Runtime is the regret-update loop. Memory is the regret table, the strategy-sum table, and the information-set offset table: `2 * 24 * 8 + 13 * 4` = 436 bytes.

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

\(-1/18\) is -0.0555555555556. Both algorithms are within \(10^{-3}\) of that value by 10,000 iterations. The Nash gap (NashConv) drops below \(10^{-3}\) at 200,000 vanilla iterations and at 100,000 CFR+ iterations.

CFR+ walks the tree twice per iteration (one pass for each player), so its iteration rate is lower. At 200,000 iterations its Nash gap is smaller than vanilla CFR’s. On this 12-information-set game the wall-clock advantage is small.

## Kuhn after the pass-level floor

Same machine and compiler, Release, from `poker_solver_tests` in this change (parent `9e0d87d`). Runtime is the regret-update loop inside the unit test. Memory is still 436 bytes. At 200,000 iterations the CFR+ Nash gap is smaller than the vanilla gap. That comparison is this Kuhn measurement only.

| Algorithm | Iterations | Runtime (s) | \(u_1\) | Nash gap |
| --- | ---: | ---: | ---: | ---: |
| vanilla CFR | 200000 | 0.361615 | -0.0555541620942 | 0.000962626251605 |
| CFR+ | 200000 | 0.6515666 | -0.055555555546 | 2.63026537634e-06 |
| linear CFR | 2000 | 0.0034519 | -0.055423756632 | 0.0110188373994 |

\(-1/18\) is -0.0555555555556. Linear CFR does not floor. The 2,000-iteration linear row uses the current schedule. The historical 10,000-iteration row is above.

## Linear CFR on Kuhn

Historical, from before the pass-level floor. Same machine and compiler. `kuhn_solver --iterations 10000 --algorithm <name>`. Linear CFR weights iteration `t` on both the new regret and the average strategy. It does not floor regrets. Both players update in one pass.

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

Published solves put the equilibrium value near -0.0856. One thousand iterations leaves a Nash gap around 0.05 to 0.09. At this length, CFR+ is closer in value and vanilla CFR has the smaller Nash gap. The unit tests check the gap against a 20-iteration run of the same algorithm, where both gaps are still above 0.15 and then fall. See [LEDUC.md](LEDUC.md).

## Five-card evaluator

Same machine and compiler. `poker_solver_tests` evaluates all `C(52, 5) = 2,598,960` five-card hands in two card orders, which is 5,197,920 calls to `evaluate`. Measured time: 0.5565473 seconds, about 9.340e6 evaluations per second. The check confirms that reordering a hand keeps the same value. The timed work is those 5,197,920 five-card calls.

## River

Same machine and compiler. Command: `river_solver --config configs/river_default.json`, and the same tree with `--iterations 2000`. `AA` versus `KK` on `Ah Kd 7c 4s 2h`, pot 100, stack 200, bet sizes 0.5 and 1.0, the same fractions for raises, all-in allowed, and two raises. Nine deals, 42 information sets, 126 decision nodes, 225 terminals. Memory estimate 1996 bytes is the regret table, strategy-sum table, and offset table. Aces always beat kings, so the out-of-position value of a perfect defense is +50.

| Algorithm | Iterations | Runtime (s) | Iterations/s | Player 0 value | Nash gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| CFR+ | 500 | 0.0209566 | 2.386e4 | 50.0013916447 | 0.00145265025502 |
| CFR+ | 2000 | 0.076925 | 2.600e4 | 50.0000871092 | 9.09267588227e-05 |

The unit-test toy (aces or fives versus kings, one all-in) is smaller: 4 information sets, 6 decision nodes, memory estimate 132 bytes. CFR+ for 4,000 iterations took 0.003934 seconds, about 1.017e6 iterations per second, and reached value 24.9999102275 with Nash gap 0.196997733488. The same algorithm at 40 iterations had gap 2.45089917903. These times enumerate every hand pair on every iteration. See [RIVER.md](RIVER.md).

## Public-tree river traversal

Same machine and compiler, measured after `RiverBatchSolver` became the default. `runtime_seconds` is the regret loop. Wall time is the process from start to exit, so it includes tree construction and the final best-response pass. The reference rows use `river_solver --reference`. The public-tree rows use the default traversal. Strategies on the unit-test trees matched the reference with a maximum absolute difference of 0. The values below are from these CLI runs.

`22+` versus `22+`, same board, pot, stack, and sizes as the table above, 30 vanilla CFR iterations. 3,684 deals, 882 information sets, 51,576 decision nodes, 92,100 terminals.

| Traversal | Runtime (s) | Iterations/s | Wall (s) | Memory | Player 0 value | Nash gap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| reference enumerator | 0.2478413 | 1.210e2 | 4.8578796 | 41836 | -3.77420762001 | 3.69437852445 |
| public tree | 0.068139 | 4.403e2 | 0.1083287 | 38304 | -3.77420762001 | 3.69437852445 |

The regret loop is about 3.64 times faster. Wall clock is about 45 times faster because best response is one walk of the 14-node public tree. The reference walk visits the full tree once per information set. Public-tree memory is the regret table plus the strategy-sum table (`2 * entries * 8` bytes) and omits the reference offset table.

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

`street_solver --frozen` holds the strategy fixed for one pass and updates every combo on that pass. Child reach is the frozen action probability. There is no extra exploration mixture. On the one-combo nuts-versus-air lock, the unit test trains 20 CFR+ iterations and then 400. That timer is training only. This change, Release, same machine: training 0.1840145 seconds, value 50.003565929, Nash gap at 400 iterations 0.00467581047378, Nash gap at 20 iterations 1.78571428571.

The earlier frozen numbers that used a 0.05 exploration mixture are historical and are not this update.

## Full-range check-down

`build\Release\street_memory_bench.exe`, Release, MSVC 19.40, Windows 10.0.26200, x64, Intel Core i7-10510U. One frozen CFR+ iteration, uniform random ranges, no all-in, max raises 0, pot 100, stack 100, budget 1024 MiB. Tolerance is `1e-8 * pot` = `1e-6` chips. Both cases are inside it. Values and expanded counts match the run from before the allocation-resource change. Byte totals below are measured requests. Expanded counts are histories. `estimated_peak_bytes` is the labeled plan. `allocated_bytes` and `peak_allocated_bytes` are the resource's live total and high-water mark. `reserved_bytes` is zero. `regret_strategy_sum_bytes` is the regret array plus the strategy-sum array. `process_peak_working_set_bytes` is process RSS. `solve` runtime is training plus the final value and best-response evaluation. Construction is separate. Wall time is the whole bench case.

| | Turn `Ah Kd 7c 4s` | Flop `Ah Kd 7c` |
| --- | ---: | ---: |
| Deals | 1167480 | 1271256 |
| Stored information sets | 106032 | 5197920 |
| Expanded terminals | 51369120 | 2517086880 |
| Expanded decisions | 105073200 | 5151129312 |
| Player 0 value | 1.9567680809e-15 | 1.28230759344e-14 |
| NashConv | 8.64586180427e-15 | 1.43912659567e-14 |
| Construction (s) | 0.2115396 | 0.4245992 |
| Training (s) | 0.3797007 | 17.5002061 |
| Evaluation (s) | 0.0872993 | 4.5951126 |
| Wall (s) | 0.6786679 | 22.5266944 |
| Estimated peak (bytes) | 60874006 | 418186774 |
| Allocated (bytes) | 60883158 | 418426374 |
| Peak allocated (bytes) | 60883158 | 418426374 |
| Reserved (bytes) | 0 | 0 |
| Regret + strategy sum (bytes) | 1696512 | 83166720 |
| Process peak RSS (bytes) | 66592768 | 425652224 |

The flop rank-cache component is 22,569,496 bytes of buffers allocated before the pass. The same command is:

```sh
street_solver --board Ah,Kd,7c --oop-range random --ip-range random --no-all-in --max-raises 0 --iterations 1 --frozen --memory-mib 1024
street_solver --board Ah,Kd,7c,4s --oop-range random --ip-range random --no-all-in --max-raises 0 --iterations 1 --frozen --memory-mib 1024
```

`street_memory_bench` checks those two solves and is not part of the unit suite. There is no wall-time gate in `poker_solver_tests`.

## Betting convergence

`build\Release\street_betting_bench.exe`, Release, MSVC 19.40, Windows 10.0.26200, x64, Intel Core i7-10510U. One solver per case, frozen CFR+, cumulative iterations. Checkpoints are 0, 1, 3, 10, 30, 100, 300, and 1000. A case stops after a checkpoint whose NashConv/pot is at or below 0.001, at 1000 iterations, or at 600 seconds of wall time, and only between complete iterations. NashConv is `player0_br + player1_br`. The gains are `player0_br - player0_ev` and `player1_br + player0_ev`. Checkpoint 0 is the uniform average, before any regret update. After one CFR+ iteration that average is still uniform, because the first strategy is the zero-regret strategy, so checkpoint 1 matches checkpoint 0. Live allocation did not change during training. `reserved_bytes` stayed 0.

Both cases first measured NashConv/pot at or below 0.01 at iteration 100, and at or below 0.001 at iteration 300. Iteration 1000 was not run. The 600-second wall budget was not reached.

Turn, full range, `Ah Kd 7c 4s`, pot 100, stack 100, bets 0.5 for both players, the same fraction copied to raises, all-in on, max raises 1, budget 1024 MiB. 1,167,480 deals, 940,752 information sets, 24 public decisions, 931,649,040 expanded decisions, 1,083,421,440 expanded terminals. Construction 0.2340047 s. Allocated and peak 141,622,270 bytes. Estimated peak 141,612,638 bytes. Regret plus strategy sum 28,479,744 bytes. Process peak RSS 147,513,344 bytes. The value and NashConv at 3 iterations match the earlier review of this tree: 1.48406518248 and 36.6075596709.

| Iterations | Player 0 EV | Player 0 BR | Player 1 BR | Gain 0 | Gain 1 | NashConv | NashConv/pot | Train (s) | Eval (s) | Wall (s) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 15.1234567901 | 54.801367047 | 26.4329993713 | 39.6779102568 | 41.5564561615 | 81.2343664183 | 0.812343664183 | 0 | 1.2562867 | 1.4905239 |
| 1 | 15.1234567901 | 54.801367047 | 26.4329993713 | 39.6779102568 | 41.5564561615 | 81.2343664183 | 0.812343664183 | 0.8719182 | 2.289552 | 3.3958214 |
| 3 | 1.48406518248 | 20.54040094 | 16.0671587309 | 19.0563357575 | 17.5512239134 | 36.6075596709 | 0.366075596709 | 2.4908632 | 3.2642562 | 5.9895792 |
| 10 | -2.72884841994 | 2.489251836 | 6.36469030298 | 5.21810025594 | 3.63584188304 | 8.85394213898 | 0.0885394213898 | 8.0582858 | 4.2650919 | 12.5580548 |
| 30 | -2.42408044671 | -1.51518630947 | 3.11455885903 | 0.908894137243 | 0.69047841232 | 1.59937254956 | 0.0159937254956 | 23.7112235 | 5.2573332 | 29.2034056 |
| 100 | -2.21195627511 | -2.05774191733 | 2.32836865839 | 0.154214357781 | 0.116412383279 | 0.27062674106 | 0.0027062674106 | 77.4923685 | 6.2298115 | 83.9571652 |
| 300 | -2.18915110333 | -2.15750924203 | 2.21350255886 | 0.031641861296 | 0.0243514555302 | 0.0559933168262 | 0.000559933168262 | 236.8521104 | 9.093738 | 246.1810338 |

Flop, `Ah Kd 7c`, both ranges `QQ,JJ,TT,99`, pot 100, stack 100, the same half-pot bet, copied raise, and all-in, max raises 1, budget 1024 MiB. 456 deals, 1,992,192 information sets, 62 public decisions, 33,572,544 expanded terminals, 34,681,536 expanded decisions. Construction 0.1286845 s. Allocated and peak 171,117,298 bytes. Estimated peak 170,876,354 bytes. Regret plus strategy sum 52,091,904 bytes. Process peak RSS 177,401,856 bytes.

| Iterations | Player 0 EV | Player 0 BR | Player 1 BR | Gain 0 | Gain 1 | NashConv | NashConv/pot | Train (s) | Eval (s) | Wall (s) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 16.2637174211 | 58.3007708666 | 30.9470804537 | 42.0370534454 | 47.2107978748 | 89.2478513202 | 0.892478513202 | 0 | 1.7478745 | 1.8767367 |
| 1 | 16.2637174211 | 58.3007708666 | 30.9470804537 | 42.0370534454 | 47.2107978748 | 89.2478513202 | 0.892478513202 | 1.1237933 | 4.0716728 | 5.3244263 |
| 3 | 0.83997658227 | 23.9660411949 | 22.369336823 | 23.1260646126 | 23.2093134053 | 46.3353780179 | 0.463353780179 | 3.6757219 | 5.3968517 | 9.2017029 |
| 10 | -4.12886553878 | 8.32756137738 | 11.4659860718 | 12.4564269162 | 7.33712053298 | 19.7935474491 | 0.197935474491 | 11.52576 | 6.8127681 | 18.4677514 |
| 30 | -2.52812936902 | 0.020706627972 | 4.01679374506 | 2.54883599699 | 1.48866437604 | 4.03750037304 | 0.0403750037304 | 40.4349392 | 8.2552529 | 48.8195152 |
| 100 | -2.03253110071 | -1.67301679218 | 2.2172274205 | 0.359514308526 | 0.184696319789 | 0.544210628316 | 0.00544210628316 | 122.2273693 | 9.6905865 | 132.0474369 |
| 300 | -1.94346200025 | -1.8927024819 | 1.96537221362 | 0.0507595183529 | 0.0219102133695 | 0.0726697317224 | 0.000726697317224 | 352.995994 | 11.540952 | 364.6666577 |

Training is the dominant cost on both cases. At the 300-iteration stop it is 236.9 s of 246.2 s on the turn and 353.0 s of 364.7 s on the flop. Evaluation is under 12 s and construction is under 0.3 s. The turn walk at 3 iterations costs about 0.83 s of training per iteration; the flop walk costs about 1.23 s. Memory stays flat and well under the 1024 MiB budget. Those expanded-history counts are statistics. The frozen walk does not visit each history. It walks the public tree with a vector of hands, and a terminal value is a blocker-corrected sum. The one-thread limit is that public-tree pass. The threaded measurements are below. The same command shape is:

```sh
street_solver --board Ah,Kd,7c,4s --pot 100 --stack 100 --oop-range random --ip-range random --oop-bets 0.5 --ip-bets 0.5 --all-in --max-raises 1 --iterations 300 --frozen --memory-mib 1024
street_solver --board Ah,Kd,7c --pot 100 --stack 100 --oop-range QQ,JJ,TT,99 --ip-range QQ,JJ,TT,99 --oop-bets 0.5 --ip-bets 0.5 --all-in --max-raises 1 --iterations 300 --frozen --memory-mib 1024
```

`street_betting_bench` is not part of the unit suite. These two runs do not establish a comparison with PioSolver.

## Frozen pass threads

`build\Release\street_parallel_bench.exe`, same compiler and machine as the betting table: Release, MSVC 19.40, Windows 10.0.26200, x64, Intel Core i7-10510U (4 cores, 8 threads). The bench is not part of CTest. `converge` skips the timing repetitions. `converge 100` stops at iteration 100. The default run includes the repetitions and the full checkpoint list, with the same 600-second wall stop as `street_betting_bench`.

The thread count includes the caller. One thread keeps the serial chance loop and allocates no extra worker context and no card-result buffer. More threads split the first future public card and, on the same worker pool, the independent `freeze_sigma` / floor / fused floor+freeze slot scans. A turn splits rivers. A flop splits turns, and each worker deals that turn's rivers itself. Descendant regrets of different cards are disjoint, so a worker writes them directly. Each slot writes only its own regret / `frozen_sigma` span. The caller reduces card values in ascending card order after every task has joined. Evaluation stays serial.

Rank fill is `cache_init_seconds`. It is outside construction and outside training. Worker creation is `worker_setup_seconds`. Native thread stacks are outside the engine budget.

### Thirty-iteration block

Three repetitions of 30 frozen CFR+ iterations after one warmup, each repetition reset to zero regrets. The figure is training time. Cache fill is the warmup's `cache_init_seconds` and is not inside the 30-iteration number.

This block is the speed comparison. On the one-thread turn, the median 23.564511 s sits next to the 23.7112235 s cumulative training time at iteration 30 in the table above. That older number includes the one rank fill. The warmup rank fill here was 0.2564049 s. One of the three turn repetitions took 32.4450141 s, which is the whole range. The other two were 23.423217 s and 23.564511 s.

| Case | Threads | Median train (s) | Range (s) | Speedup | Allocated | Worker setup (s) | Cache init (s) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Turn | 1 | 23.564511 | 9.0217971 | 1 | 141624990 | 0.0000002 | 0.2564049 |
| Turn | 2 | 18.6877432 | 1.3539398 | 1.261 | 148860430 | 0.0030317 | 0.19862 |
| Turn | 4 | 14.0271184 | 0.2184014 | 1.680 | 161454222 | 0.008855 | 0.221569 |
| Turn | 8 | 11.9048975 | 0.4642758 | 1.979 | 186641806 | 0.0263557 | 0.2946854 |
| Flop | 1 | 31.8706521 | 0.3188664 | 1 | 171120018 | 0 | 0.2159568 |
| Flop | 2 | 22.6354356 | 0.6372678 | 1.408 | 171285442 | 0.0001535 | 0.2168932 |
| Flop | 4 | 17.3644758 | 1.773533 | 1.836 | 171576258 | 0.000417 | 0.2460198 |
| Flop | 8 | 16.1711532 | 4.6621579 | 1.971 | 172157890 | 0.0011076 | 0.2925108 |

Four threads is 1.68x on the turn and 1.84x on the flop. That is past the 1.5x goal on both betting trees. Eight threads was the fastest of the four counts. The flop's eight-thread range is 4.66 s, from 13.8677496 s to 18.5299075 s, so the step from four to eight threads on that tree is small next to the noise.

One thread allocates 2,720 bytes more than commit `027e652` on both trees (141,624,990 versus 141,622,270 on the turn, 171,120,018 versus 171,117,298 on the flop). Those bytes are the idle thread-pool members. The regret and strategy-sum arrays are unchanged: 28,479,744 and 52,091,904. Two threads add about 7.2 MiB on the full-range turn and 165 KiB on the paired flop. Eight threads add about 45.0 MiB and 1.0 MiB. The flop add is small because the worker scratch follows the hand count.

Process peak RSS in the timing process includes the earlier instrumented solves. A fresh one-thread turn process later reported 147,394,560 bytes, next to 147,513,344 at `027e652`.

The one-thread flop median, 31.87 s, is a warm block of 30. The 40.43 s figure above is cumulative training through iteration 30, including the cold start.

### Where the one-thread time goes

An instrumented three-iteration pass, with the timers on. The training times below include that overhead. The medians above leave it out. `chance_seconds` is zero on one thread because that timer is the caller's wait at a parallel split. With four threads it is caller wall, including the child walks. Showdown and order times with more than one thread are summed across threads and can exceed the training wall.

| Case | Threads | Train (s) | Showdown (s) | Order (s) | Decision (s) | Chance (s) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Turn | 1 | 2.323535 | 1.3317528 | 0.899315 | 0.3857275 | 0 |
| Turn | 4 | 1.1701352 | 1.8339555 | 1.2185765 | 0.8149006 | 1.0917848 |
| Flop | 1 | 3.0705686 | 1.3039796 | 0.805276 | 0.5619667 | 0 |
| Flop | 4 | 1.4128643 | 2.0323213 | 1.206818 | 0.9212747 | 1.2413234 |

On one thread the turn spends 57 percent of the profiled showdown-inclusive training section in showdown, and the nested order section is 39 percent of that training figure. Decisions are 17 percent. The flop's showdown section is 42 percent and decisions are 18 percent. These profile fields are summed elapsed durations. Order time is already inside showdown time, so the columns overlap. The instrumented four-thread training times are 1.99x and 2.17x the instrumented one-thread times.

### Same-build agreement

On both betting trees, two, four, and eight threads matched the one-thread raw regret table and the raw strategy-sum table at iterations 3, 30, and 100. The relative delta was 0. Player-0 EV, both best responses, and NashConv matched the rows in the betting table at iterations 0, 1, 3, 10, 30, and 100. NashConv/pot first reached 0.01 at iteration 100, the same checkpoint as `027e652`. Iteration 300 was not part of that paired run.

An earlier eight-thread flop did reach iteration 300: player-0 EV `-1.94346200025`, NashConv `0.0726697317224`, NashConv/pot `0.000726697317224`, training 231.2164908 s, evaluation 34.6194937 s, wall 267.174506 s, cache init 0.8201007 s. Those scalars match the iteration-300 flop row above. The one-thread reference in that process had stopped at iteration 187, so iteration 300 has no paired raw tables. A printed construction time of 912 s in that process is a suspend. The laptop was later unplugged, and the lid was closed.

The paired run to iteration 100 was after that sustained load. One-thread training to iteration 100 was 202.0960753 s on the turn and 239.4912473 s on the flop, against 77.4923685 s and 122.2273693 s at `027e652`. A clock sample in that window was 1803 MHz on the Samsung power plan. The same binary's warm 30-iteration block, above, still matched the older turn training time, so this gap is the machine. Against that slower one-thread, training to iteration 100 scaled by 1.47x, 2.48x, and 4.32x on the turn at 2, 4, and 8 threads, and by 2.55x, 4.82x, and 6.12x on the flop. Those ratios use the slowed one-thread. The 30-iteration medians are the speedup to cite.

ThreadSanitizer was not run. WSL Ubuntu g++ 11.4.0 is installed. The sanitizer build was not started: the machine is on battery after the lid was closed. The timing stress that did run sleeps a different amount on each card and still matched the one-thread raw tables.

`street_memory_bench` was not repeated in this iteration. The full-range check-down figures above stay the `027e652` measurements. The unit suite's last full run, with the parallel tests included, was 337,239 assertions and 0 failures. Debug traces were removed after that run and the suite was not started again.

### Compact showdown kernel

`ce99f13` replaces each worker's dense 52-wide showdown prefix with a compact prefix over the cards that appear in the runout. `29cf58f` is that kernel plus the `sample` timing mode. The raw regret and strategy-sum tables of `29cf58f` matched the `e2ad8df` pins, and matched that build's own one-thread tables, at iterations 3, 30, 100, and 300. Both betting trees, one thread and four threads. Every relative regret delta and strategy-sum delta was 0. At iteration 300 the turn value is `-2.18915110333` and NashConv is `0.0559933168262`. The flop value is `-1.94346200025` and NashConv is `0.0726697317224`. The pins are the gitignored `PKRPAR1` files under `build/parity-baseline/`.

A separate plugged-in sample, one process per configuration, continued training through iteration 300. Those are single samples. The alternating protocol is below. Turn, one thread: 12.55 s to iteration 30, 38.39 s to 100, 103.11 s to 300, cache init 0.290 s, allocated 143,384,278. Turn, four threads: 6.58 s, 22.29 s, 67.73 s, cache init 0.230 s, allocated 161,818,798. Flop, one thread: 21.80 s, 73.15 s, 221.14 s, cache init 0.225 s, allocated 176,209,546. Flop, four threads: 11.23 s, 38.38 s, 114.84 s, cache init 0.207 s, allocated 176,635,618. The older `027e652` one-thread times to iteration 300 were 236.9 s on the turn and 353.0 s on the flop, on a different session. They come from a different session.

The four-thread medians from the cool `e2ad8df` block stay the threading result: turn 23.564511 s versus 14.0271184 s (1.680x), flop 31.8706521 s versus 17.3644758 s (1.836x). That block compared thread counts inside one kernel. The kernel comparison is the next section.

### Reset-30 warm-cache comparison

Both binaries ran `street_parallel_bench sample`. The sample warms the rank cache with one `run_frozen_iterations(1)`, then calls `run_frozen_iterations(30)`. The second call resets regrets, strategy sums, and the iteration count. It does not clear the rank cache. The timed `train` field is those 30 iterations. The printed protocol is `reset-30-warm-cache`. `evaluation` is 0 because the sample does not call best response. The laptop was plugged in on the Samsung plan. MSVC 19.40 Release. Three alternating pairs at one thread, then three at four threads. No pair was repeated.

Train seconds, one thread, turn: baseline 22.2793234, 23.1801817, 22.7569621 (median 22.7569621, range 0.9008583); compact 10.4686055, 11.0140881, 12.4674001 (median 11.0140881, range 1.9987946). Median ratio 2.066.

Train seconds, one thread, flop: baseline 29.5676292, 30.6268292, 30.1863002 (median 30.1863002, range 1.0592000); compact 22.7656245, 23.1476113, 22.3264889 (median 22.7656245, range 0.8211224). Median ratio 1.326.

Train seconds, four threads, turn: baseline 16.4120198, 12.6797935, 13.6891522 (median 13.6891522, range 3.7322263); compact 6.7948993, 8.0956419, 10.8009056 (median 8.0956419, range 4.0060063). Median ratio 1.691. The range is wide. The three baseline samples still sit above the three compact samples.

Train seconds, four threads, flop: baseline 18.6798585, 22.4444654, 22.4279414 (median 22.4279414, range 3.7646069); compact 13.0653449, 12.4450668, 15.5560509 (median 13.0653449, range 3.1109841). Median ratio 1.717. The range is wide. The samples do not overlap.

Allocated bytes equalled peak on every sample. Turn, one thread: baseline 141,624,990, compact 143,384,278. Flop, one thread: 171,120,018 and 176,209,546. Turn, four threads: 161,454,222 and 161,818,798. Flop, four threads: 171,576,258 and 176,635,618.

The full-range check-down cache fill is a different cost. On the plugged-in Windows run of `29cf58f`, `street_memory_bench` reported cache init 0.297 s on the turn and 12.039 s on the flop at one thread, and 0.317 s and 12.426 s at four threads. The training block after that fill was 0.034 s and 2.004 s at one thread. A warm 30-iteration betting-tree gain is not that cold fill. Engine heap on that run, allocated equal to peak: turn 62,645,166 and 81,079,686 bytes; flop 531,424,158 and 550,641,654 bytes. The independent Linux review of the same commit reported 62,647,533 and 81,082,053 on the turn, and 531,364,379 and 550,581,875 on the flop. Values were unchanged: turn `1.9567680809e-15`, NashConv `8.64586180427e-15`; flop `1.28230759344e-14`, NashConv `1.43912659567e-14`.

## Frozen freeze / floor slot scans (M6)

Commit `a04eb8c` on `cursor/flop-freeze-parallel-e394` partitions the slot vector across the existing frozen worker pool for `freeze_sigma`, `floor_player`, and a fused CFR+ `floor_and_freeze` pass (one fewer full slot scan per iteration). `StreetWalkProfile::freeze_seconds` times those caller-side scans. Linux cloud agent, g++ 13.3.0 Release, 4 logical CPUs. Not a multi-hour flop-to-0.001 chase.

### Paired flop betting tree (`QQ,JJ,TT,99`, warm 30 CFR+ iters, no walk profile)

Alternating rebuild of `origin/main` versus the freeze branch, two pairs:

| Threads | Before median train (s) | After median train (s) | Speedup |
| ---: | ---: | ---: | ---: |
| 1 | 12.22 | 11.66 | 1.05x |
| 2 | 6.73 | 6.28 | 1.07x |
| 4 | 4.14 | 3.42 | 1.21x |

One-thread gain is mostly the fused floor+freeze scan. Four-thread gain adds parallel slot work on top of the existing chance split.

### Study flop `flop_srp_one_size` (~42.8 M infosets, ~4.27 GiB)

Warm one frozen iteration, then time two more (no walk profile) at four threads: before `4.595` s/iter, after `3.833` s/iter (**1.20x**, about 16% less train time per iteration). After branch with walk profile on for two timed iterations: `freeze_seconds` 1.044 s/iter at one thread and 0.235 s/iter at four threads (**4.45x** on the freeze/floor scans alone); train 14.60 s/iter at one thread and 3.82 s/iter at four threads. Allocated bytes stay ~4.27 GiB. Parallel unit tables still match; `poker_solver_tests` reported 440,795 assertions and 0 failures on this branch.

## Frozen decision expand cache (M6)

After `a04eb8c`, a short instrumented `street_parallel_bench` profile on the paired flop (3 warm CFR+ iters, 1 thread) showed action expand — repeated `hand_supported` / `slot_index` across actions, plus EV copies — as the largest remaining bucket (`expand_seconds` ≈ 0.58 s of ≈ 1.84 s train), ahead of showdown and the timed decision mix. Freeze was already small.

`cursor/engine-speed-e394` caches structural support masks per `(turn, river)` on each worker and stores acting-player infoset bases on the per-depth scratch frame, so each decision node pays those costs once per visit instead of once per action. `StreetWalkProfile` also reports `fold_seconds`, `collect_seconds`, `expand_seconds`, and `support_seconds`. Linux cloud agent, g++ 13.3.0 Release, 4 logical CPUs. Short microbench only.

### Reset-30 warm-cache vs freeze tip (`6648754`)

`street_parallel_bench sample`, alternating before/after rebuilds, no walk profile:

| Case | Threads | Before median train (s) | After median train (s) | Speedup |
| --- | ---: | ---: | ---: | ---: |
| flop_paired | 4 | 3.452 | 2.374 | **1.45x** |
| turn_half_pot | 4 | 1.468 | 1.197 | 1.23x |
| flop_paired | 1 | ~15.5–16.7 (n=2) | ~10.2–10.5 (n=2) | ~1.55x |

Instrumented 3-iter flop profile at 1 thread: `expand_seconds` 0.579 → 0.125; train 1.838 → 1.335. Allocated bytes rise slightly from the support/slot scratch (flop 4 threads 176,624,560 → 176,644,816). Parity pins at iteration 30: 1-vs-4 thread regret and strategy-sum relative delta 0 on both trees. `poker_solver_tests` 440,795 assertions, 0 failures.

## Precomputed board-support masks (M6)

After the expand cache (`#46` / `5762d5c`), a short instrumented profile on the paired flop (3 warm CFR+ iters) showed showdown still large, with `support_seconds` and serial chance still recomputing `hand_supported` on every board visit and again inside `card_reaches_pair`. Structural support depends only on ranges and the public board, so it can be filled once per walkable `(turn, river)` (including turn-only partial boards).

`cursor/engine-speed-2-e394` reserves those boards at construction, fills the masks on first train (charged to `cache_init_seconds`), and makes `ensure_board_support` a copy from the cache. `card_reaches_pair` reads the same masks. Linux cloud agent, g++ 13.3.0 Release, 4 logical CPUs. Short microbench only.

### Reset-30 warm-cache vs main tip (`4ea6224` / `#46`)

`street_parallel_bench sample`, alternating before/after binaries, no walk profile:

| Case | Threads | Before median train (s) | After median train (s) | Speedup |
| --- | ---: | ---: | ---: | ---: |
| flop_paired | 4 | 2.301 | 2.116 | **1.09x** |
| turn_half_pot | 4 | 1.176 | 1.093 | 1.08x |

Instrumented 3-iter profile: flop `support_seconds` 0.050 → 0.018 at 1 thread; turn 0.010 → 0.0006. Allocated bytes rise with the mask table (flop 4 threads 176,644,816 → 177,166,000). Parity pins at iteration 30: 1-vs-4 and after-vs-main relative regret / strategy-sum delta 0 on both trees. `poker_solver_tests` 441,547 assertions, 0 failures.

## Fused showdown + supported-hand indexes (M6)

After board-support masks (`#51` / `eaeffaf`), a short instrumented profile on the paired flop (3 warm CFR+ iters) still spent most of train in `showdown_seconds` (≈0.46 s of ≈1.12 s at 1 thread). Terminals retested `hand_live` over every indexed hand and paid repeated `slice_reach` / `combo_index` work.

`cursor/engine-speed-3-e394` stores supported-hand index lists beside the `#51` masks, walks those lists in collect / fold / showdown, fuses worse/better/tie mass extraction after one `order_reach`, and caches same-combo twin indexes. Rank-order opponent weights are materialized once per prefix build. Linux cloud agent, g++ 13.3.0 Release, 4 logical CPUs. Short microbench only.

### Reset-30 warm-cache vs latest `origin/main` (includes `#51`)

`street_parallel_bench sample`, alternating before/after binaries, no walk profile. Re-measured after rebase onto `main` with `#50,#51,#47,#49,#31`:

| Case | Threads | Before median train (s) | After median train (s) | Speedup |
| --- | ---: | ---: | ---: | ---: |
| flop_paired | 4 | 2.289 | 1.678 | **1.36x** |
| turn_half_pot | 4 | 1.162 | 0.839 | **1.39x** |

Instrumented 3-iter profile at 1 thread: flop `showdown_seconds` 0.437 → 0.230, train 1.141 → 0.916; turn showdown 0.185 → 0.074, train 0.405 → 0.263. Allocated bytes rise with twin indexes, ordered-amount scratch, and per-board index lists (flop 4 threads 177,166,040 → 177,667,784). Parity pins at iteration 30: 1-vs-4 and after-vs-`main` relative regret / strategy-sum delta 0 on both trees. `poker_solver_tests` 441,644 assertions, 0 failures.

## Decision/expand idx* walk probe (not shipped)

`cursor/engine-speed-4-e394` tried walking `BoardSupport::{idx0,idx1}` through frozen `fill_actor_slot_bases`, action expand, and decision regret / average mix (same pattern as the `#52` terminal paths). Linux cloud agent, g++ 13.3.0 Release, 4 logical CPUs. Short microbench only; code change reverted.

### Reset-30 warm-cache vs engine-speed-3 tip (`b3f3923` / `#52` pre-rebase tip)

`street_parallel_bench sample`, five alternating before/after pairs at four threads, quiet host, no walk profile:

| Case | Threads | Before median train (s) | After median train (s) | Speedup |
| --- | ---: | ---: | ---: | ---: |
| flop_paired | 4 | 1.589 | 1.600 | **0.99x** |
| turn_half_pot | 4 | 0.795 | 0.805 | **0.99x** |

An earlier noisier three-pair set was ~1.02x flop / ~1.06x turn. Instrumented 3-iter profile at 1 thread did shrink `decision_seconds` (flop ≈0.174 → 0.109) and `expand_seconds` (≈0.111 → 0.087), but wall train for reset-30 at four threads did not clear ~1.05x. On the paired flop only ~11% of hole combos are board-blocked, so the dense `live[]` scan was already cheap relative to showdown/chance, and zero-fills for unsupported reaches offset the sparse walk. Parity pins at iteration 30: 1-vs-4 and after-vs-`#52` relative regret / strategy-sum delta 0 on both trees. `poker_solver_tests` 441,666 assertions, 0 failures. Not shipped.

## Sparse serial-chance reach / EV reduce probe (not shipped)

`cursor/engine-speed-5-e394` tried walking `BoardSupport::{idx0,idx1}` through frozen serial-chance child `pi` filters and EV reduces, the parallel-chance EV reduce over active cards, worker chunk `pi` filters, and `card_reaches_pair`, plus a one-thread outermost `chance_seconds` wall timer. Linux cloud agent, g++ 13.3.0 Release, 4 logical CPUs. Short microbench only; code change reverted.

### Reset-30 warm-cache vs engine-speed-3 tip (`5b04b41` / `#52`)

`street_parallel_bench sample`, five alternating before/after pairs at four threads, quiet host, no walk profile:

| Case | Threads | Before median train (s) | After median train (s) | Speedup |
| --- | ---: | ---: | ---: | ---: |
| flop_paired | 4 | 1.574 | 1.622 | **0.97x** |
| turn_half_pot | 4 | 0.791 | 0.792 | **1.00x** |

Instrumented 3-iter profile at 1 thread now reports non-zero `chance_seconds` for the outermost serial chance wall (flop ≈0.790 of ≈0.860 train; turn ≈0.214 of ≈0.256), confirming that bucket was previously unaccounted. Sparse idx* filters did not clear ~1.05x wall train at four threads: on the paired flop only ~11% of hole combos are board-blocked, so fill-zero then sparse assign for child reaches offsets the shorter EV reduce, and multi-thread chance wall remains dominated by nested child walks rather than the dense hand loops. Parity pins at iteration 30: 1-vs-4 and after-vs-`#52` relative regret / strategy-sum delta 0 on both trees. `poker_solver_tests` 441,717 assertions, 0 failures. Not shipped.

## Lean order_reach + showdown collect + non-actor aev accumulate (M6)

After fused showdown (`#52`), a fresh 1-thread instrumented profile still spent ~25% of train in `showdown_seconds` with `order_seconds` ≈40% of that, collect ≈10%, and decision/expand still material. Dense→idx* probes on decision and chance (engine-speed-4/5) had already failed the wall bar, so this change uses different levers: skip full zero-fills in `order_reach` (write `prefix[0]` and each card base only), skip by-card aggregates on the showdown collect path, and accumulate the non-acting player's action EVs into `here.ev` during the frozen action loop instead of copying them through `aev*`. Linux cloud agent, g++ 13.3.0 Release, 4 logical CPUs. Short microbench only.

### Reset-30 warm-cache vs engine-speed-3 tip (`77aab28` / `#52`)

`street_parallel_bench sample`, five alternating before/after pairs at four threads, quiet host, no walk profile:

| Case | Threads | Before median train (s) | After median train (s) | Speedup |
| --- | ---: | ---: | ---: | ---: |
| flop_paired | 4 | 1.621 | 1.485 | **1.09x** |
| turn_half_pot | 4 | 0.815 | 0.724 | **1.13x** |

Instrumented 3-iter profile at 1 thread (flop): `order_seconds` 0.091 → 0.075, `showdown_seconds` 0.234 → 0.211, `decision_seconds` 0.141 → 0.106, `collect_seconds` 0.094 → 0.082, train 0.930 → 0.861. Allocated bytes unchanged at four threads (177,667,832). Parity pins at iteration 30: 1-vs-4 and after-vs-`#52` relative regret / strategy-sum delta 0 on both trees. `poker_solver_tests` 441,746 assertions, 0 failures.

## Fused actor σ-mix + skip non-updating aev probe (not shipped)

`cursor/engine-speed-7-e394` after `#56` / latest `main`. Fresh 1-thread instrumented profile (3 warm CFR+ iters) still showed material `decision_seconds` / `expand_seconds` beside showdown. This probe folded the actor's σ-weighted mix into the frozen action loop (so the post-loop pass only writes regrets/averages) and skipped actor `aev*` copies on nodes whose player is not the CFR+ updating player for that pass. Not an idx* walk and not `#56`'s zero-fill / non-actor aev skips. Linux cloud agent, g++ 13.3.0 Release, 4 logical CPUs. Short microbench only; code change reverted.

### Reset-30 warm-cache vs `#56` / `main` tip (`2c6c132`)

`street_parallel_bench sample`, five alternating before/after pairs at four threads, quiet host, no walk profile:

| Case | Threads | Before median train (s) | After median train (s) | Speedup |
| --- | ---: | ---: | ---: | ---: |
| flop_paired | 4 | 1.468 | 1.453 | **1.01x** |
| turn_half_pot | 4 | 0.727 | 0.722 | **1.01x** |

Instrumented 3-iter profile at 1 thread (flop): `decision_seconds` 0.148 → 0.115, `expand_seconds` 0.115 → 0.119, train 0.957 → 0.903. The decision bucket shrank, but the mix work moved into expand and four-thread wall train did not clear ~1.05x. Parity pins at iteration 30: 1-vs-4 and after-vs-`main` relative regret / strategy-sum delta 0 on both trees (after fixing an early live-mask read that raced child chance overwrites — mix accumulate must use `slot_base`, not `ctx.live*`, inside the action loop). Not shipped.

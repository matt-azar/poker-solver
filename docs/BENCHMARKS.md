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

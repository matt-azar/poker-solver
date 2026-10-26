# Benchmarks

Measured on this machine, not estimated.

- OS: Windows 10.0.26200
- Compiler: MSVC 19.40.33811.0 (Visual Studio 2022), Release, x64
- Command: `build\Release\kuhn_solver.exe --iterations N`
- Memory estimate is the regret and strategy-sum tables only: `2 * 12 * 2 * sizeof(double)` = 384 bytes. It is not process RSS.

| Iterations | Runtime (s) | Iterations/s | \(u_1\) | \(-1/18\) | Nash gap |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100000 | 0.0995464 | 1.0046e6 | -0.0555535451992 | -0.0555555555556 | 0.00126531026002 |
| 200000 | 0.2094228 | 9.5501e5 | -0.0555553050479 | -0.0555555555556 | 0.000950614671129 |
| 500000 | 0.5170853 | 9.6696e5 | -0.0555550914754 | -0.0555555555556 | 0.000534216842253 |

Player-1 value is already within \(10^{-5}\) of \(-1/18\) by 100,000 iterations. The Nash gap (NashConv, not NashConv/2) is below \(10^{-3}\) at 200,000 iterations and still decreasing at 500,000.

At 500,000 iterations the average strategy matched the equilibrium family with \(\alpha \approx 0.220\) (P1 King bet \(\approx 3\alpha\), P1 Queen call \(\approx \alpha + 1/3\)). See [MATHEMATICS.md](MATHEMATICS.md).

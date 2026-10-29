# Study benchmark report

NashConv is `player0_best_response_utility + player1_best_response_utility`, the sum of the two unilateral deviation gains. The target is NashConv/pot at most 0.001. The fraction below is `nash_gap / pot`. `wall_seconds` is cold process time. `train_seconds` is the solver's training clock, not the process wall time.

Raw logs stay in `benchmarks/study/out/` and are gitignored. This file is the committed record.

## Machine

Intel Core i7-10510U, 8 logical processors, 12,655,898,624 bytes of RAM. Windows 11 (10.0.26200). Visual Studio 17 2022, Release. The runner could not read a compiler banner from the CMake cache.

## Baseline at `95242db`

Executable source `95242db81c021efe4ec6d2792aee936ddb72db77` on `cursor/study-benchmark-corpus`, before the later `main` commits. Labeled quiet. About 3.4 GiB of RAM was free before the run. The flop working set reached about 4.3 GB while about 3.4 GB was free, so that timeout is not a clean speed number.

| Case | Outcome | Iterations | Player 0 EV | NashConv | NashConv/pot | Wall | Train |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `river_competing_weights` | success | 340 of 2000 | −21.1585636502 | 0.0956068392 | 0.000956 | 2.72 s | unavailable |
| `turn_srp_river_betting` | target not reached | 400 of 400 | −8.09892287189 | 0.260636275 | 0.002606 | 65.52 s | 61.83 s |
| `flop_srp_one_size` | timeout | none | unavailable | unavailable | unavailable | 2400 s, killed | unavailable |

The river CLI does not print construction, cache, train, evaluation, or process working set. The flop stdout was empty because that binary reported only at the end. Smoke runs on that binary distinguished success, invalid input, timeout, and resource rejection.

## Main at `381c9a5`

Executable source `381c9a5ad36247c8d71dd94e005e4ddcd4201591`. Same turn tree as the baseline. Labeled quiet because no other cmake, MSBuild, compiler, or solver process was running. Only 1,764,913,152 bytes of RAM were free when the runner collected the host info. The 400-iteration training clock was 229 s in the reference process and 150 s at iteration 400 inside the extended process, against 62 s on `95242db`. The NashConv at 400 iterations matched the baseline (`0.260636`). These wall times are not a stable speed comparison.

| Case | Outcome | Iterations | Player 0 EV | NashConv | NashConv/pot | Wall | Train | Eval |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `turn_srp_river_betting` | target not reached | 400 of 400 | −8.09892 | 0.260636 | 0.00260636 | 243.979 s | 229.226 s | 14.471 s |
| `turn_srp_river_betting_to_target` | success | 720 of 8000 | −8.08496 | 0.0995806 | 0.000995806 | 272.367 s | 259.160 s | 13.059 s |

The extended case is the same spot with an 8000-iteration cap. It stopped at the accuracy check on iteration 720. Construction was 0.044 s and cache init was 0.063 s on that process. Training is the cost. Both processes used about 48,550,294 allocated bytes and a 54,665,216-byte process working set. `memory_bytes_estimate` is null on the street CLI.

Selected checkpoints from the extended process (`nash_gap / 100`):

| Iterations | NashConv/pot | Train seconds |
| --- | --- | --- |
| 20 | 0.211221 | 7.459 |
| 100 | 0.023861 | 36.959 |
| 200 | 0.007736 | 77.222 |
| 400 | 0.002606 | 149.567 |
| 600 | 0.001345 | 217.706 |
| 720 | 0.000996 | 259.160 |

## Interruption

A 2-second kill of `turn_srp_river_betting` on this binary flushed `phase: training` and kept construction 0.072 s, cache init 0.085 s, 43,316 deals, and 442,776 information sets. Iterations and NashConv stayed unavailable because the first accuracy check had not finished. That kill was contended and is not a speed result. The flop was not run again.

## Next measurement

The turn target is 720 iterations on this tree, and training is almost the entire clock. The same 400 iterations took 62 s, 150 s, and 229 s across these runs, so the measurements do not identify an engine bottleneck. Repeat the unchanged 400-iteration turn when more than 4 GB is free before spending another flop wall. Leave `flop_srp_one_size` unchanged. A killed flop on this binary can now keep the last flushed phase.

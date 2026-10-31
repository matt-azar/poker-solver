# Study benchmark report

NashConv is `player0_best_response_utility + player1_best_response_utility`, the sum of the two unilateral deviation gains. The target is NashConv/pot at most 0.001. The fraction below is `nash_gap / pot`. `wall_seconds` is cold process time. `train_seconds` is the solver's training clock, not the process wall time.

Raw logs stay in `benchmarks/study/out/` and are gitignored. This file is the committed record.

## Machine (Linux cloud agent, 2026-10-30 America/New_York)

x86_64, 4 logical processors, 16,780,574,720 bytes of RAM (~5 GiB available before the quiet reference run). Linux 6.12.94+, glibc 2.39. g++ 13.3.0, CMake Unix Makefiles, Release. Source commit `abe999f` on `main` (solver binaries unchanged by the GUI time-limit follow-up). Timing label: quiet for reference cases; contended for smoke.

Smoke taxonomy on this host: `success`, `invalid-input`, `timeout`, `resource-rejection`. The timeout diagnostic needed a 4096 MiB engine budget; 2048 MiB now rejects the full-range flop during frozen allocation (~2.12 GiB estimated).

## Main at `abe999f` (Linux)

| Case | Outcome | Iterations | Player 0 EV | NashConv | NashConv/pot | Wall | Train | Eval |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `river_competing_weights` | success | 340 of 2000 | −21.1586 | 0.095607 | 0.000956 | 1.11 s | unavailable | unavailable |
| `turn_srp_river_betting` | target not reached | 400 of 400 | −8.09892 | 0.260636 | 0.002606 | 35.09 s | 33.04 s | 1.99 s |
| `turn_srp_river_betting_to_target` | success | 720 of 8000 | −8.08496 | 0.099581 | 0.000996 | 62.65 s | 59.03 s | 3.56 s |
| `flop_srp_one_size` | timeout (600 s wall) | 20 of 400 | −11.1099 | 35.2859 | 0.352859 | 600.2 s killed | 297.7 s | 15.85 s |

Turn quality at 400 and 720 iterations matches the earlier Windows record (`0.260636` / `0.000996`). Training is still almost the entire clock. On this quieter Linux host the 400-iteration turn is ~35 s wall versus 62–244 s across the older Windows sessions, so those earlier spreads were machine noise, not an engine regression.

Turn allocated ~48.5 MiB (peak equal to allocated); construction and cache init stay under 0.03 s. The river CLI still does not print construction / train / eval / process working set.

The flop admitted under a 4096 MiB engine budget (~4.27 GiB allocated, ~42.8 M infosets, 8104 deals). At the first accuracy checkpoint (iteration 20) NashConv/pot was still 0.35. Roughly 15 s of training per iteration on one thread. Completing 400 iterations on this host would need on the order of 100 minutes of training alone; the case wall stays 2400 s. Leave `flop_srp_one_size` unchanged. A killed flop now keeps the last flushed checkpoint.

## Baseline at `95242db`

Executable source `95242db81c021efe4ec6d2792aee936ddb72db77` on `cursor/study-benchmark-corpus`, before the later `main` commits. Labeled quiet. About 3.4 GiB of RAM was free before the run. The flop working set reached about 4.3 GB while about 3.4 GB was free, so that timeout is not a clean speed number.

| Case | Outcome | Iterations | Player 0 EV | NashConv | NashConv/pot | Wall | Train |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `river_competing_weights` | success | 340 of 2000 | −21.1585636502 | 0.0956068392 | 0.000956 | 2.72 s | unavailable |
| `turn_srp_river_betting` | target not reached | 400 of 400 | −8.09892287189 | 0.260636275 | 0.002606 | 65.52 s | 61.83 s |
| `flop_srp_one_size` | timeout | none | unavailable | unavailable | unavailable | 2400 s, killed | unavailable |

The river CLI does not print construction, cache, train, evaluation, or process working set. The flop stdout was empty because that binary reported only at the end. Smoke runs on that binary distinguished success, invalid input, timeout, and resource rejection.

## Main at `381c9a5`

Executable source `381c9a5ad36247c8d71dd94e005e4ddcd4201591`. Same turn tree as the baseline. Labeled quiet because no other cmake, MSBuild, compiler, or solver process was running. Only 1,764,913,152 bytes of RAM were free when the runner collected the host info. The 400-iteration training clock was 229 s in the reference process and 150 s at iteration 400 inside the extended process, against 62 s on `95242db`. The NashConv at 400 iterations matched the baseline (`0.260636`). These wall times are not a stable speed comparison.

| Case | Outcome | Iterations | Player 0 EV | NashConv | NashConv/pot | Wall | Train | Eval |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `turn_srp_river_betting` | target not reached | 400 of 400 | −8.09892 | 0.260636 | 0.00260636 | 243.979 s | 229.226 s | 14.471 s |
| `turn_srp_river_betting_to_target` | success | 720 of 8000 | −8.08496 | 0.0995806 | 0.000995806 | 272.367 s | 259.160 s | 13.059 s |

The extended case is the same spot with an 8000-iteration cap. It stopped at the accuracy check on iteration 720. Construction was 0.044 s and cache init was 0.063 s on that process. Training is the cost. Both processes used about 48,550,294 allocated bytes and a 54,665,216-byte process working set. `memory_bytes_estimate` is null on the street CLI.

Selected checkpoints from the extended process (`nash_gap / 100`):

| Iterations | NashConv/pot | Train seconds |
| ---: | ---: | ---: |
| 20 | 0.211221 | 7.459 |
| 100 | 0.023861 | 36.959 |
| 200 | 0.007736 | 77.222 |
| 400 | 0.002606 | 149.567 |
| 600 | 0.001345 | 217.706 |
| 720 | 0.000996 | 259.160 |

## Interruption

A 2-second kill of `turn_srp_river_betting` on the `381c9a5` binary flushed `phase: training` and kept construction 0.072 s, cache init 0.085 s, 43,316 deals, and 442,776 information sets. Iterations and NashConv stayed unavailable because the first accuracy check had not finished. That kill was contended and is not a speed result.

## Freeze / floor parallelization microbench (`a04eb8c`)

Short Linux Release timings only (not a completed study to 0.001). Warm one frozen CFR+ iteration, then two timed iterations of `flop_srp_one_size` at four threads: `origin/main` 4.595 s/iter versus freeze-parallel branch 3.833 s/iter (~1.20x). With walk profile enabled on the branch, `freeze_seconds` alone was 1.044 s/iter at one thread and 0.235 s/iter at four threads (~4.45x). See [docs/BENCHMARKS.md](../../docs/BENCHMARKS.md) for the paired-flop alternating table. Do not treat these as a substitute for finishing the flop study wall.

## Next measurement

On a quiet machine with more than ~6 GiB free, finish `flop_srp_one_size` to the 400-iteration cap or the 0.001 target under the case's 2400 s wall. Multi-thread the same flop once a one-thread completed report exists. Turn target remains 720 iterations / ~60 s training on this Linux host; river stays under two seconds to target.

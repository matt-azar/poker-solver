# Postflop study benchmarks

Reference workloads for a realistic river, turn, and flop study. The ranges are study inputs. They are not solved preflop equilibria.

The historical identical `QQ,JJ,TT,99` flop is not the representative flop. That spot is only described in `docs/BENCHMARKS.md`.

## What is measured

NashConv is `player0_best_response_utility + player1_best_response_utility`: the sum of the two unilateral deviation gains. Player 0 is out of position.

The quality target is NashConv/pot at most **0.001**.

`river_solver` prints `nash_gap` and `pot` and does not print the pot fraction. `tools/run_study_benchmarks.py` divides those two numbers. That quotient is the runner's derivation. `street_solver` also prints `nash_gap_fraction_of_pot`; the runner still records its own division and uses that division for the target.

Clocks stay distinct:

| Field | Meaning |
| --- | --- |
| `wall_seconds` | Cold process time, measured outside the solver by the runner |
| `runtime_seconds` | Solver solve-loop timer. Not process wall time |
| `total_seconds` | Street only. Sum of construction, cache init, worker setup, training, and evaluation. Not process wall time |
| `train_seconds` | Street training only |
| `construction_seconds`, `cache_init_seconds`, `evaluation_seconds` | Street phases. Cache init is the rank fill |

Memory stays distinct:

| Field | Meaning |
| --- | --- |
| `allocated_bytes`, `peak_allocated_bytes` | Bytes the street engine requested from its allocator |
| `estimated_peak_bytes` | A labeled plan, not a measurement |
| `memory_bytes_estimate` | River only. Regret table plus strategy-sum table |
| `process_peak_working_set_bytes` | Street only. Process working set |
| `--memory-mib` | Street engine allocation budget. Not an operating-system cap and not process RSS. Default is 1024 MiB |

A missing field stays null. The runner does not invent it.

## Outcome taxonomy

Each execution is exactly one of:

| Outcome | When |
| --- | --- |
| `success` | Exit 0 and the runner-derived NashConv/pot is at most 0.001 |
| `target-not-reached` | Exit 0, but the target was not measured or is above 0.001, including a stop at the iteration cap |
| `invalid-input` | Non-zero exit from a bad flag or a rejected configuration |
| `resource-rejection` | Non-zero exit that reports an allocation or memory-budget failure |
| `timeout` | The runner killed the process at the wall-clock limit. Not a completed solve |
| `process-failure` | Any other non-zero exit, or a failure to start the process |

`dry-run` is recorded when `--dry-run` is set. It is not an execution.

## Cases

Reference cases live in `benchmarks/study/cases/`. The executable content is the `argv` array. Metadata next to it describes the same spot. The runner executes `argv` and does not rebuild a second configuration model. Street cases load the tree from a `street-config 1` file under `benchmarks/study/configs/` via `street_solver --config`. Relative `--config` paths are resolved against the repository root. Solve controls (`--iterations`, `--algorithm`, `--accuracy`, `--frozen`) and optional `--memory-mib` / `--threads` overrides stay on the command line.

### `river_competing_weights`

Board `Th 9h 6d 4h 2c`, pot 100, effective stack 200. Three hearts, so flushes compete with the 87 straight, sets, and overpairs. OOP is a wider, weighted calling range. IP is more polarized: overpairs and nut flushes are heavier, and offsuit bluff-catchers are lighter. Bets are 0.5 and 1 pot. Raises are explicit and different (`0.75` OOP, `1` IP), so they are not copies of the bet list. All-in is on. `max-raises` is 2. OOP acts first. CFR+, iteration cap 2000. `--gap-threshold 0.1` is `0.001 * pot` in chips. `--eval-interval 20` matches the street cadence. There is no frozen pass and no thread flag on this binary.

Useful because a river study is wide in deals rather than in future cards, and this tree is large enough to show betting and raising without being a one-combo lock.

### `turn_srp_river_betting`

Board `Qc 9d 4h 2c` (two clubs), pot 100, effective stack 400. OOP continues with a wide pair-and-suited range. IP is tighter, and `ATo`, `KJo`, and `QJo` are weighted below 1. One bet size, half pot, is shared by the turn and the river. The raise size is an explicit 0.75 pot, not a copy of the bet. All-in is on. `max-raises` is 2, so a raise is legal and a re-raise is not (the opening bet counts toward the cap). CFR+, frozen pass, 1 thread, engine budget 2048 MiB, iteration cap 400. `--accuracy 0.001` sets the Nash gap threshold to `0.001 * pot` and hardcodes the evaluation cadence to 20. There is no flag for that cadence.

A called half-pot turn bet leaves 350 behind and a pot of 200, so the river still has a half-pot bet, a raise, and an all-in. That is the future-river betting this case is for.

Useful because the frozen turn pass separates construction, rank-cache fill, training, and evaluation on a range-versus-range tree.

### `turn_srp_river_betting_to_target`

The same tree, ranges, sizes, frozen pass, thread count, and engine budget as `turn_srp_river_betting`. The iteration cap is 8000 and the wall is 3600 seconds. `--accuracy 0.001` still stops early when NashConv/pot is at most 0.001. This case measures cold time to that target. It is role `scale`, so `--cases reference` does not run it, and it does not replace the 400-iteration reference.

### `flop_srp_one_size`

Board `Js 8h 3h`, pot 100, effective stack 500. OOP is `JJ+` plus suited broadways and connectors, with `AJo` at weight 0.5. IP is `TT+`, `AJs+`, `KQs`, a partial `QJs`, and weighted `KJo` / `ATs`. The ranges are not the same, and they are not `QQ,JJ,TT,99`. One half-pot bet is used on the flop, the turn, and the river. The raise is an explicit 0.75 pot. All-in is on. `max-raises` is 2. CFR+, frozen pass, 1 thread, engine budget 4096 MiB, iteration cap 400, accuracy 0.001, evaluation cadence 20.

Useful because flop information sets are stored on later-card runouts. One size plus one raise is the first practical betting abstraction, and the two-tone jack flop makes flush completion part of the later streets.

Per-street bet flags are intentionally absent on the turn and the flop. If a per-street bet list is set, that street's raises copy the bet list and the shared `--oop-raises` / `--ip-raises` flags do not apply there. The CLI has no per-street raise flag.

## Diagnostics

These do not replace the three reference cases.

| Id | Expected outcome |
| --- | --- |
| `smoke_success` | `success`. AA versus KK, small river, target reachable |
| `smoke_invalid` | `invalid-input`. Unknown flag |
| `smoke_timeout` | `timeout`. Full-range flop, engine budget 2048 MiB, killed at 2 seconds before a final report. A 1024 MiB budget rejects this tree and is not the timeout diagnostic |
| `smoke_resource` | `resource-rejection`. Full-range flop with a 1 MiB engine budget |

## How to run

Build only the two solver binaries in this worktree. From the worktree root:

```text
cmake -S . -B build
cmake --build build --config Release --target river_solver --target street_solver
```

On a single-config generator, omit `--config Release` and pass the directory that contains the binaries.

Smoke the taxonomy:

```text
python tools/run_study_benchmarks.py --bin-dir build/Release --cases smoke_success,smoke_invalid,smoke_timeout,smoke_resource --output-dir benchmarks/study/out/smoke --timing-label contended
```

Reference cases, sequentially, with the iteration caps and walls stored in the fixtures:

```text
python tools/run_study_benchmarks.py --bin-dir build/Release --cases reference --output-dir benchmarks/study/out/reference --timing-label quiet
```

`--timing-label quiet` is honest only when nothing else is compiling or solving. Otherwise pass `contended` or `pending`. Contended wall times are not a performance result. NashConv from a finished deterministic run can still be read as a quality result.

Other runner flags:

- `--iterations N` replaces `--iterations` in every selected command
- `--threads N` replaces `--threads` on `street_solver` only. A value above 1 still requires `--frozen`, which the reference street cases already pass. The river binary never receives `--threads`
- `--wall-seconds X` replaces each case's wall limit
- `--dry-run` writes the argument arrays and does not start a process
- `--cases` accepts `reference` (the default), `smoke`, `all`, or comma-separated ids

Raw stdout, stderr, `results.json`, and `summary.md` are written to the output directory. `benchmarks/study/out/` is gitignored by `benchmarks/study/.gitignore`. Do not commit those logs. The committed record of hardware, source revision, outcomes, and timings is `benchmarks/study/RESULTS.md`.

## Flushed phases

`street_solver` writes `phase:` records to stdout and flushes each one. The records are `start`, `construction`, `cache_init`, `training`, `checkpoint`, and `final`. A checkpoint is one accuracy evaluation. The runner keeps the last value of each key, so a killed process still yields the last flushed phase. `phase: final` is a completed report. Any other phase means the process was interrupted. A checkpoint's iteration count is the last finished accuracy check, not an iteration still in progress. Construction does not print cache, train, or evaluation clocks. Those clocks are zero until their phase has run, and printing them early would look like a measurement.

`street_solver --reference` prints `start` and `final` only. The reference walk has no construction or cache split.

## CLI gaps

Follow-ups for the solver CLIs:

- `street_solver --accuracy` hardcodes `eval_interval` to 20. The cadence cannot be changed.
- `river_solver --gap-threshold` is an absolute Nash gap in chips. The river CLI does not print `nash_gap_fraction_of_pot`.
- The river CLI does not print construction, cache, train, or evaluation splits, engine allocation, process peak working set, or a thread count. It has no `--frozen`, `--threads`, `--memory-mib`, or `--accuracy`.
- Street `total_seconds` is not process wall time. `runtime_seconds` is not process wall time on either CLI.
- Per-street raise lists exist on `StreetConfig` but have no command-line flags. A non-empty per-street bet list is reused as that street's raise list, which hides `--oop-raises` and `--ip-raises` for that street.
- `street_solver` has no `--first` flag. Both street cases are OOP-first because that is the config default.
- River cases still use flag argv. They do not load a `river-config` document.
- Empty raise lists are copied from the bet lists when flags omit them. The street-config fixtures list raises explicitly.

## Quiet-machine note

Run the reference cases when the machine is not compiling, solving, or running another heavy analysis. Simultaneous work contaminates wall time. Label that run `contended` and do not use it as a speed claim. If the full iteration caps cannot be finished, leave the cases unchanged, keep any smaller run under a different output directory or a different case id, and mark the reference timing pending.

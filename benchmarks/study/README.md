# Postflop study benchmarks

Reference workloads for river, turn, and flop study. Ranges are study inputs. The representative flop is `flop_srp_one_size`. See `docs/auxiliary/engineering/BENCHMARKS.md`.

## What is measured

NashConv is the sum of unilateral BR gains
`(u0(BR0)-u0)+(u1(BR1)-u1)`. Under zero-sum chips that equals
`player0_best_response_utility + player1_best_response_utility`. Player 0 is out of position.

The quality target is Pio Accuracy/pot at most **0.001** (Accuracy = NashConv/2).
The runner schema `study-benchmark-results-2` records both
`accuracy_over_pot` (stop criterion) and `nashconv_over_pot` (true NashConv/pot)
and sets `stop_criterion` to `accuracy_over_pot`. Case fixtures use
`quality_target_accuracy_over_pot`.

Pio Accuracy in chips is `accuracy`, which is NashConv/2. `accuracy_fraction_of_pot` is that value divided by the chip pot. Older logs may only have `nash_gap`. Half of `nash_gap` is Accuracy in chips. Divide that by the pot for the pot fraction.

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
| `success` | Exit 0 and the runner-derived Accuracy/pot is at most 0.001 |
| `target-not-reached` | Exit 0, but the target was not measured or is above 0.001, including a stop at the iteration cap |
| `invalid-input` | Non-zero exit from a bad flag or a rejected configuration |
| `resource-rejection` | Non-zero exit that reports an allocation or memory-budget failure |
| `timeout` | The runner killed the process at the wall-clock limit. Not a completed solve |
| `process-failure` | Any other non-zero exit, or a failure to start the process |

`dry-run` is recorded when `--dry-run` is set. It is not an execution.

## Cases

Reference cases live in `benchmarks/study/cases/`. Street cases point at a `street-config 1` file under `benchmarks/study/configs/`. Solve controls for a live run go through host `solve` or `gate-bench`. See [How to run](#how-to-run). The notes below describe the spots behind the committed `RESULTS.md` rows.

### `river_competing_weights`

Board `Th 9h 6d 4h 2c`, pot 100, effective stack 200. Three hearts, so flushes compete with the 87 straight, sets, and overpairs. OOP is a wider, weighted calling range. IP is more polarized: overpairs and nut flushes are heavier, and offsuit bluff-catchers are lighter. Bets are 0.5 and 1 pot. Raises are explicit and different (`0.75` OOP, `1` IP), so they are not copies of the bet list. All-in is on. `max-raises` is 2. OOP acts first. CFR+, iteration cap 2000. The Accuracy target is 0.1 chips, which is `0.001 * pot` when the pot is 100. The eval cadence is 20.

Useful because a river study is wide in deals rather than in future cards, and this tree is large enough to show betting and raising without being a one-combo lock.

### `turn_srp_river_betting`

Board `Qc 9d 4h 2c` (two clubs), pot 100, effective stack 400. OOP continues with a wide pair-and-suited range. IP is tighter, and `ATo`, `KJo`, and `QJo` are weighted below 1. One bet size, half pot, is shared by the turn and the river. The raise size is an explicit 0.75 pot, not a copy of the bet. All-in is on. `max-raises` is 2. The opening bet does not count. Two facing raises are allowed. CFR+, frozen pass, 1 thread, engine budget 2048 MiB, iteration cap 400. Accuracy 0.001 stops when Pio Accuracy (NashConv/2) divided by the pot is at most 0.001. The check cadence is 20.

A called half-pot turn bet leaves 350 behind and a pot of 200, so the river still has a half-pot bet, a raise, and an all-in. That is the future-river betting this case is for.

Useful because the frozen turn pass separates construction, rank-cache fill, training, and evaluation on a range-versus-range tree.

### `turn_srp_river_betting_to_target`

The same tree, ranges, sizes, frozen pass, thread count, and engine budget as `turn_srp_river_betting`. The iteration cap is 8000 and the wall is 3600 seconds. `--accuracy 0.001` still stops early when Accuracy/pot is at most 0.001. This case measures cold time to that target. It is role `scale`, so `--cases reference` does not run it, and it does not replace the 400-iteration reference.

### `flop_srp_one_size`

Board `Js 8h 3h`, pot 100, effective stack 500. OOP is `JJ+` plus suited broadways and connectors, with `AJo` at weight 0.5. IP is `TT+`, `AJs+`, `KQs`, a partial `QJs`, and weighted `KJo` / `ATs`. The ranges are not the same, and they are not `QQ,JJ,TT,99`. One half-pot bet is used on the flop, the turn, and the river. The raise is an explicit 0.75 pot. All-in is on. `max-raises` is 2. The opening bet does not count. Two facing raises are allowed. CFR+, frozen pass, 1 thread, engine budget 4096 MiB, iteration cap 400, accuracy 0.001, evaluation cadence 20.

Useful because flop information sets are stored on later-card runouts. One size plus one raise is the first practical betting abstraction, and the two-tone jack flop makes flush completion part of the later streets.

The flop and turn reference configs set shared bet and raise lists. They do not set per-street bet or raise lists. An empty per-street raise list uses the shared raise list. It does not copy that street's bet list. Per-street raise keys are `oop-flop-raises`, `oop-turn-raises`, `oop-river-raises`, and the IP twins.

## Diagnostics

These do not replace the three reference cases.

| Id | Expected outcome |
| --- | --- |
| `smoke_success` | `success`. AA versus KK, small river, target reachable |
| `smoke_invalid` | `invalid-input`. Unknown flag |
| `smoke_timeout` | `timeout`. Full-range flop, engine budget 4096 MiB, killed at 2 seconds before a final report. A 2048 MiB budget rejects this tree (~2.12 GiB estimated) and is not the timeout diagnostic |
| `smoke_resource` | `resource-rejection`. Full-range flop with a 1 MiB engine budget |

## How to run

Zig Study contract smoke:

```sh
zig build -Doptimize=ReleaseFast -Dcpu=x86_64_v2
python3 scripts/zig/study-contract-smoke.py ./zig-out/bin/solver-engine
```

Optional bounded digs: `scripts/zig/run-gate-bounded.sh` and `node-ev-latency.py`. See [ZIG_RELEASE_GATES.md](../../docs/auxiliary/engineering/ZIG_RELEASE_GATES.md). Accuracy and time-to-Accuracy walls are not merge gates.

Fixture configs under `configs/` (including `river_gate_smoke.txt`) are inputs for those smokes. `.github/workflows/zig.yml` runs `scripts/zig/study-contract-smoke.py`. That smoke is a lifecycle check. The committed record of earlier hardware, outcomes, and timings is `benchmarks/study/RESULTS.md`.

`first-to-act` is a `street-config 1` field. The street fixtures list raises explicitly. The Zig engine does not copy omitted raise sizes from the bet list. Street cases are OOP-first because that is the config default. `total_seconds` on a street row is a sum of phases. `runtime_seconds` is the solve-loop timer. Neither is process wall time.

A quiet timing label means nothing else was compiling or solving. A contended label is not a speed claim.

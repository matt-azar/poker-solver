# Architecture

The C++ postflop solver uses one public betting tree. Flop, turn, and river differ only by how many cards remain (two, one, or zero). `StreetBatchSolver` is that engine; `StreetGame` + `CfrTrainer` is the reference enumerator (`--reference`). `RiverGame` is the five-card oracle.

A second engine, Zig `solver-engine`, is in this tree. It trains CFR+. It is the sidecar the packaged Study shell starts first. It is not the CLI, and this file does not record a quality cutover.

Primary docs index: [README.md](README.md). See [STREETS.md](STREETS.md), [RIVER.md](RIVER.md), [EXPLORER.md](EXPLORER.md), [HOLDEM.md](HOLDEM.md), [ZIG_RELEASE_GATES.md](auxiliary/engineering/ZIG_RELEASE_GATES.md).

## Runtimes

| Runtime | Role | Save format |
| --- | --- | --- |
| C++ `StreetBatchSolver` | `street_solver`, `river_solver`, HTTP `explorer` / `holdem-explorer` | PSOL v1–v3. Kind 2 files open on `RiverBatchSolver`. |
| Zig `solver-engine` | Packaged Study sidecar. Typed IPC protocol 2: little-endian `u32` length, then a JSON envelope. | PSOL v4. Older files and kind 2 are rejected. |

Browser development runs `explorer` on `127.0.0.1:8765`. Vite proxies `/api` there.

The packaged Tauri shell starts `solver-engine` first. If spawn or the ready handshake fails, it starts `holdem-explorer` on a free loopback port and waits for `GET /api/ready` protocol 1 and the launch id. `VITE_SOLVER_TRANSPORT=http` forces that HTTP path. A process already listening on port 8765 is not the owned HTTP sidecar.

On the IPC path the Study client sends status, solve (`begin_config`, then `solve`), and root action values (`node_index` 0) over IPC. Pause, stop, continue, node browse, equity, locks, and save still use the HTTP client. A successful IPC start does not launch `holdem-explorer`, so those HTTP calls go to `http://127.0.0.1:8765`.

Zig tools `street-config-check` and `gate-bench` are not `street_solver`. Build them with `zig build` (toolchain 0.14.1).

## One postflop tree

| Board | Production path | Reference enumerator |
| --- | --- | --- |
| 3, 4, or 5 cards | `StreetBatchSolver` | `StreetGame` + `CfrTrainer` (`--reference`) |

`explorer` and `river_solver` both route five-card boards through that shared tree. `river_solver` maps river JSON/CLI flags into `StreetConfig` and solves with `StreetBatchSolver` (or `StreetGame` under `--reference`). `RiverBatchSolver` remains for internal oracle and legacy fixtures only. Nothing under `include/` includes `legacy/ui/` or `desktop/`.

## Modules

### Build libraries

| Target | Role | Depends on |
| --- | --- | --- |
| `poker_primitives` | Cards, hand eval, categories, ranges | — |
| `poker_solver` | Production postflop engine (`StreetBatchSolver`) + regret matching | primitives |
| `poker_solver_legacy_river` | `RiverBatchSolver` for PSOL kind=2 / oracle fixtures | solver |
| `poker_study` | Checkpoint + value worker session services | solver + legacy river |
| `poker_equity` | Check-down equity | primitives only |
| `poker_solver_core` | INTERFACE alias → `poker_study` (legacy name) | study |

Shared solve declarations (`Algorithm`, `SolveConfig`, `SolveStats`) live in `include/solver/solve_types.hpp` so batch headers need not pull the full `CfrTrainer` template. `StreetConfig` / sizing rules live in `include/game/street_config.hpp`; `RiverConfig` in `include/game/river_config.hpp`. Reference enumerators (`StreetGame`, `RiverGame`) and `CfrTrainer` remain header-only under `include/game/` and `include/solver/trainer.hpp`. Hold’em `--reference` on `street_solver` / `river_solver` is always available. Production `poker_solver` never links the legacy river target.

Canonical range catalogue assets live under `configs/range-profiles/`; the Study client imports them directly (no `desktop/` copies).

### Production postflop layout

`StreetBatchSolver` is a public facade (`include/solver/street_batch.hpp`, `src/solver/street_batch.cpp`). The private engine is split under `src/solver/postflop/`:

| Path | Responsibility |
| --- | --- |
| `engine.hpp` | Private `Engine` declaration (nested types, members, method decls) |
| `tree.cpp` | Public betting tree, deals, slot planning |
| `tables.cpp` | Compact indexing, table allocation, training-state I/O |
| `showdown.cpp` | Rank caches, blockers, terminal values |
| `traversal.cpp` | Shared fixed-strategy walk (`frozen_walk`, sequential deal CFR) |
| `algorithms/*.hpp` | Per-algorithm schedules (CFR+, vanilla, DCFR, PCFR+) |
| `schedules.cpp` | Dispatch into those schedules |
| `evaluation.cpp` | Profile utility, best response, NashConv helpers |
| `inspection.cpp` | Node inspect, action values, reaches, runouts |
| `execution.cpp` | Workers, slot passes (freeze / floor / discount), synchronization |

Read `src/solver/postflop/algorithms/cfr_plus.hpp` for one complete CFR+ iteration without opening DCFR or PCFR+. DCFR math stays in `include/solver/dcfr.hpp`. Predictive notes: `include/solver/pcfr.hpp`.

### Runtime modules

| Module | Role |
| --- | --- |
| `poker::holdem` | Card ids, seven-card hand values, range weights, joint hand distribution |
| `poker::streets::StreetConfig` | Shared postflop config + sizing/legality rules (production) |
| `poker::streets::StreetGame` | Reference flop/turn/river enumerator |
| `poker::solver::StreetBatchSolver` | Same streets on one public betting tree; production default |
| `street_solver` | CLI over `StreetBatchSolver`; `--reference` for `StreetGame`; `--config` for `street-config 1` |
| `poker::river::RiverConfig` | Shared river config (legacy batch + conversion) |
| `poker::river::RiverGame` | Five-card oracle enumerator |
| `poker::solver::RiverBatchSolver` | Legacy/oracle river engine (`poker_solver_legacy_river`) |
| `river_solver` | Thin five-card CLI: maps river config to `StreetConfig`, solves on the street path |
| `poker::solver::TreeEditSet` | Force/remove/add-size intents on matching public paths |
| `poker::solver::CfrTrainer<Game>` | Vanilla CFR, CFR+, linear CFR, DCFR, PCFR+ for any extensive-game type |
| `regret_matching` | Current strategy from cumulative regret; reach-weighted accumulation |
| `compute_best_response` | Exact best response, deepest information set first |
| `explorer` | C++ local Study HTTP server; serves `desktop/dist` or `legacy/ui/`; fresh solves use `StreetBatchSolver`. Browser dev and the packaged HTTP fallback. |
| `solver-engine` | Zig IPC sidecar (protocol 2). CFR+ only. Preferred packaged Study process. |

## Extensive-game interface

A game type provides a small `State` and:

- `root`, `is_chance`, `is_terminal`, `p1_utility`
- `chance_count`, `chance_probability`, `child_chance`
- `infoset`, `acting_player`, `action_count`, `child_action`

Player 0/1 utilities are net chips (zero-sum when rake is zero). `acting_player` is 0 or 1. Actions are local indexes. The concept `ExtensiveGame` checks this at compile time.

On the street/river path, player 0 is out of position. Chance deals ordered hand pairs from the joint range distribution, then later board cards when any remain.

## Solver storage

`StreetBatchSolver` stores regret, strategy-sum, and one shared sigma workspace as `TableScalar` (`float`) tables, with a compact offset table from information set to first action. Slot lookup is keyed by public node, legal runout (off-board card or ordered pair), and supported hand — not a dense `52×52×hands` map. One-action decisions omit stored rows (implicit probability 1). The sigma workspace holds the frozen strategy during a training pass and the normalized average during evaluation; those two views are mutually exclusive, so they share one full-size buffer. Counterfactual values, NashConv, and other sensitive reductions stay double. `CfrTrainer` (Hold’em reference enumerators) and legacy `RiverBatchSolver` keep `double` tables. The action-count scratch limit is 8 per information set. See `include/solver/table_scalar.hpp` and [STREETS.md](STREETS.md).

Node locks (`poker::solver::NodeLock` / `LockSet` in `node_lock.hpp`) are an immutable constraint layer keyed by `(infoset / public-node index, turn, river)`. A line lock uses `turn=river=-1` and applies on every runout of that betting line; a node lock keeps the selected cards and applies only there. Lookup prefers the exact runout, then falls back to the line lock. A `FullNode` lock applies one validated action-probability row to every combo; `SelectedCombos` applies that row only to listed combo indices. An empty probability row means unlocked and is distinct from locking an action at probability zero. When `SolveConfig::locks` is set, `CfrTrainer`, `StreetBatchSolver`, and `RiverBatchSolver` call `apply_lock_to_strategy` after regret matching. Explorer locking is street-first.

CFR+ floors the updating player's cumulative regrets once after that player's pass. The opponent's table is unchanged. The average strategy is weighted by the iteration index. Linear CFR weights both the new regret and the average by the iteration index and leaves regrets signed. Fixed DCFR(1.5, 0, 2) discounts signed regrets after each frozen pass. See [MATHEMATICS.md](MATHEMATICS.md).

## Best response and Nash gap

`compute_best_response` walks every information set of the responding player from the deepest public decision back to the root. At each set it keeps the action with the larger opponent-and-chance-weighted continuation. Ties keep the lower action index.

The Nash gap is NashConv, the sum of unilateral BR gains
\((u_0(\mathrm{BR}_0)-u_0(\bar\sigma))+(u_1(\mathrm{BR}_1)-u_1(\bar\sigma))\).
Under zero-sum chips this equals \(u_0(\mathrm{BR}_0)+u_1(\mathrm{BR}_1)\).
`StreetBatchSolver::evaluate()`, `RiverBatchSolver::evaluate()`, and
`evaluate_strategy` share `EvaluationResult`. Pio **Accuracy** is
\(\mathrm{NashConv}/2\). Accuracy stopping uses that Accuracy metric
(pot fraction by default; optional absolute chips).

## Stopping

`SolveConfig` sets a maximum iteration count and an optional Accuracy threshold
(`accuracy_threshold`, absolute chips of Pio Accuracy). The threshold applies
only when it is non-negative and `eval_every` is positive (`eval_interval` is a legacy alias for the same field). Runtime reported
by `solve` is the regret-update loop, including Accuracy checks that end the
run early.

## Design limits

- Production trees use a fixed list of bet sizes (plus geometric / all-in / pot-cap rules on the street path).
- Best response is exact on the game that was solved.
- At most 8 actions per information set until the scratch arrays are widened.
- Tiny synthetic games and Hold’em `StreetGame` fixtures verify the shared trainer; they are not Study product surfaces.

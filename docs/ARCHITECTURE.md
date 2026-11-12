# Architecture

**Shipping on `zig-rewrite`:** the production Study engine is Zig (`engine/`, `app/`, `host/`, `cli/` → `solver-engine` typed IPC). The C++ `holdem-explorer` / CMake library tree described in older revisions of this doc is **removed**. Algorithmic concepts below (one postflop tree, NashConv, CFR+ schedules) still apply; treat C++ path / `include/` / `src/` names as historical vocabulary unless a Zig module is named explicitly.

Primary docs index: [README.md](README.md). See [STREETS.md](STREETS.md), [RIVER.md](RIVER.md), [DESKTOP_UI.md](DESKTOP_UI.md), [HOLDEM.md](HOLDEM.md). Retired HTTP explorer notes: [EXPLORER.md](EXPLORER.md).

## One postflop tree

| Board | Production idea | Reference / oracle idea |
| --- | --- | --- |
| 3, 4, or 5 cards | Shared public betting tree (Zig port of StreetBatch) | Exact enumerator / five-card oracle pins |

Canonical range catalogue assets live under `configs/range-profiles/`; the Study client imports them directly (no `desktop/` copies).

## Modules (historical C++ map)

The following CMake targets and `include/` / `src/` layout are **gone** from the tree. Kept here so older rematch notes and store digs remain readable:

### Build libraries (retired)

| Target | Role | Depends on |
| --- | --- | --- |
| `poker_primitives` | Cards, hand eval, categories, ranges | — |
| `poker_solver` | Production postflop engine (`StreetBatchSolver`) + regret matching | primitives |
| `poker_solver_legacy_river` | `RiverBatchSolver` for PSOL kind=2 / oracle fixtures | solver |
| `poker_study` | Checkpoint + value worker session services | solver + legacy river |
| `poker_equity` | Check-down equity | primitives only |
| `poker_solver_core` | INTERFACE alias → `poker_study` (legacy name) | study |

### Production postflop layout (retired C++ sources)

`StreetBatchSolver` was a public facade (`include/solver/street_batch.hpp`, `src/solver/street_batch.cpp`). The private engine was split under `src/solver/postflop/`:

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
| `explorer` | *(retired)* Local Study HTTP server; Zig Study uses `solver-engine` IPC instead |

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

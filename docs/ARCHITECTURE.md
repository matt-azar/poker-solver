# Architecture

Production postflop solving uses one public betting tree. Flop, turn, and river differ only by how many cards remain (two, one, or zero). `StreetBatchSolver` is the production engine; `StreetGame` + `CfrTrainer` is the reference enumerator (`--reference`). `RiverGame` is the five-card oracle. Kuhn and Leduc stay on `CfrTrainer` only and are not part of the Study product path.

See [STREETS.md](STREETS.md), [RIVER.md](RIVER.md), [EXPLORER.md](EXPLORER.md), [HOLDEM.md](HOLDEM.md).

## One postflop tree

| Board | Production path | Reference enumerator |
| --- | --- | --- |
| 3, 4, or 5 cards | `StreetBatchSolver` | `StreetGame` + `CfrTrainer` (`--reference`) |

`explorer` and `river_solver` both route five-card boards through that shared tree. `river_solver` maps river JSON/CLI flags into `StreetConfig` and solves with `StreetBatchSolver` (or `StreetGame` under `--reference`). `RiverBatchSolver` remains for internal oracle and legacy fixtures only. Nothing under `include/` includes `ui/`.

## Modules

| Module | Role |
| --- | --- |
| `poker::holdem` | Card ids, seven-card hand values, range weights, joint hand distribution |
| `poker::streets::StreetGame` | Reference flop/turn/river tree: one betting structure per runout, sizes per street |
| `poker::solver::StreetBatchSolver` | Same streets on one public betting tree; production default |
| `street_solver` | CLI over `StreetBatchSolver`; `--reference` for `StreetGame`; `--config` for `street-config 1` |
| `poker::river::RiverGame` | Five-card oracle enumerator |
| `poker::solver::RiverBatchSolver` | Public-tree river helper for oracle/legacy fixtures |
| `river_solver` | Thin five-card CLI: maps river config to `StreetConfig`, solves on the street path |
| `poker::solver::TreeEditSet` | Force/remove/add-size intents on matching public paths |
| `poker::solver::CfrTrainer<Game>` | Vanilla CFR, CFR+, linear CFR, DCFR for any extensive-game type |
| `regret_matching` | Current strategy from cumulative regret; reach-weighted accumulation |
| `compute_best_response` | Exact best response, deepest information set first |
| `explorer` | Local Study HTTP server; serves `desktop/dist` or `ui/`; all boards use `StreetBatchSolver` |
| `poker::kuhn`, `poker::leduc` | Small reference games for shared CFR tests |

## Extensive-game interface

A game type provides a small `State` and:

- `root`, `is_chance`, `is_terminal`, `p1_utility`
- `chance_count`, `chance_probability`, `child_chance`
- `infoset`, `acting_player`, `action_count`, `child_action`

Player 0/1 utilities are net chips (zero-sum when rake is zero). `acting_player` is 0 or 1. Actions are local indexes. The concept `ExtensiveGame` checks this at compile time.

On the street/river path, player 0 is out of position. Chance deals ordered hand pairs from the joint range distribution, then later board cards when any remain.

## Solver storage

Regrets and strategy sums are two `std::vector<double>` blocks with an offset table from information set to first action. The action-count scratch limit is 8 per information set.

Node locks (`poker::solver::NodeLock` / `LockSet` in `node_lock.hpp`) are an immutable constraint layer keyed by infoset or public-node id. A `FullNode` lock applies one validated action-probability row to every combo; `SelectedCombos` applies that row only to listed combo indices. An empty probability row means unlocked and is distinct from locking an action at probability zero. When `SolveConfig::locks` is set, `CfrTrainer`, `StreetBatchSolver`, and `RiverBatchSolver` call `apply_lock_to_strategy` after regret matching. StreetBatch and RiverBatch key locks by public-node index. Explorer locking is street-first.

CFR+ floors the updating player's cumulative regrets once after that player's pass. The opponent's table is unchanged. The average strategy is weighted by the iteration index. Linear CFR weights both the new regret and the average by the iteration index and leaves regrets signed. Fixed DCFR(1.5, 0, 2) discounts signed regrets after each frozen pass. See [MATHEMATICS.md](MATHEMATICS.md).

## Best response and Nash gap

`compute_best_response` walks every information set of the responding player from the deepest public decision back to the root. At each set it keeps the action with the larger opponent-and-chance-weighted continuation. Ties keep the lower action index.

The Nash gap is NashConv:

\[
u_0(\mathrm{BR}_0,\bar\sigma_1)+u_1(\bar\sigma_0,\mathrm{BR}_1).
\]

Accuracy stopping uses NashConv / pot. This is not Pio's averaged unilateral exploitability.

## Stopping

`SolveConfig` sets a maximum iteration count and an optional Nash-gap threshold. The threshold applies only when it is non-negative and `eval_interval` is positive. Runtime reported by `solve` is the regret-update loop, including gap checks that end the run early.

## Design limits

- Production trees use a fixed list of bet sizes (plus geometric / all-in / pot-cap rules on the street path).
- Best response is exact on the game that was solved.
- At most 8 actions per information set until the scratch arrays are widened.
- Kuhn and Leduc verify the shared trainer; they are not Study product surfaces.

## Reference games (Kuhn / Leduc)

Kuhn and Leduc implement the same extensive-game interface and train only through `CfrTrainer`. Rules: [LEDUC.md](LEDUC.md). Equilibrium math for Kuhn: [MATHEMATICS.md](MATHEMATICS.md).

Kuhn public sequences (`Sequence`): `Empty`, `Check`, `Bet`, `CheckBet`, and terminals `CheckCheck`, `BetFold`, `BetCall`, `CheckBetFold`, `CheckBetCall`. Twelve infosets: three private cards × four decision points. Chance deals six equally likely ordered card pairs.

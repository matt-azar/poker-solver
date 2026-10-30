# Architecture

Phase 4 adds six-card Leduc Hold'em on that same trainer. See [LEDUC.md](LEDUC.md).

Phase 5 adds a 52-card deck, a seven-card evaluator, and 1,326-hand ranges under `poker::holdem`. See [HOLDEM.md](HOLDEM.md).

Phase 6 adds `poker::river::RiverGame`, a heads-up no-limit river on that trainer. Chance deals private hands from the two ranges. The same regret update trains it. See [RIVER.md](RIVER.md).

Phase 7 adds `poker::solver::RiverBatchSolver`. It keeps one copy of the public betting tree and runs the same regret update, in the same deal order. A pass freezes regret matching. CFR+ floors one player after that player's deals. Best response is one bottom-up pass: each river information set is one player, one private hand, and one public history, so that pass matches deepest-first best response on `RiverGame`. `CfrTrainer<RiverGame>` remains the reference and is selected with `--reference`. Kuhn and Leduc still use only `CfrTrainer`.

Phase 8 adds `poker::streets::StreetGame` for a flop, a turn, or a river. Later cards are chance nodes when any remain. The same regret update trains it. See [STREETS.md](STREETS.md).

Phase 9 adds the `explorer` program and the static files in `ui/`. A five-card board still uses `RiverBatchSolver` there. A flop or a turn uses `StreetBatchSolver`, so the later streets are dealt and bet in the same tree. `StreetBatchSolver` also solves a five-card board when called directly. Nothing under `include/` includes `ui/`. See [EXPLORER.md](EXPLORER.md).

`Algorithm::LinearCfr` is a third weighting on `CfrTrainer`: iteration `t` scales both the new regret and the average strategy, and regrets stay signed. The public river tree uses vanilla CFR and CFR+. See [HUNL.md](HUNL.md).

## One postflop tree

A flop, a turn, and a river are one betting tree with two, one, or zero cards still to come. `StreetGame` and `StreetBatchSolver` accept three-, four-, and five-card boards. The explorer and `river_solver` still use `RiverBatchSolver` for five cards. [ROADMAP.md](ROADMAP.md) assigns finishing that production join to M6. `RiverGame` stays the reference enumerator. Kuhn and Leduc stay on `CfrTrainer`.

## Modules

| Module | Role |
| --- | --- |
| `poker::kuhn` | Cards, public sequences, legal actions, infoset ids, net-chip utilities |
| `poker::kuhn::KuhnGame` | Those rules behind the extensive-game interface |
| `poker::solver::CfrTrainer<Game>` | Vanilla CFR and CFR+ for any type that models the interface |
| `regret_matching` | Current strategy from cumulative regret; reach-weighted accumulation |
| `compute_best_response` | Exact best response from the game tree, deepest information set first |
| `poker::leduc::LeducGame` | Six-card Leduc: two streets, one board card, fixed-limit bets |
| `KuhnCfrTrainer` | Vanilla-CFR wrapper kept for the original Kuhn entry point |
| `kuhn_solver`, `leduc_solver` | Command-line drivers over `CfrTrainer` |
| `poker::holdem` | Card ids, seven-card hand values, range weights, joint hand distribution |
| `poker::river::RiverGame` | Reference river tree: one copy of every hand pair |
| `poker::solver::RiverBatchSolver` | Same river rules on one public tree, with one-pass best response |
| `river_solver` | Command-line driver; public tree by default, `--reference` for the enumerator |
| `poker::streets::StreetGame` | Reference turn or flop tree: one betting structure for every runout, sizes per street |
| `poker::solver::StreetBatchSolver` | Same streets on one public betting tree, reusing each line on every runout |
| `street_solver` | Command-line driver; public tree by default, `--reference` for `StreetGame`, `--config` for a `street-config 1` document |
| `explorer` | Local page. Serves `ui/`. A river calls `RiverBatchSolver`; a flop or a turn calls `StreetBatchSolver` |

`expected_p1_utility` in `cfr.cpp` is a second Kuhn utility walk, used to check the generalized walker.

## Extensive-game interface

A game type provides a small `State` and these operations:

- `root`, `is_chance`, `is_terminal`, `p1_utility`
- `chance_count`, `chance_probability`, `child_chance`
- `infoset`, `acting_player`, `action_count`, `child_action`

Player 1’s utility is in net chips. Player 2’s utility is the negation. `acting_player` is 0 or 1. Actions are local indexes. The concept `ExtensiveGame` checks this at compile time.

Kuhn’s only chance node is the root deal: six equally likely ordered hands. After that, `State` holds the deal and the public `Sequence`. The information set is still `(player, private card, public sequence)`.

## Solver storage

Regrets and strategy sums are two `std::vector<double>` blocks. An offset table maps each information set to its first action. Kuhn has 12 information sets and 2 actions each, so 24 doubles per table. The inner CFR recursion uses stack arrays. The action-count scratch limit is 8 per information set.

CFR+ stores the same tables. Negative cumulative regrets are replaced by zero once, after the updating player's pass has summed its counterfactual regret. The opponent's table is left unchanged. The average strategy is weighted by the iteration index. Linear CFR weights both the new regret and the average strategy by the iteration index and leaves regrets signed. See [MATHEMATICS.md](MATHEMATICS.md).

## Best response

`compute_best_response` walks every information set of the responding player from the deepest public decision back to the root. At each set it sums opponent-and-chance-weighted continuation values and keeps the action with the larger sum. Ties keep the lower action index. The continuation already uses the chosen action at every deeper set.

The Nash gap is \(u_1(\mathrm{BR}_1,\bar\sigma_2)+u_2(\bar\sigma_1,\mathrm{BR}_2)\). Tests also enumerate all 64 pure plans per Kuhn player and require the same values. That enumeration checks Kuhn.

## Stopping

`SolveConfig` sets a maximum iteration count and an optional Nash-gap threshold. The threshold is used only when it is non-negative and `eval_interval` is positive. Runtime reported by `solve` is the regret-update loop, including any gap checks that can end the run early.

## Design limits

- The CFR engine solves Kuhn, Leduc, a heads-up river, and a heads-up turn or flop with a fixed list of bet sizes.
- Best response is exact. On Kuhn and Leduc, and on the reference river, it walks the tree once per information set. On the public river tree it is one bottom-up pass over the same actions.
- Convergence here is an equilibrium of this finite Kuhn tree.
- At most 8 actions per information set until the scratch arrays are widened.

## Kuhn public sequences

Betting is one round with unit antes and unit bets. Public history is `Sequence`.

- `Empty` — P1 Check or Bet
- `Check` — P2 Check or Bet
- `Bet` — P2 Fold or Call
- `CheckBet` — P1 Fold or Call
- Terminals: `CheckCheck`, `BetFold`, `BetCall`, `CheckBetFold`, `CheckBetCall`

## Information sets

Twelve infosets: three private cards for each of four decision points.

Ids 0–2: P1 first action (J, Q, K).  
Ids 3–5: P1 facing a bet.  
Ids 6–8: P2 facing a check.  
Ids 9–11: P2 facing a bet.

An infoset key is `(player, private_card, public_sequence)`. The opponent’s card is never stored. Chance deals six ordered distinct card pairs, each with probability `1/6`.

## Memory layout

Regrets and strategy sums live in the generic trainer. See the solver-storage section above.

## Utilities

Terminal payoffs are player-1 **net chips**, including the unit ante each player posts. Player 2’s payoff is the negation (zero-sum). See [MATHEMATICS.md](MATHEMATICS.md).

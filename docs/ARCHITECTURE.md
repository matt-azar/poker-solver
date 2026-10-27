# Architecture

Phase 4 adds six-card Leduc Hold'em on that same trainer. The regret update was not rewritten for the second game. See [LEDUC.md](LEDUC.md).

Phase 5 adds a 52-card deck, a seven-card evaluator, and 1,326-hand ranges under `poker::holdem`. See [HOLDEM.md](HOLDEM.md).

Phase 6 adds `poker::river::RiverGame`, a heads-up no-limit river on that trainer. Chance deals private hands from the two ranges. The regret update was not rewritten. See [RIVER.md](RIVER.md).

Phase 7 adds `poker::solver::RiverBatchSolver`. It keeps one copy of the public betting tree and runs the same regret update, in the same deal order, including the CFR+ floor between deals. Best response is one bottom-up pass: each river information set is one player, one private hand, and one public history, so that pass matches deepest-first best response on `RiverGame`. `CfrTrainer<RiverGame>` remains the reference and is selected with `--reference`. Kuhn and Leduc still use only `CfrTrainer`.

Phase 8 adds `poker::streets::StreetGame` for a turn or a flop. Later cards are chance nodes. The regret update was not rewritten. See [STREETS.md](STREETS.md).

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
| `poker::streets::StreetGame` | Turn or flop tree: later cards are chance, same pot-fraction bets |
| `street_solver` | Command-line driver over `CfrTrainer<StreetGame>` |

`expected_p1_utility` in `cfr.cpp` is a second Kuhn utility walk, used to check the generalized walker. It is not a second CFR implementation.

## Extensive-game interface

A game type provides a small `State` and these operations:

- `root`, `is_chance`, `is_terminal`, `p1_utility`
- `chance_count`, `chance_probability`, `child_chance`
- `infoset`, `acting_player`, `action_count`, `child_action`

Player 1’s utility is in net chips. Player 2’s utility is the negation. `acting_player` is 0 or 1. Actions are local indexes, not a global action id. The concept `ExtensiveGame` checks this at compile time.

Kuhn’s only chance node is the root deal: six equally likely ordered hands. After that, `State` holds the deal and the public `Sequence`. The information set is still `(player, private card, public sequence)`.

## Solver storage

Regrets and strategy sums are two `std::vector<double>` blocks. An offset table maps each information set to its first action. Kuhn has 12 information sets and 2 actions each, so 24 doubles per table. The inner CFR recursion uses stack arrays and does not allocate. The action-count scratch limit is 8 per information set.

CFR+ stores the same tables. Negative cumulative regrets are replaced by zero after each update, and the average strategy is weighted by the iteration index. See [MATHEMATICS.md](MATHEMATICS.md).

## Best response

`compute_best_response` walks every information set of the responding player from the deepest public decision back to the root. At each set it sums opponent-and-chance-weighted continuation values and keeps the action with the larger sum. Ties keep the lower action index. The continuation already uses the chosen action at every deeper set.

The Nash gap is \(u_1(\mathrm{BR}_1,\bar\sigma_2)+u_2(\bar\sigma_1,\mathrm{BR}_2)\). Tests also enumerate all 64 pure plans per Kuhn player and require the same values. That enumeration is a Kuhn-only check, not the solver used for new games.

## Stopping

`SolveConfig` sets a maximum iteration count and an optional Nash-gap threshold. The threshold is used only when it is non-negative and `eval_interval` is positive. Runtime reported by `solve` is the regret-update loop, including any gap checks that can end the run early. The final gap measurement after a fixed iteration count is not included in that timer.

## Design limits

- The CFR engine is used for Kuhn, Leduc, a heads-up river, and a heads-up turn or flop with a fixed list of bet sizes. It does not offer every legal chip amount.
- Best response is exact. On Kuhn and Leduc, and on the reference river, it walks the tree once per information set. On the public river tree it is one bottom-up pass over the same actions. It is not a sampled exploitability estimate.
- Convergence here is equilibrium of this finite Kuhn tree, not of unrestricted no-limit Hold’em.
- At most 8 actions per information set until the scratch arrays are widened.

## Kuhn public sequences

Betting is one round with unit antes and unit bets. Public history is `Sequence`, not a string of hidden cards.

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

Regrets and strategy sums live in the generic trainer, not in Kuhn-specific arrays. See the solver-storage section above.

## Utilities

Terminal payoffs are player-1 **net chips**, including the unit ante each player posts. Player 2’s payoff is the negation (zero-sum). See [MATHEMATICS.md](MATHEMATICS.md).

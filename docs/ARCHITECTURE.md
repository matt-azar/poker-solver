# Architecture

Phase 1–2 implements a standalone Kuhn Poker engine and a vanilla CFR trainer. The CFR code is already split from game rules so Phase 3 can introduce a generic extensive-form interface without changing the regret-matching math.

## Modules

| Module | Role |
| --- | --- |
| `poker::kuhn` | Cards, public sequences, legal actions, infoset ids, net-chip utilities |
| `poker::solver` regret matching | Current strategy from cumulative regret; average-strategy accumulation |
| `poker::solver::KuhnCfrTrainer` | Enumerated-chance vanilla CFR |
| `poker::solver` best response | Exact pure-strategy best response over 12 infosets |
| `kuhn_solver` | CLI: iterations, strategies, JSON dump |

The static library `poker_solver_core` has no Python or UI dependency.

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

Regrets and strategy sums are `std::vector<double>` of length `12 * 2`. Index `infoset * 2 + local_action`. Local action 0 is Check or Fold; local action 1 is Bet or Call. Tables are allocated in the trainer constructor; the inner CFR loop does not allocate on the heap.

## Utilities

Terminal payoffs are player-1 **net chips**, including the unit ante each player posts. Player 2’s payoff is the negation (zero-sum). See [MATHEMATICS.md](MATHEMATICS.md).

## Design limits (intentional)

- No CFR+ yet (Phase 3).
- No Leduc or Hold’em (Phases 4–6).
- Best response enumerates `2^6 = 64` pure plans per player, which is exact for Kuhn and will not scale to Hold’em.
- Convergence here is equilibrium of this finite Kuhn tree, not of unrestricted no-limit Hold’em.

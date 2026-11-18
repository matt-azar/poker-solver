# ICM equities

Malmuth-Harville ICM calculator, heads-up chip→ICM payoff adapter, and optional wiring through the street solve terminal. Chip EV stays on `chipTerminal` in `engine/src/poker/payoff.zig` ([RAKE.md](RAKE.md)). Opponent incentives are separate ([INCENTIVES.md](INCENTIVES.md)).

## Algorithm

`icm_equities(stacks, payouts)` returns each player's expected prize under
classic recursive ICM:

1. Let `T` be the sum of nonnegative stacks. Player `i` finishes first with
   probability `stacks[i] / T`.
2. Award `payouts[0]` (1st place) in expectation, remove that player, and
   recurse on the remaining stacks with `payouts[1..]`.
3. When one player remains, they receive the sum of any unpaid remaining
   places. Places past the end of `payouts` are worth 0.
4. A zero stack in a **post-hand** equity evaluation busted on this hand and
   takes the next worst place among the seats in `stacks` (last paid place
   when that prize exists). Remaining positive stacks contest only the front
   places.

Rejects empty stacks, negative or non-finite stacks/payouts, and a zero total.
Solve configs additionally require **every starting stack > 0** (remaining
field only).

## Pinned equities

Three players, stacks `5000 / 3000 / 2000`, payouts `50 / 30 / 20`:

| Seat | Exact equity | Decimal |
| --- | --- | --- |
| A (5000) | `1075/28` | ≈ 38.3928571429 |
| B (3000) | `131/4` | 32.75 |
| C (2000) | `202/7` | ≈ 28.8571428571 |

Tests check these to `1e-9`. Heads-up WTA collapses to stack share of the prize.

## Chip terminal → ICM delta

`applyIcmTerminal` (`engine/src/poker/icm.zig`) applies the
chip utilities of players 0 and 1 to those seats, leaves any further stacks
unchanged, and returns

`equity(post)[i] - equity(pre)[i]`

for `i ∈ {0,1}`. That is an ICM utility, not chip EV. Example: stacks
`1000/1000`, WTA prize `100`, chip delta `(+100, -100)` → ICM delta
`(+5, -5)`.

Empty ICM keeps the chip/rake terminal from `chipTerminal` in `engine/src/poker/payoff.zig`.

## Config

`IcmConfig` carries tournament `stacks[]` and `payouts[]`. Empty `stacks`
means ICM is off. The betting `stack` field is the effective stack for the
hand, not the tournament ICM stacks.

Enter only players still in the tournament, with positive stacks, and the
payout ladder for that remaining field. Do not pad already-out seats as
zeros: seat-order bust assignment would give them the wrong finishing place
(example: `150/1500/8350/0` with `50/30/15/5` credits a busted 150 with `5`
instead of `15`). Omit the out seat and use `150/1500/8350` with `50/30/15`.
A stack may still hit zero **during** the hand and receive its finishing
prize via post-hand equity.

`street-config 1` writes `icm-stacks` / `icm-payouts` only when stacks are
non-empty. Empty or omitted stacks leave the chip/rake path unchanged.
Malmuth-Harville pins live under `engine/src/poker/icm_rematch_test.zig`.

Study Settings has an ICM switch. With it on, the draft requires at least two
positive stacks and writes `icm-stacks` / `icm-payouts` into `street-config 1`.
Compile validates those arrays (`IcmConfig.validate` /
`validateStartingStacks` in `engine/src/poker/icm.zig`). Empty stacks leave
ICM off. Do not treat the math pins as a Pio ICM parity claim.

Compile rejects invalid `icm-stacks` and `icm-payouts`, including any zero
starting stack.

## Solve path

When ICM stacks are present, chip/rake terminals are wrapped with the
chip→ICM delta (`applyIcmTerminal` in `engine/src/poker/icm.zig`). That wrap
runs on every product terminal path:

| Path | Entry |
| --- | --- |
| Deal-by-deal CFR / `rootValue` | `engine/src/kernel/terminal.zig` via `traversal.zig` |
| Production frozen CFR+ train + BR / NashConv | `FrozenCtx.modeledTerminal` in `engine/src/solve/frozen_walk.zig` |
| Conditional action EV fold-now | `engine/src/analysis/action_ev.zig` |

On the frozen path, `FrozenCtx` builds an `icm.TerminalCache` at init: pre-hand
equity once, then each distinct terminal chip payoff (fold / win / lose / tie
per terminal node) once before the walk. Showdown visits reuse those deltas
instead of recomputing Malmuth-Harville per hand.

Empty ICM keeps the chip/rake terminal. HU WTA fold and check-down pins match
the examples above (chip `+50` → ICM `+2.5` on equal 1000 stacks with prize
100). Multiway bubble pins (`engine/src/solve/frozen_icm_rematch_test.zig`)
catch a frozen walk that skipped ICM and trained chip Call when prize EV
preferred Fold. The bubble fixture uses stacks `150/9820/30`, prizes
`50/50/0`, and a true 40% equity matchup so chip EV prefers Call while ICM
prefers Fold.

## Saves and Continue

Resumable ICM checkpoints set PSOL v4 `flag_icm_modeled_train`. Open restores
trainer tables only when that flag is present (or the save has no ICM stacks).
Pre-fix ICM files that trained in chips still open for browse, but Continue
is disabled — run a fresh Solve. Cash-game saves are unchanged.

Regret uses each seat's own utility. NashConv is the sum of the two
unilateral gains, `(br0-u0)+(br1-u1)`, including when ICM or rake makes the
utilities non-zero-sum (`engine/src/analysis/evaluation.zig`). The sum of the
two best-response utilities is a different number in that case. Action-label
incentives are a separate overlay after this wrap
([INCENTIVES.md](INCENTIVES.md)).

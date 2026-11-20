# Heads-up river

One no-limit betting street on a fixed five-card board. Equilibrium of the configured bet-size tree.

Five-card Study solves go through Zig `solver-engine` IPC, on the same Session path as flop and turn. See [STREETS.md](STREETS.md) and [DESKTOP_UI.md](DESKTOP_UI.md).

Chance is the ordered hand distribution from [HOLDEM.md](HOLDEM.md). Player 0 is out of position. Player 1 is in position. A hand pair is legal only when the four private cards and the board are disjoint. Deals are deterministic.

## Chips

Both players start the street with the same stack behind. The pot is dead money they contributed equally on earlier streets.

Player 0's utility is net chips from the start of the river:

- Showdown win, or the opponent folds: `pot / 2 + opponent river investment`
- Showdown loss, or player 0 folds: `-(pot / 2 + player 0 river investment)`
- Split pot: `0` after the street investments have been matched

Betting 100 into a pot of 100 and getting a fold wins 50, the same as winning a check-down. A called bet that wins is worth `pot / 2` plus the call.

Optional pot rake (`rake-rate` / `rake-cap` on `street-config 1`) subtracts the house take from the winner, or half each on a tie. Zero rake keeps the chip rule above. See [RAKE.md](auxiliary/payoffs/RAKE.md). Optional tournament ICM (`icm-stacks` / `icm-payouts` on the same document) wraps chip and rake terminals into equity deltas. Empty ICM stays on the chip path. See [ICM.md](auxiliary/payoffs/ICM.md). Optional action-label incentives (`incentive` / `edge-tag` lines) are path-attributed at terminals after chip and ICM. See [INCENTIVES.md](auxiliary/payoffs/INCENTIVES.md). Five-card spots use `street-config 1`.

## Sizes

Fractions are of the pot, rounded to the nearest tenth of a chip, with ties away from zero. Pot, stack, and contribution are stored as tenths (`engine/src/poker/chips.zig`). Config text writes chip units (`pot 100` = 100.0 chips). Utilities report chips.

- An opening size `f` bets `round(f * pot)` tenths (0.1-chip units).
- A raise size `f` raises by `round(f * pot_after_the_call)` tenths. `pot_after_the_call` is the pot once the facing bet has been called. The raiser also puts in the call.
- A listed size bigger than the remaining stack is re-interpreted as all-in. A legacy `allow-all-in 0` line still drops those sizes. `format_street_config` does not write `allow-all-in`.
- Equal amounts are one action.
- The minimum opening bet is 0.1 chip. A later raise must increase the commitment by at least the previous full bet or raise.
- With equal stacks, a player who faces an all-in cannot raise.
- The opening bet on a street does not count toward `max_raises`. Only facing raises do. `max_raises` 0 allows bets and no raises. At the raise cap the facing player can fold or call only. Check-only trees use empty or explicit-empty bet size lists.
- Raise sizes are separate from bet sizes. An omitted raise list stays empty. The engine does not copy bet sizes into it.
- At most 8 actions are legal at one decision. That is the trainer's scratch limit: check plus seven bets, or fold, call, and six raises.

## Toy equilibrium

Pot 100, stack 100, one all-in bet, no raises. Out of position holds `AcAd` or `5c5d` with equal weight. In position holds `KsKc`. The board is `Ah Kd 7c 4s 2h`, so aces always beat kings and fives always lose.

Check-down is worth +50 with aces and -50 with fives. A fold to the all-in wins +50. A called all-in is worth +150 with aces and -150 with fives. The equilibrium is:

- Aces always bet.
- Fives bet with probability 1/2.
- Kings call with probability 1/2.
- Player 0's value is +25.

## Nash gap

The Nash gap is NashConv, the sum of unilateral BR gains
`(u0(BR0)-u0(σ̄)) + (u1(BR1)-u1(σ̄))`. Under zero-sum chips that equals
`u0(BR0) + u1(BR1)`. Pio Accuracy (the stop metric) is NashConv/2.
The default unit is a pot fraction. Player 0 is out of position.

Host `solve` accepts `time_limit` and `accuracy` (pot fraction). Status JSON includes `time_limit_reached`. Saves are PSOL v4.

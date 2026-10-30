# Heads-up river

`RiverGame` is one no-limit betting street on a fixed five-card board. `CfrTrainer<RiverGame>` is the reference enumerator. `RiverBatchSolver` is the default: one public betting tree, the same per-deal regret update, and one best-response walk. Pass `--reference` to use the enumerator. Chance is the ordered hand distribution from [HOLDEM.md](HOLDEM.md): player 0 is out of position, player 1 is in position, and a pair of hands is legal only when the four private cards and the board are disjoint. There is no RNG.

This program remains a product entry point for a five-card board. `StreetGame` and `StreetBatchSolver` also accept a five-card board and match `RiverGame` on the pinned fixtures. The explorer still selects this engine for five cards. M6 retires `river_solver` after that production path moves fully onto the shared tree. See [ROADMAP.md](ROADMAP.md) and [STREETS.md](STREETS.md).

This is an equilibrium of the configured bet-size tree.

## Chips

Both players start the street with the same stack behind. The pot is dead money they contributed equally on earlier streets.

Player 0's utility is net chips from the start of the river:

- Showdown win, or the opponent folds: `pot / 2 + opponent river investment`
- Showdown loss, or player 0 folds: `-(pot / 2 + player 0 river investment)`
- Split pot: `0` after the street investments have been matched

An uncalled raise is not profit. Betting 100 into a pot of 100 and getting a fold wins 50, the same as winning a check-down. A called bet that wins is worth `pot / 2` plus the call.

## Sizes

Fractions are of the pot, rounded to the nearest chip, with ties away from zero.

- An opening size `f` bets `round(f * pot)` chips.
- A raise size `f` raises by `round(f * pot_after_the_call)` chips. `pot_after_the_call` is the pot once the facing bet has been called. The raiser also puts in the call.
- A listed size bigger than the remaining stack becomes an all-in when all-ins are allowed, and is dropped otherwise.
- Equal chip amounts are one action.
- The minimum opening bet is 1 chip. A later raise must increase the commitment by at least the previous full bet or raise.
- With equal stacks, a player cannot raise an opponent who is already all-in.
- The opening bet counts toward `max_raises`. At the cap, the facing player can fold or call only.
- If raise sizes are omitted on the command line or in JSON, they copy that player's bet sizes.
- At most 8 actions are legal at one decision. That is the trainer's scratch limit: check plus seven bets, or fold, call, and six raises.

## Toy equilibrium

Pot 100, stack 100, one all-in bet, no raises. Out of position holds `AcAd` or `5c5d` with equal weight. In position holds `KsKc`. The board is `Ah Kd 7c 4s 2h`, so aces always beat kings and fives always lose.

Check-down is worth +50 with aces and -50 with fives. A fold to the all-in wins +50. A called all-in is worth +150 with aces and -150 with fives. The equilibrium is:

- Aces always bet.
- Fives bet with probability 1/2.
- Kings call with probability 1/2.
- Player 0's value is +25.

`tests/unit/test_river.cpp` checks this profile. The solver computes it.

## Command line

```sh
river_solver --config configs/river_default.json
river_solver --iterations 2000 --algorithm cfr_plus
river_solver --board Ah,Kd,7c,4s,2h --pot 100 --stack 200 --oop-range AA --ip-range KK --oop-bets 0.5,1 --ip-bets 0.5,1 --max-raises 2
river_solver --reference --iterations 30 --algorithm vanilla --oop-range 22+ --ip-range 22+
```

The reported Nash gap is NashConv, `u0(BR0) + u1(BR1)`. Player 0 is out of position.

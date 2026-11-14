# Heads-up river

One no-limit betting street on a fixed five-card board. Equilibrium of the configured bet-size tree.

**Shipping on `main`:** five-card Study solves go through Zig `solver-engine` IPC (same Session path as flop/turn). C++ `RiverGame` / `river_solver` / Explorer names below are **historical** algorithm vocabulary — not a live product binary. See [STREETS.md](STREETS.md), [DESKTOP_UI.md](DESKTOP_UI.md).

Historically, `RiverGame` + `CfrTrainer` was the five-card oracle and `RiverBatchSolver` was for internal oracle/legacy fixtures. Chance is the ordered hand distribution from [HOLDEM.md](HOLDEM.md): player 0 OOP, player 1 IP; a hand pair is legal only when the four private cards and the board are disjoint. No RNG.

## Chips

Both players start the street with the same stack behind. The pot is dead money they contributed equally on earlier streets.

Player 0's utility is net chips from the start of the river:

- Showdown win, or the opponent folds: `pot / 2 + opponent river investment`
- Showdown loss, or player 0 folds: `-(pot / 2 + player 0 river investment)`
- Split pot: `0` after the street investments have been matched

An uncalled raise is not profit. Betting 100 into a pot of 100 and getting a fold wins 50, the same as winning a check-down. A called bet that wins is worth `pot / 2` plus the call.

Optional pot rake (`RiverConfig::rake`, CLI `--rake-rate` / `--rake-cap`, and `rake-rate` / `rake-cap` on `river-config 1`) subtracts the house take from the winner, or half each on a tie. Zero rake keeps the chip rule above bit-for-bit. See [RAKE.md](auxiliary/payoffs/RAKE.md). Optional tournament ICM (`RiverConfig::icm`, CLI `--icm-stacks` / `--icm-payouts`) wraps chip/rake terminals into equity deltas; empty ICM stays bit-identical. See [ICM.md](auxiliary/payoffs/ICM.md). Optional action-label incentives (`RiverConfig::incentives`, CLI `--incentive`) are path-attributed at terminals after chip/ICM; see [INCENTIVES.md](auxiliary/payoffs/INCENTIVES.md).

## Sizes

Fractions are of the pot, rounded to the nearest tenth of a chip, with ties away from zero. Internally pot/stack/contrib are tenths (historical C++ `include/game/chips.hpp`; Zig chip helpers under `engine/`); config text still writes chip units (`pot 100` = 100.0 chips). Utilities report chips.

- An opening size `f` bets `round(f * pot)` tenths (0.1-chip units).
- A raise size `f` raises by `round(f * pot_after_the_call)` tenths. `pot_after_the_call` is the pot once the facing bet has been called. The raiser also puts in the call.
- A listed size bigger than the remaining stack becomes an all-in when all-ins are allowed, and is dropped otherwise.
- Equal amounts are one action.
- The minimum opening bet is 0.1 chip. A later raise must increase the commitment by at least the previous full bet or raise.
- With equal stacks, a player cannot raise an opponent who is already all-in.
- The opening bet on a street does **not** count toward `max_raises`. Only facing raises do. `max_raises` 0 allows bets but no raises; at the raise cap the facing player can fold or call only. Check-only trees use empty / explicit-empty bet size lists.
- Raise sizes are separate from bet sizes. If raise sizes are omitted on the command line, or the JSON key is absent, they copy that player's bet sizes when raise multiples are also empty. A present empty raise array stays empty.
- At most 8 actions are legal at one decision. That is the trainer's scratch limit: check plus seven bets, or fold, call, and six raises.

## Toy equilibrium

Pot 100, stack 100, one all-in bet, no raises. Out of position holds `AcAd` or `5c5d` with equal weight. In position holds `KsKc`. The board is `Ah Kd 7c 4s 2h`, so aces always beat kings and fives always lose.

Check-down is worth +50 with aces and -50 with fives. A fold to the all-in wins +50. A called all-in is worth +150 with aces and -150 with fives. The equilibrium is:

- Aces always bet.
- Fives bet with probability 1/2.
- Kings call with probability 1/2.
- Player 0's value is +25.

`tests/unit/test_river.cpp` recorded this profile. That file is gone. The numbers are kept here as the checked toy.

## Historical command line (removed)

`river_solver` is not built. The commands below are the old C++ CLI.

```sh
river_solver --config configs/river_default.json
river_solver --iterations 2000 --algorithm cfr_plus
river_solver --board Ah,Kd,7c,4s,2h --pot 100 --stack 200 --oop-range AA --ip-range KK --oop-bets 0.5,1 --ip-bets 0.5,1 --max-raises 2
river_solver --board Ah,Kd,7c,4s,2h --oop-range AcAd --ip-range KsKc --no-all-in --max-raises 0 --rake-rate 0.05 --iterations 1
river_solver --reference --iterations 30 --algorithm vanilla --oop-range 22+ --ip-range 22+
river_solver --iterations 100000 --time-limit 5
river_solver --iterations 200 --report report.txt
```

`--time-limit SECONDS` stops at the next iteration boundary once that many wall-clock seconds have elapsed. The solver prints `time_limit_reached: 1` when the wall clock caused the stop. The same flag exists on `street_solver`. `--report FILE` writes a versioned `strategy-report 1` summary after the solve.

The reported Nash gap is NashConv, the sum of unilateral BR gains
`(u0(BR0)-u0(σ̄)) + (u1(BR1)-u1(σ̄))`. Under zero-sum chips that equals
`u0(BR0) + u1(BR1)`. Pio Accuracy (the stop metric) is NashConv/2.
`--accuracy` defaults to pot fraction; `--gap-threshold` is Accuracy in chips.
Player 0 is out of position.

## Historical strategy report

The removed `river_solver --report FILE` wrote a `strategy-report 1` document (`-` for stdout). On the public-tree path, root-action probabilities were the reach-weighted mixture from root inspection. `--reference` fell back to an unweighted open-infoset mean. There is still no batch queue. Current Study saves are PSOL v4.

# ICM equities

Malmuth-Harville ICM calculator, heads-up chip→ICM payoff adapter, and optional wiring through street/river solve terminals. Chip EV stays on `ChipPayoff` ([RAKE.md](RAKE.md)). Opponent incentives are separate ([INCENTIVES.md](INCENTIVES.md)).

## Algorithm

`icm_equities(stacks, payouts)` returns each player's expected prize under
classic recursive ICM:

1. Let `T` be the sum of nonnegative stacks. Player `i` finishes first with
   probability `stacks[i] / T`.
2. Award `payouts[0]` (1st place) in expectation, remove that player, and
   recurse on the remaining stacks with `payouts[1..]`.
3. When one player remains, they receive the sum of any unpaid remaining
   places. Places past the end of `payouts` are worth 0. A zero stack is
   already eliminated and never takes a remaining place.

Rejects empty stacks, negative or non-finite stacks/payouts, and a zero total.

## Pinned equities

Three players, stacks `5000 / 3000 / 2000`, payouts `50 / 30 / 20`:

| Seat | Exact equity | Decimal |
| --- | --- | --- |
| A (5000) | `1075/28` | ≈ 38.3928571429 |
| B (3000) | `131/4` | 32.75 |
| C (2000) | `202/7` | ≈ 28.8571428571 |

Tests check these to `1e-9`. Heads-up WTA collapses to stack share of the prize.

## Chip terminal → ICM delta

`IcmPayoff::from_chip_terminal(stacks, payouts, chip_terminal)` applies the
chip utilities of players 0 and 1 to those seats, leaves any further stacks
unchanged, and returns

`equity(post)[i] - equity(pre)[i]`

for `i ∈ {0,1}`. That is an ICM utility, not chip EV. Example: stacks
`1000/1000`, WTA prize `100`, chip delta `(+100, -100)` → ICM delta
`(+5, -5)`.

Zero-ICM / plain-chip mode is unchanged: keep calling `ChipPayoff::terminal`.

## Config

`IcmConfig` carries tournament `stacks[]` and `payouts[]`. Empty `stacks`
means ICM is off. The betting `stack` field is the effective stack for the
hand, not the tournament ICM stacks.

`street-config 1` writes `icm-stacks` / `icm-payouts` only when stacks are
non-empty. Empty or omitted stacks leave the chip/rake path unchanged.
Malmuth-Harville pins live under `engine/src/poker/icm_rematch_test.zig`.

Study Settings has an ICM switch. With it on, the draft requires at least two
stacks and writes `icm-stacks` / `icm-payouts` into `street-config 1`. Compile
validates those arrays (`engine/src/poker/icm.zig`). Empty stacks leave ICM off.
Do not treat the math pins as a Pio ICM parity claim.

Historical C++ Explorer Job JSON used flat keys `icm_stacks` / `icm_payouts`
and returned HTTP 400 on invalid values. That HTTP surface is removed.

## Solve path

When ICM stacks are present, chip/rake terminals are wrapped with the
chip→ICM delta (`applyIcmTerminal` in `engine/src/poker/icm.zig`, called from
`engine/src/kernel/terminal.zig`). Empty ICM keeps the chip/rake terminal.
HU WTA fold and check-down pins match the examples above (chip `+50` → ICM
`+2.5` on equal 1000 stacks with prize 100). The removed C++ sites were
`StreetGame`, `StreetBatch`, and `RiverBatchSolver`.

Regret uses each seat's own utility. NashConv is the sum of the two
unilateral gains, `(br0-u0)+(br1-u1)`, including when ICM or rake makes the
utilities non-zero-sum (`engine/src/analysis/evaluation.zig`). The sum of the
two best-response utilities is a different number in that case. Action-label
incentives are a separate overlay after this wrap
([INCENTIVES.md](INCENTIVES.md)).

# ICM equities

Planning date: October 30, 2026. Standalone Malmuth-Harville ICM calculator and
heads-up chip→ICM payoff adapter. Not wired into `StreetGame` / `RiverGame`
solves yet. Chip EV stays on `ChipPayoff` ([RAKE.md](RAKE.md)).

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

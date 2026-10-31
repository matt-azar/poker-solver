# ICM equities

Planning date: October 30, 2026. Malmuth-Harville ICM calculator, heads-up
chip→ICM payoff adapter, and optional wiring through street/river solve
terminals. Chip EV stays on `ChipPayoff` ([RAKE.md](RAKE.md)). Opponent
incentives remain separate ([INCENTIVES.md](INCENTIVES.md)).

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
means ICM is off. `StreetConfig::stack` / `RiverConfig::stack` remain the
betting effective stack for the hand — not tournament ICM stacks.

`StreetConfig::icm` and `RiverConfig::icm` are optional. `street-config 1` /
`river-config 1` emit `icm-stacks` / `icm-payouts` only when stacks are
non-empty. CLI flags `--icm-stacks` and `--icm-payouts` set them on
`street_solver` and `river_solver`. Explorer Job JSON uses flat keys
`icm_stacks` and `icm_payouts` (same validation against job pot/stack); the
GUI solve form sends them and status echoes them. Empty or omitted stacks
leave the chip/rake path unchanged.

When ICM is enabled, validate requires at least two seats, valid ICM inputs,
and both hero stacks covering the worst chip swing `pot/2 + effective_stack`
so `from_chip_terminal` cannot see a negative post-stack. Building a
`StreetGame` / `RiverGame` or batch solver with a bad ICM config rejects it.
Invalid explorer Job values are HTTP 400.

## Solve path

After `ChipPayoff::terminal(..., rake)`, if `config.icm` is enabled the
result is wrapped with `IcmPayoff::from_chip_terminal` (via
`apply_icm_terminal`). Sites:

- `StreetGame::terminal_payoff` / `RiverGame::terminal_payoff`
- `StreetBatch` serial `payoff`
- `StreetBatch::apply_terminal` (frozen fold + win/lose/tie showdown)
- `RiverBatchSolver::payoff`

CFR still trains on the player-0 scalar `utility[0]`. Empty ICM reproduces
prior chip/rake terminals bit-identically. HU WTA fold and check-down pins
match the chip→ICM examples above (chip `+50` → ICM `+2.5` on equal 1000
stacks with prize 100).

Nash-gap and best-response helpers that assume chip zero-sum remain
approximate under ICM (same caveat as positive rake). Multiway spectators are
accepted by the adapter but the p0-scalar CFR path is HU-oriented; incentives
CFR hooks beyond the p0 scalar, dual-utility Nash-gap, action-EV unit labels,
and dedicated PSOL ICM UI fields beyond config round-trip are out of scope
here. Action-label incentives are a separate overlay after this wrap
([INCENTIVES.md](INCENTIVES.md)).

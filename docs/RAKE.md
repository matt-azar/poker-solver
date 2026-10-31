# Pot rake

Planning date: October 30, 2026. This page documents the M8 pot-rake model on
`ChipPayoff`, and how street/river solvers pass it through training terminals.

## Config

`RakeConfig` has a `rate` in `[0, 1]` and a chip `cap` with `cap >= 0`. A zero
cap means uncapped. Invalid values fail `validate()` / `valid()`.

`StreetConfig::rake` and `RiverConfig::rake` carry the same fields. Defaults are
zero (no rake). `street-config 1` / `river-config 1` always write `rake-rate` and
`rake-cap`. CLI flags `--rake-rate` and `--rake-cap` set them on `street_solver`
and `river_solver`. Explorer Job JSON uses flat keys `rake_rate` and `rake_cap`
(same validation); the GUI solve form sends them and status echoes them.
Building a `StreetGame` or `RiverGame` with an invalid rake rejects the config.

## Collection

`collect(pot_chips, rake)` is the house take from the terminal pot
`initial_pot + contrib0 + contrib1` before winner attribution:

1. Compute `floor(rate * pot_chips)` in whole chips.
2. If `cap > 0`, take `min` of that amount and `cap`.
3. Never take more than `pot_chips`. A zero rate or nonpositive pot yields 0.

Examples: pot 200 at 5% → 10; pot 199 at 5% → 9; pot 200 at 5% with cap 5 → 5.

## Terminal utilities

Zero rake keeps the existing root-centered chip rule and
`utility[1] == -utility[0]` bit-for-bit with the no-argument `ChipPayoff::terminal`.

With rake `R > 0`:

- Winner (fold or showdown): that player's utility is the no-rake amount minus
  `R`. The loser keeps the no-rake utility. So `utility[0] + utility[1] == -R`.
- Tie (equal contributions): each player loses `R / 2`.

Fold win, pot 100, contrib 100/0, IP folds, 5%: no-rake `(50, -50)` becomes
`(40, -50)`. Showdown lose, pot 100, check-down, 5%: `(-50, 50)` becomes
`(-50, 45)`. Tie, pot 100, 5%: `(0, 0)` becomes `(-2.5, -2.5)`.

## Solve path

`StreetGame::terminal_payoff` and `RiverGame::terminal_payoff` pass `config.rake`
into `ChipPayoff::terminal`. `StreetBatchSolver` and `RiverBatchSolver` use the
same rake at public-tree / per-deal terminals, including the frozen showdown
kernel (winner pays full rake; ties split it). CFR still trains on the player-0
scalar. Nash-gap and best-response helpers that assume chip zero-sum remain
approximate under positive rake; ICM and opponent incentives are out of scope
here (see open M8 work). Zero rake reproduces prior chip terminals and pinned
fixtures bit-identically.

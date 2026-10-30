# Pot rake

Planning date: October 30, 2026. This page documents the M8 pot-rake model on
`ChipPayoff`. Solvers are not yet wired to pass a rake config through
`StreetGame` / `RiverGame`.

## Config

`RakeConfig` has a `rate` in `[0, 1]` and a chip `cap` with `cap >= 0`. A zero
cap means uncapped. Invalid values fail `validate()` / `valid()`.

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

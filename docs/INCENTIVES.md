# Opponent incentives

Planning date: October 30, 2026. Standalone action-label / category-tag utility
overlay on top of a base `PlayerPayoff` (chip or ICM). Not wired into CFR,
`StreetGame`, or `RiverGame` yet. Chip EV stays on `ChipPayoff`
([RAKE.md](RAKE.md)); ICM deltas stay on `IcmPayoff` ([ICM.md](ICM.md)).

## Model

An incentive biases one player's utility when a matching action is taken at a
node. The opponent's utility is unchanged unless a second rule targets them.
Matching rules stack by summing their deltas.

`IncentiveKind`:

| Kind | Match |
| --- | --- |
| `ActionLabelMatch` | `rule.key` equals `context.action_label` |
| `CategoryTag` | `rule.key` appears in `context.tags` |

A rule also requires `rule.player == context.player` (the acting seat). On a
match, `apply_incentives` returns a copy of the base payoff with
`utility[rule.player] += rule.delta`.

`IncentiveTable` owns a list of rules and forwards to `apply_incentives`.

## Examples

Base chip terminal `(+10, -10)`:

| Rules | Context | Result |
| --- | --- | --- |
| (none) | any | `(+10, -10)` identity |
| label `b75` → P0 `+3.5` | P0 takes `b75` | `(+13.5, -10)` |
| tag `bluff` → P1 `+2` | P1 takes tagged bluff | `(+10, -8)` |
| label `b50` → P0 `+1` and tag `bluff` → P0 `+4` | P0 `b50` with tag `bluff` | `(+15, -10)` |

## Solve path

This overlay is model + unit tests only. Solvers still train on the player-0
chip scalar. Wiring incentives into terminal evaluation and best response is a
later M8 step.

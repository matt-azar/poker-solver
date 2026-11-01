# Opponent incentives

Action-label / category-tag utility overlay on a base `PlayerPayoff` (chip or ICM), optionally wired through street/river solve terminals. Chip EV: [RAKE.md](RAKE.md). ICM: [ICM.md](ICM.md).

## Model

An incentive biases one player's utility when a matching action is taken at a
node. The opponent's utility is unchanged unless a second rule targets them.
Matching rules stack by summing their deltas.

`IncentiveKind`:

| Kind | Match |
| --- | --- |
| `ActionLabelMatch` | `rule.key` equals `context.action_label` (standalone API), or the edge's compact token / display chip label on the solve path |
| `CategoryTag` | `rule.key` appears in `context.tags` / edge tags |

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

## Config

`IncentiveConfig` carries `rules[]`. Empty rules mean incentives are off.
`StreetConfig::incentives` and `RiverConfig::incentives` are optional.
`street-config 1` / `river-config 1` emit one `incentive` line per rule:

```
incentive label 0 b100 3.5
incentive tag 1 bluff -2
```

CLI `--incentive kind,player,key,delta` appends one rule (repeatable) on
`street_solver` and `river_solver`. Preferred ActionLabelMatch keys are the
compact tokens also used by tree edits (`f`, `c`, `call`, `b100`, `r200`, …);
display chip labels (`Fold`, `Bet 100`, …) also match on the solve path.

## Solve path

After `ChipPayoff::terminal(..., rake)` and optional ICM, matching
`ActionLabelMatch` rules are path-attributed at terminals: every betting action
on the root-to-terminal path contributes its matching deltas via
`apply_path_incentives`. Sites:

- `StreetGame::terminal_payoff` / `RiverGame::terminal_payoff`
- `StreetBatch` serial `payoff` / `apply_terminal` (precomputed `incentive_u0`)
- `RiverBatchSolver::payoff` (precomputed `incentive_u0`)

Empty incentives reproduce prior chip/ICM terminals bit-identically.

CFR still trains on the player-0 scalar `utility[0]`. Rules that only change
`utility[1]` appear in `terminal_payoff` but do not move the current CFR /
batch training signal. CategoryTag rules need edge tags; solve-path edges
currently carry none, so those rules never fire until a later mid-tree tag PR.

Do **not** claim Nash-gap / NashConv under active incentives: gap helpers that
assume chip zero-sum stay approximate (same family of caveat as positive rake
or ICM). Dual-utility best response, explorer Job JSON, and combo category tags
are out of scope here.

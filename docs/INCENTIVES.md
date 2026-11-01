# Opponent incentives

Action-label / category-tag utility overlay on a base `PlayerPayoff` (chip or ICM), wired through street/river solve terminals, dual-utility best response / CFR, and explorer Job JSON/GUI. Chip EV: [RAKE.md](RAKE.md). ICM: [ICM.md](ICM.md).

## Model

An incentive biases one player's **modeled utility** when a matching action is
taken at a node. The opponent's utility is unchanged unless a second rule
targets them. Matching rules stack by summing their deltas.

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

`IncentiveConfig` carries `rules[]` and optional `edge_tags[]`. Empty rules mean
incentives are off. `StreetConfig::incentives` and `RiverConfig::incentives` are
optional. `street-config 1` / `river-config 1` emit one `incentive` line per
rule and one `edge-tag` line per tag assignment:

```
incentive label 0 b100 3.5
incentive tag 1 bluff -2
edge-tag b100 bluff
edge-tag 1 f give_up
```

CLI:

- `--incentive kind,player,key,delta` (repeatable) on `street_solver` /
  `river_solver`
- `--edge-tag [player,]action,tag[,tag...]` (repeatable)

Preferred ActionLabelMatch keys are the compact tokens also used by tree edits
(`f`, `c`, `call`, `b100`, `r200`, …); display chip labels (`Fold`, `Bet 100`, …)
also match on the solve path.

### How CategoryTag tags are assigned

Solve-path edges are public betting actions. Category tags are **not** inferred
from hand strength in this milestone. Configure them explicitly:

1. Add an `edge-tag` (config / CLI / Job `edge_tags`) that matches the edge's
   compact token or display label. Optional `player` `0`/`1` restricts the seat;
   omitted / `-1` means either seat.
2. Matching edges receive those tags via `attach_edge_tags` when the root-to-
   terminal path is built (`StreetGame` / `RiverGame` / street & river batch).
3. `incentive tag PLAYER KEY DELTA` then fires when `KEY` appears on that edge's
   tag list and the acting seat equals `PLAYER`.

Without an `edge-tag` (or equivalent tags on the edge), CategoryTag rules never
match on the solve path. Combo / draw category auto-tagging remains ahead.

## Solve path

After `ChipPayoff::terminal(..., rake)` and optional ICM, matching rules are
path-attributed at terminals: every betting action on the root-to-terminal path
contributes its matching deltas via `apply_path_incentives`. Sites:

- `StreetGame::terminal_payoff` / `RiverGame::terminal_payoff`
- `StreetBatch` serial `payoff` / `apply_terminal` (precomputed `incentive_u0` /
  `incentive_u1`)
- `RiverBatchSolver::payoff` (precomputed `incentive_u0` / `incentive_u1`)

Empty incentives reproduce prior chip/ICM terminals bit-identically.

## Dual-utility training and best response

CFR and best response maximize each seat's **own modeled utility**
(`PlayerPayoff::utility[player]`). Player-1-only incentive rules therefore move
training and BR. Under plain zero-sum chips this matches the historical
player-0-scalar + negation path.

Labels:

| Quantity | Meaning |
| --- | --- |
| Chip EV | `ChipPayoff` only (rake/ICM/incentives off) |
| Modeled utility | Chip → optional ICM → path incentives |

`SolveStats::p1_expected_utility` / `p1_best_response_utility` are player-0
modeled utility. `p2_best_response_utility` is player-1 modeled utility when
player 1 best-responds. `nash_gap` is the sum of unilateral BR **gains** in
modeled utility (general-sum NashConv). **Do not claim chip Nash-gap / NashConv
under active incentives** (same family of caveat as positive rake or ICM).

## Explorer Job JSON / GUI

`/api/solve` accepts and status echoes:

```json
"incentives": [
  {"kind": "label", "player": 0, "key": "b100", "delta": 3.5},
  {"kind": "tag", "player": 1, "key": "bluff", "delta": -2}
],
"edge_tags": [
  {"player": -1, "action": "b100", "tags": ["bluff"]},
  {"player": 1, "action": "f", "tags": ["give_up"]}
]
```

Omit both (or send empty arrays) for the chip/ICM path. Desktop Study Build and
legacy `ui/` expose matching text fields (`;`-separated lines with the same
spelling as street-config).

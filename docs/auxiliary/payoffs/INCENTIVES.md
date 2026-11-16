# Opponent incentives

Action-label / category-tag utility overlay on a chip or ICM terminal. Chip EV: [RAKE.md](RAKE.md). ICM: [ICM.md](ICM.md).

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
incentives are off. `street-config 1` emits one `incentive` line per
rule and one `edge-tag` line per tag assignment:

```
incentive label 0 b100 3.5
incentive tag 1 bluff -2
edge-tag b100 bluff
edge-tag 1 f give_up
```

`street-config 1` lines are the live format.

Preferred ActionLabelMatch keys are the compact tokens also used by tree edits
(`f`, `c`, `call`, `b100`, `r200`, …); display chip labels (`Fold`, `Bet 100`, …)
also match on the solve path.

### How CategoryTag tags are assigned

Solve-path edges are public betting actions. Category tags are **not** inferred
from hand strength in this milestone. Configure them explicitly:

1. Add an `edge-tag` line on `street-config 1` that matches the edge's
   compact token or display label. Optional `player` `0`/`1` restricts the seat;
   omitted means either seat.
2. Matching edges receive those tags when the public tree is compiled
   (`engine/src/game/compile.zig`).
3. `incentive tag PLAYER KEY DELTA` then fires when `KEY` appears on that edge's
   tag list and the acting seat equals `PLAYER`.

Without an `edge-tag` (or equivalent tags on the edge), CategoryTag rules never
match on the solve path. Combo / draw category auto-tagging remains ahead.

## Solve path

After the chip+rake terminal and optional ICM, `engine/src/kernel/terminal.zig`
adds the path's precomputed `incentive_u0` / `incentive_u1`.

Empty incentives reproduce prior chip/ICM terminals bit-identically.

## Dual-utility training and best response

CFR and best response maximize each seat's own modeled utility
(`PlayerPayoff.utility[player]` in `engine/src/poker/payoff.zig`). Player-1-only incentive rules therefore move
training and best response. With zero rake and no incentives, `utility[1]` is the negation of `utility[0]`.

Labels:

| Quantity | Meaning |
| --- | --- |
| Chip EV | `chipTerminal` only (rake/ICM/incentives off) |
| Modeled utility | Chip → optional ICM → path incentives |

Host status reports `player0_expected_utility`, `p1_best_response` (player 0 best-response utility), `p2_best_response` (player 1), and `nash_gap`. `nash_gap` is the sum of unilateral best-response gains in modeled utility. With rake, ICM, or incentives on, that gap is modeled utility. It is chip NashConv only when those overlays are off.

## Config / GUI

Incentives and edge tags round-trip in `street-config 1` text.
Omit both, or send empty arrays, for the chip and ICM path. Desktop Study Build
exposes matching text fields. Each line uses the same spelling as street-config.

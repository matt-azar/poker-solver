# Architecture

The Study engine is Zig. `zig build` installs `solver-engine`, `holdem-study-cli`, `street-config-check`, and `gate-bench`. Study talks to `solver-engine` over protocol 2 on inherited pipes. The trainer is CFR+. PSOL files are version 4 and store that algorithm byte (`formats/src/psol_v4.zig`).

Index: [README.md](README.md). See [STREETS.md](STREETS.md), [RIVER.md](RIVER.md), [DESKTOP_UI.md](DESKTOP_UI.md), [HOLDEM.md](HOLDEM.md), [EXPLORER.md](EXPLORER.md).

## Layout

| Path | Role |
| --- | --- |
| `engine/src/poker/` | Cards, evaluator, ranges, chips, rake, ICM, incentives |
| `engine/src/game/` | `street-config 1`, betting rules, compile |
| `engine/src/solve/` | CFR+ train, frozen walk, locks, strategy edits |
| `engine/src/analysis/` | Action values, equity, categories, best response |
| `engine/src/kernel/terminal.zig` | Chip payoff, then rake, then ICM, then path incentives |
| `app/src/session.zig` | Session train, pause, save, open |
| `host/` | `solver-engine` typed IPC |
| `cli/` | `holdem-study-cli`, `street-config-check`, and `gate-bench` |
| `desktop/` | React Study UI and Tauri shell |

Settings shows a read-only CFR+ field. The host trains with `trainFrozenCfrPlus`.

## One postflop tree

Flop, turn, and river share one public betting tree. Board length is 3, 4, or 5. Range catalogues live under `configs/range-profiles/`. The Study client imports those files.

## Players and chance

Player 0 is out of position. Player 1 is in position. Utilities are net chips. With zero rake they sum to zero. Chance deals ordered hand pairs from the joint range, then later board cards when any remain.

## Storage

Training tables are `engine/src/solve/training_state.zig`. The session keeps `regret`, `strategy_sum`, and `sigma`. Publish writes a separate average. Slot lookup is by public node, legal runout, and supported hand. One-action decisions omit stored rows. The action-count limit is 8. Details: [STREETS.md](STREETS.md).

Locks are `engine/src/solve/node_lock.zig`. A line lock uses turn and river `-1` and applies on every runout of that line. A node lock keeps the selected cards. Lookup tries the exact runout, then the line lock. A full lock stores one action row. A selected lock stores per-combo rows. An empty probability row is unlocked. A stored 0 is a locked frequency of 0. Publish and best response apply the effective lock after regret matching.

CFR+ floors the updating player's cumulative regrets once after that player's pass. The opponent's table stays unchanged. The average strategy is weighted by the iteration index. See [MATHEMATICS.md](MATHEMATICS.md).

## Best response and Nash gap

Best response walks every information set of the responding player from the deepest public decision back to the root. At each set it keeps the action with the larger opponent-and-chance-weighted continuation. Ties keep the lower action index.

The Nash gap is NashConv, the sum of unilateral BR gains
\((u_0(\mathrm{BR}_0)-u_0(\bar\sigma))+(u_1(\mathrm{BR}_1)-u_1(\bar\sigma))\).
Under zero-sum chips this equals \(u_0(\mathrm{BR}_0)+u_1(\mathrm{BR}_1)\).
`FrozenEval` in `engine/src/solve/frozen_walk.zig` stores `nash_gap` and `accuracy` (`NashConv/2`). Pio Accuracy is that average. The stop unit on host `solve` is a pot fraction.

## Stopping

Host `solve` passes `iterations`, `accuracy` (pot fraction of Pio Accuracy), optional `eval_every`, and `time_limit` into `Session.trainGated` (`app/src/session.zig`). `accuracy` at or below 0 leaves the stop on the iteration cap and the time limit. A positive `accuracy` stops when Accuracy chips are at or below `accuracy * pot`. Pot is stored in tenths. The fraction is multiplied by chip pot, then compared with Accuracy chips. `eval_every` is the EV/gap sample period. When the field is omitted, the host derives it from `samples` and caps the period at 10 iterations. `time_limit` stops at the next iteration boundary. The `solve` runtime is the regret-update loop, including Accuracy checks that end the run.

## Design limits

- Production trees use a fixed list of bet sizes, plus geometric, all-in, and pot-cap rules.
- Best response is exact on the game that was solved.
- At most 8 actions per information set.
- `zig build test` runs the test blocks in `engine/`, `app/`, `formats/`, and `host/`.

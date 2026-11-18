# Equity

Exact showdown equity for a flop, turn, or river.

Study node equity uses host op `equity`. The Equity Calculator uses `start_equity_job`, `get_equity_job`, and `cancel_equity_job`. This page is not a Pio equity-parity claim.

The pair enumerator reads the requested weights and board. It does not edit ranges or build a betting tree. The library default (`default_max_pair_runouts`, 1,100,000) admits a full-range river and rejects a full-range turn. Study node equity uses `study_explorer_max_pair_runouts` (51,369,120).

## Model

Equity is the expected fraction of the pot won at showdown. A tie contributes one half. Chip EV and strategic action values are separate quantities. Reported numbers are fractions in `[0, 1]`.

For a legal ordered pair of private hands, every legal completion of the board is equally likely. A turn has 44 river cards. A flop has `C(45, 2) = 990` unordered two-card completions. A river is already complete. Unordered flop completions are valid here because this calculator has no betting between the flop and the river. A strategic tree still walks those cards in order.

Player 0's hand equity and range equity use the opponent's input weights:

```text
D0(h) = sum of w1(g) over compatible g
E0(h) = sum of w1(g) * e(h,g) / D0(h) when D0(h) > 0
Z = sum of w0(h) * D0(h)
m0(h) = w0(h) * D0(h) / Z when Z > 0
range equity = sum of m0(h) * E0(h)
```

`e(h,g)` is `(wins + ties / 2) / completions` for player 0. Player 1 uses its own wins and ties. Input weights stay distinct from posterior marginals `m(h)`.

Positive-weight combos are returned in ascending combo index, including board-blocked and unsupported rows with `defined == false`. Zero-weight combos are omitted. An empty legal joint returns success with `joint_defined == false`.

Invalid boards, invalid range syntax, nonfinite or negative weights, cancellation, an exceeded work limit, and a finite input whose derived mass is not a finite double are different errors. A structurally empty legal joint is success.

## Limits

Pair-showdown constants are in `engine/src/analysis/equity.zig`. `default_max_pair_runouts` is 1,100,000. A full off-board random-vs-random river is 1,070,190 pair-runouts and fits that default. A full-range turn (`As Kd Qc Jh`, 51,369,120 pair-runouts) does not. Study node equity passes `study_explorer_max_pair_runouts` (51,369,120) from the host. `solver-engine` takes `--launch-id` only. Dense flop check-downs can still exceed the Study ceiling and return `error.WorkLimit` before evaluation. The function evaluates every counted runout. After a solve, warm Study equity uses a separate hand×runout ceiling, `study_warm_max_hand_runouts`.

## Memory and work

The preflight stores at most 1,326 hand descriptors per player. Showdown evaluation then allocates two 1,326-bin accumulators, about 220 KiB, plus a 49-card stack buffer. There is no all-deals table and no global cache. A rejected limit does not allocate the bins and does not call the evaluator. The unit test measures the full off-board river `As Kd Qc Jh 9c` at 1,070,190 pair-runouts under the default 1,100,000 ceiling, rejects it when the caller sets 1,070,189 or 1,000,000, and rejects a full-range turn at the default before evaluation.

Pair showdown equity sits outside the `memory_mib` engine budget (`app/src/budget_allocator.zig`). Its bound is the explicit pair-runout limit plus the fixed buffers above.

## Numerical limits

`showdownEquity` uses `f64`. Errors are `InvalidEquity`, `InvalidWeight`, `WorkLimit`, and `OutOfMemory`. Compatible mass is the direct sum of opponent input weights.

The multiway Equity Calculator is `engine/src/analysis/equity_calculator.zig`. It takes 2–6 players, boards of length 0, 3, 4, or 5, dead cards, and methods `auto`, `exact`, and `monte_carlo`. `auto` enumerates exactly when the deal estimate is at or below `auto_exact_threshold` (2,000,000). Exact requests above `default_max_exact_deals` (5,000,000) return `WorkLimit`. `NumericalRange` is a calculator error for a non-finite scaled weight. Per-combo and next-card panes are not mounted. Study calls this through `start_equity_job`, `get_equity_job`, and `cancel_equity_job`.

Enumeration in `showdownEquity` is complete. Pair outcomes use integer win, tie, and loss counts. Reported `input_weight` and `compatible_mass` stay in the original unnormalized units.

Per combo, `showdownEquity` divides that combo's win, tie, and loss sums by `compatible_mass`. Range win, tie, loss, and equity divide by the joint mass (sum of `w0 * w1` over legal pairs). A combo with `compatible_mass <= 0` stays undefined.

A bad pair-showdown weight is `InvalidWeight`. The multiway calculator returns `InvalidWeight` or `NumericalRange` when a scaled weight or a finished equity is not a finite `f64`.

A single opponent weight of `1e308` is representable and is accepted.

Rounding `1 + 1e-18` to `1` is ordinary double-precision behavior. On `Kh Kd 7c 4s`, OOP `AhAd,9c9d`, IP `AhAc:1,2c3d:epsilon`:

| Epsilon | `AhAd` equity | `AhAd` compatible mass | `AhAc` | `AhAc` compatible mass |
| --- | ---: | ---: | --- | ---: |
| `1e-12` | 1 | `9.9999999999999998e-13` | defined | 1 |
| `1e-18` | 1 | `1.0000000000000001e-18` | defined | 1 |

`AhAc` stays in the result because it is compatible with `9c9d`. `2c3d` has compatible mass 2. For `1e-18`, `9c9d`'s own mass prints as 1 because `1 + 1e-18` rounds to 1. For `1e-12`, that mass prints as `1.0000000000010001`.

## Tests

`zig build test` runs the equity rematch tests. Study node equity and the calculator also go through the host IPC contract smoke and desktop Vitest. See [TESTING.md](auxiliary/engineering/TESTING.md).

## Study use

Study node equity uses host IPC `equity` with reach-weighted strategy-conditioned masses at the selected node (own actions times card removal), plus showdown rank tables. On a flop it averages one representative per unordered board completion. On a turn or river it uses the node's board. The result is the same showdown fraction as the standalone enumerator on those reaches. The Equity Calculator remains a separate IPC job surface and keeps the pair-runout work limit. The payload keeps the ten-bucket histogram and compact `oop_hands` / `ip_hands` rows (`combo`, `equity`, raw `weight`) so the desktop Study **Range equity** dock tab can filter histogram bands and plot an OOP vs IP equity distribution chart. Zero-weight and undefined combos stay omitted from those rows. Ledger status: [FEATURE_PARITY.md](auxiliary/planning/FEATURE_PARITY.md).

## Standalone Equity calculator

The desktop Equity workspace is independent of any solution. Packaged Study uses `start_equity_job`, `get_equity_job`, and `cancel_equity_job`. The completed status carries the result. Entry point: `engine/src/analysis/equity_calculator.zig`. Player count, board lengths, methods, and deal caps are in the numerical section above (`auto_exact_threshold` 2,000,000, `default_max_exact_deals` 5,000,000).

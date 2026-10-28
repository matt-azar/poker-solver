# Check-down showdown equity

Standalone exact equity for a flop, turn, or river. Branch `cursor/exact-equity-core`, rebased onto development `27236ac1f8d2ae42aa3130b48351c484a85d8585` and not merged. This is the numerical foundation for roadmap M2. It does not edit ranges, build a betting tree, or read solver state.

## Model

Check-down showdown equity is the expected fraction of the pot won at showdown. A tie contributes one half. Chip EV and strategic action values are separate quantities. Reported numbers are fractions in `[0, 1]`.

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

Positive-weight combos are returned in ascending combo index, including board-blocked and unsupported rows with `defined == false`. Zero-weight combos are omitted. A later counterfactual query for an omitted hand needs its own interface. An empty legal joint returns success with `joint_defined == false`. It does not invent a uniform range or a zero equity.

Invalid boards, invalid range syntax, nonfinite or negative weights, cancellation, and an exceeded work limit are different errors (`EquityFailure`).

## API

```cpp
poker::holdem::ShowdownEquityOptions options;
options.max_pair_runouts = 1000000;
const std::vector<int> board = poker::holdem::parse_equity_board("Kh Kd 7c 4s");
const poker::holdem::Range oop = poker::holdem::parse_equity_range("AhAd,9c9d");
const poker::holdem::Range ip = poker::holdem::parse_equity_range("AhAc:1,2c3d:1e-18");
const poker::holdem::ShowdownEquity equity =
    poker::holdem::showdown_equity(board, oop, ip, options);
```

`measure_showdown_work` counts legal pairs and pair-runouts and does not evaluate showdowns. `showdown_equity_json` writes undefined numbers as null.

The default work limit is `kDefaultMaxPairRunouts` (1,000,000 pair-runouts). A request above the limit throws before showdown evaluation and reports required and allowed counts. The caller can raise the limit. The calculator does not sample or drop runouts. Cancellation uses `ShowdownEquityOptions::cancel_poll`. One deterministic thread performs the enumeration.

## CLI

```sh
equity_calculator --board "Kh Kd 7c 4s" \
  --oop "AhAd,9c9d" --ip "AhAc:1,2c3d:1e-18" \
  --max-pair-runouts 1000000 --json
```

Range text is the existing `Range::parse` syntax. Exit 0 prints the result. Exit 1 is invalid input, 2 is an invalid weight, 3 is the work limit, and 4 is cancellation.

On this Windows machine the command above printed:

```json
{"model":"check-down","units":"fraction of the pot","tie_share":0.5,"board":["Kh","Kd","7c","4s"],"joint_defined":true,"legal_pairs":3,"completions_per_pair":44,"pair_runouts":132,"elapsed_seconds":0.0006845,"players":[{"equity":0.045454545454545456,"combos":[{"combo":"AhAd","input_weight":1,"defined":true,"compatible_mass":1.0000000000000001e-18,"marginal":1.0000000000000001e-18,"equity":1}]},{"equity":0.95454545454545459}]}
```

The full line also includes both players' win, tie, and loss fractions and every positive-weight combo. `AhAd` is defined with equity 1. Its only compatible opponent is `2c3d` at weight `1e-18`. The same shape at `1e-12` is covered by the unit tests.

Sparse timings from the same run, one pair each, limit 100,000:

| Spot | Pair-runouts | Elapsed seconds |
| --- | ---: | ---: |
| River `Kh Kd 7c 4s 2h`, `AhAd` vs `2c3d` | 1 | 0.0000894 |
| Turn `Kh Kd 7c 4s`, the command above | 132 | 0.000685 |
| Flop `Ah Kd 7c`, `2c2d` vs `9c9d` | 990 | 0.004059 |

These are single runs on this machine. They are not a comparison with Pio or with the strategic kernel.

## Memory and work

The preflight stores at most 1,326 hand descriptors per player. Showdown evaluation then allocates two 1,326-bin accumulators, about 220 KiB, plus a 49-card stack buffer. There is no all-deals table and no global cache. A rejected limit does not allocate the bins and does not call the evaluator. The unit test rejects the full off-board river `As Kd Qc Jh 9c` at 1,070,190 pair-runouts against the default limit of 1,000,000.

This module does not use `BudgetResource` or the street solver's 1024 MiB engine budget. Its bound is the explicit pair-runout limit plus the fixed buffers above.

## Numerical limits

Enumeration is complete. Pair outcomes use integer win, tie, and loss counts. Compatible mass is the direct sum of compatible opponent input weights. Hand and range totals use compensated summation of nonnegative terms. A non-finite aggregate or combo result throws `EquityFailure::InvalidWeight`.

Rounding `1 + 1e-18` to `1` is ordinary double-precision behavior. Losing `AhAd`'s only compatible opponent because `AhAc` has weight 1 is a different defect: subtracting the blocked weight from a total that has already rounded `1 + epsilon` to `1` yields zero and drops the hand. This calculator does not do that subtraction. On `Kh Kd 7c 4s`, OOP `AhAd,9c9d`, IP `AhAc:1,2c3d:epsilon`:

| Epsilon | `AhAd` equity | `AhAd` compatible mass | `AhAc` | `AhAc` compatible mass |
| --- | ---: | ---: | --- | ---: |
| `1e-12` | 1 | `9.9999999999999998e-13` | defined | 1 |
| `1e-18` | 1 | `1.0000000000000001e-18` | defined | 1 |

`AhAc` stays in the result because it is compatible with `9c9d`. `2c3d` has compatible mass 2. For `1e-18`, `9c9d`'s own mass prints as 1 because `1 + 1e-18` rounds to 1. For `1e-12`, that mass prints as `1.0000000000010001`.

The oracle in `tests/equity/test_equity.cpp` stores each pair's runout results, then accumulates in descending combo order with `long double`. It shares `compare_showdown` and does not call the production accumulators. Agreement on the small fixtures, including a seeded 5-combo flop, is within `1e-12`. On this MSVC toolchain `long double` is the same width as `double`, so that bound is justified by compensated summation of a few dozen nonnegative terms of size at most 1, not by extra significand bits.

## Tests

`equity_tests` is its own executable and CTest target. It does not use the shared harness. Fresh directory `build-review`, MSVC 19.40.33811.0, Visual Studio 17 2022, Release. CTest: `poker_solver_tests` passed in 23.40 seconds, `equity_tests` passed in 0.46 seconds, 2 of 2. Direct totals: `equity_tests` `passed=570 failed=0`; an isolated `poker_solver_tests` run `passed=438630 failed=0`. HTTP cases ran on this Windows host. `node tests/ui/browse.test.js` printed `browse tests passed`. One earlier direct suite run reported `passed=438629 failed=1` at `test_value_worker.cpp:149` (`reader_count() == 0`). The isolated rerun was clean. Equity code does not call that worker.

Debug `equity_tests` compiled with `/EHsc /fsanitize=address` and run with `clang_rt.asan_dynamic-x86_64.dll` on `PATH` reported `passed=570 failed=0`. Passing `/fsanitize=address` only as a link option is ignored by `link.exe` and is not a sanitizer pass; that earlier binary failed to start with `STATUS_DLL_NOT_FOUND`. UBSan was not run. The development suite was not run under ASan.

Coverage includes river certainty, a royal-flush tie, 990 and 44 completions, blockers, the `AhAd`/`AhAc`/`2c3d` fixture at `1e-12` and `1e-18`, rescaling, a changed hero prior, undefined joints, invalid input, player swap, suit permutation, posterior and equity identities, weighted reconstruction against an unweighted average, work-limit boundaries, deterministic cancellation, unchanged inputs, and seeded sparse ranges.

## Later M2 adapter

A study-screen adapter can build two `Range` values from strategy-conditioned combo weights at one node and call `showdown_equity` with that node's board. Those weights must stay finite and nonnegative. The calculator will treat them as check-down input weights. It will not read the tree, the average strategy, or the engine budget. Zero-weight hands remain omitted, so a hand removed by a filter is absent from the rows. This document does not add that adapter, an HTTP route, or UI controls.

## Proposed ledger row

For the primary agent after integration:

| Family | Status | Milestone | Evidence | Limitation |
| --- | --- | --- | --- | --- |
| Exact check-down showdown equity | partial | M2 | `equity_calculator` and `equity_tests` on `cursor/exact-equity-core`, rebased onto `27236ac` | Pending independent review. No range editor, categories, strategy-conditioned adapter, HTTP route, or study screen. No Pio comparison. |

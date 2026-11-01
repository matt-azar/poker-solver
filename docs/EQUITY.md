# Check-down showdown equity

Exact check-down showdown equity for a flop, turn, or river. Library, `equity_calculator`, and `equity_tests`. Explorer calls it with strategy-conditioned reaching weights. Does not edit ranges, build a betting tree, or read solver state. Default work limit admits a full-range river and rejects a full-range turn. Not a Pio equity-parity claim.

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

Invalid boards, invalid range syntax, nonfinite or negative weights, cancellation, an exceeded work limit, and a finite input whose derived mass is not a finite double are different errors (`EquityFailure`). A structurally empty legal joint is success. An underflowed or overflowed product is not.

## API

```cpp
poker::holdem::ShowdownEquityOptions options;
options.max_pair_runouts = poker::holdem::kDefaultMaxPairRunouts;
const std::vector<int> board = poker::holdem::parse_equity_board("Kh Kd 7c 4s");
const poker::holdem::Range oop = poker::holdem::parse_equity_range("AhAd,9c9d");
const poker::holdem::Range ip = poker::holdem::parse_equity_range("AhAc:1,2c3d:1e-18");
const poker::holdem::ShowdownEquity equity =
    poker::holdem::showdown_equity(board, oop, ip, options);
```

`measure_showdown_work` counts legal pairs and pair-runouts and does not evaluate showdowns. `showdown_equity_json` writes undefined numbers as null.

The default work limit is `kDefaultMaxPairRunouts` (1,100,000 pair-runouts). A full off-board random-vs-random river is `kFullRangeRiverPairRunouts` (1,070,190) and succeeds at the default. A request above the limit throws before showdown evaluation and reports required and allowed counts. A full-range turn is about 51M pair-runouts (`As Kd Qc Jh` measures 51,369,120) and still rejects. The caller can raise or lower the limit through `ShowdownEquityOptions::max_pair_runouts`, `--max-pair-runouts`, or `POKER_EQUITY_MAX_PAIR_RUNOUTS`. The calculator does not sample or drop runouts. Cancellation uses `ShowdownEquityOptions::cancel_poll`. One deterministic thread performs the enumeration.

## CLI

```sh
equity_calculator --board "Kh Kd 7c 4s" \
  --oop "AhAd,9c9d" --ip "AhAc:1,2c3d:1e-18" \
  --max-pair-runouts 1100000 --json
```

`POKER_EQUITY_MAX_PAIR_RUNOUTS` sets the same ceiling when the flag is omitted. `--max-pair-runouts` wins over the environment variable. Range text is the existing `Range::parse` syntax. Exit 0 prints the result. Exit 1 is invalid input, 2 is an invalid weight, 3 is the work limit, 4 is cancellation, and 5 is a numerical-range failure. Exit 5 writes the diagnostic to stderr and does not print a result.

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

The preflight stores at most 1,326 hand descriptors per player. Showdown evaluation then allocates two 1,326-bin accumulators, about 220 KiB, plus a 49-card stack buffer. There is no all-deals table and no global cache. A rejected limit does not allocate the bins and does not call the evaluator. The unit test measures the full off-board river `As Kd Qc Jh 9c` at 1,070,190 pair-runouts under the default 1,100,000 ceiling, rejects it when the caller sets 1,070,189 or the legacy 1,000,000 ceiling, and rejects a full-range turn at the default before evaluation.

This module does not use `BudgetResource` or the street solver's 1024 MiB engine budget. Its bound is the explicit pair-runout limit plus the fixed buffers above.

## Numerical limits

Enumeration is complete. Pair outcomes use integer win, tie, and loss counts. Compatible mass is the direct sum of compatible opponent input weights, never a blocked-total subtraction and never a scaled mass multiplied back by the range maximum. Reported `input_weight` and `compatible_mass` stay in the original unnormalized units.

Conditional win, tie, loss, and equity normalize each hand by its own largest compatible opponent. That opponent's unit weight is 1, so its fraction is stored unchanged. Dividing every opponent by the heaviest weight in the whole range is not used for those fractions: a blocked `9c2c` at `1e123` would otherwise turn `9c9d`'s only opponent, `AhAc` at `1e-200`, into a subnormal, and the subnormal times `2/44` is a different positive number. On `Kh Kd 7c 4s`, OOP `AhAd,9c9d`, IP `9c2c:1e121,AhAc:1e-200` and the same spot at `1e123`, `9c9d` equity is `2/44`.

Marginals use one scale per player, the largest participating weight. A uniform factor such as `1e-200` or `1e200` cancels in those ratios, so the result matches the unit-weight calculation. There is no absolute cutoff on a small weight: scaling both ranges together does not change the meaning, and a blocker can leave a small hand as the only compatible opponent. That opponent still sets the conditional fraction above.

The supported joint is one whose largest contribution is a normal double. A smaller contribution may be subnormal when a normal contribution is present. If every contribution on a side underflows below the normal range, the relative weights are no longer represented and the input is rejected. On `Kh Kd 7c 4s 2h`, OOP `AhAd:1e123,9c9d:8e-201` against IP `AhAc:1e123,2c3d:1e-200` is that case, as is the swapped assignment. The two surviving products are in a 5:4 ratio, but dividing by the two range maxima makes both contributions subnormal. Keeping that ratio for inputs this far apart is later hardening, not part of the supported domain.

`EquityFailure::InvalidWeight` is only a malformed or nonfinite input weight. `EquityFailure::NumericalRange` (CLI exit 5) means the inputs are finite and at least one legal pair exists, but a scaled weight, the direct compatible mass, or a joint contribution is not a supported finite value. That includes the product of three `1e308` opponent weights, which cannot be stored as one compatible mass, a participating weight that would become zero when divided by its range's largest weight, and a joint whose contributions are all below the normal range. The failure is an error. It does not return `joint_defined: false` or a partial JSON result.

A single opponent weight of `1e308` is representable and is accepted. `long double` is not used to widen the product: on this MSVC toolchain it has the same width as `double`.

Rounding `1 + 1e-18` to `1` is ordinary double-precision behavior. Losing `AhAd`'s only compatible opponent because `AhAc` has weight 1 is a different defect: subtracting the blocked weight from a total that has already rounded `1 + epsilon` to `1` yields zero and drops the hand. This calculator does not do that subtraction. On `Kh Kd 7c 4s`, OOP `AhAd,9c9d`, IP `AhAc:1,2c3d:epsilon`:

| Epsilon | `AhAd` equity | `AhAd` compatible mass | `AhAc` | `AhAc` compatible mass |
| --- | ---: | ---: | --- | ---: |
| `1e-12` | 1 | `9.9999999999999998e-13` | defined | 1 |
| `1e-18` | 1 | `1.0000000000000001e-18` | defined | 1 |

`AhAc` stays in the result because it is compatible with `9c9d`. `2c3d` has compatible mass 2. For `1e-18`, `9c9d`'s own mass prints as 1 because `1 + 1e-18` rounds to 1. For `1e-12`, that mass prints as `1.0000000000010001`.

The oracle in `tests/equity/test_equity.cpp` stores each pair's runout results, then accumulates in descending combo order with `long double`. It shares `compare_showdown` and does not call the production accumulators. Agreement on the small fixtures, including a seeded 5-combo flop, is within `1e-12`. On this MSVC toolchain `long double` is the same width as `double`, so that bound is justified by compensated summation of a few dozen nonnegative terms of size at most 1, not by extra significand bits.

## Tests

`equity_tests` is its own executable and CTest target. It does not use the shared harness. Directory `build-review`, MSVC 19.40.33811.0, Visual Studio 17 2022, Release. Direct total after rejecting an all-subnormal joint: `equity_tests` `passed=845 failed=0`.

The same Release `equity_calculator` reproduces the two review inputs on `Kh Kd 7c 4s 2h`. `AhAd:1e-200` against `2c3d:1e-200` exits 0 with `joint_defined` true, OOP equity 1, IP equity 0, and both marginals 1. Input weights and compatible masses stay at the parsed `1e-200` value (`9.9999999999999998e-201`). Before the correction this request exited 0 with `legal_pairs` 1, `joint_defined` false, null overall equities, and an `AhAd` marginal of 0. `AhAd` against `2c3d:1e308,5c6d:1e308,8c9d:1e308` now exits 5 with `equity numerical range exceeded: compatible mass is not representable` and no JSON. Before the correction it exited 0 with `legal_pairs` 3 and `joint_defined` false. `AhAd` against `AhAc` on that river still exits 0 with `legal_pairs` 0 and `joint_defined` false.

Debug `equity_tests` compiled with `/EHsc /fsanitize=address` and run with `clang_rt.asan_dynamic-x86_64.dll` on `PATH` reported `passed=841 failed=0`. That is the supported sanitizer on this host. `link.exe` warned LNK4300 and ignored `/INCREMENTAL` because of the sanitizer metadata. Passing `/fsanitize=address` only as a link option is ignored by `link.exe` and is not a sanitizer pass. UBSan is not available on this MSVC. The development suite was not run under ASan.

Coverage includes river certainty, a royal-flush tie, 990 and 44 completions, blockers, the `AhAd`/`AhAc`/`2c3d` fixture at `1e-12` and `1e-18`, ordinary rescaling, uniform and one-sided `1e-200` and `1e200` scales compared with the known `AhAd` versus `2c3d` result, one representable `1e308` opponent, the three-weight `1e308` rejection, rejection of the `1e123` / `8e-201` joint whose contributions are all subnormal, in both player orders, a dynamic range that would drop a compatible hand, `9c9d` against a blocked `1e121` or `1e123` opponent with its only live opponent at `1e-200`, a genuine empty joint, a changed hero prior, invalid input, player swap, suit permutation, posterior and equity identities, weighted reconstruction against an unweighted average, work-limit boundaries, deterministic cancellation, unchanged inputs, and seeded sparse ranges.

One earlier direct development-suite run, before this correction, reported `passed=438629 failed=1` at `test_value_worker.cpp:149` (`reader_count() == 0` immediately after resubmitting node A). Resubmitting A is a new request on the current solution, so the worker may borrow before that assertion. An isolated rerun was clean and is not the fix. Equity code does not call that worker, and this commit does not change that test.

## Explorer / study use

Explorer node `/equity` builds two `Range` values from strategy-conditioned reaching weights and calls `showdown_equity` with that node's board. Those weights stay finite and nonnegative and are treated as check-down input weights (not chip EV). The calculator does not read the tree, the average strategy, or the engine budget. The JSON keeps the ten-bucket histogram and adds compact `oop_hands` / `ip_hands` rows (`combo`, check-down `equity`, raw `weight`) so the desktop Study Equity tab can filter histogram bands and inspect pair/suited/offsuit composition. Zero-weight and undefined combos remain omitted from those rows. Ledger status: [FEATURE_PARITY.md](FEATURE_PARITY.md).

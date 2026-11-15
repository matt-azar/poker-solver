# Check-down showdown equity

Exact check-down showdown equity for a flop, turn, or river.

**Shipping on `main`:** Study node equity and the Equity Calculator use Zig host IPC (`equity`, `start_equity_job` / `get_equity_job` / `cancel_equity_job`). C++ `equity_calculator` / `equity_tests` / Explorer `/equity` names below are **historical** — algorithm notes still apply. Not a Pio equity-parity claim.

Does not edit ranges, build a betting tree, or read solver state beyond the requested weights/board. Default work limit admits a full-range river and rejects a full-range turn.

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

## API (historical C++ shape)

The Zig engine exposes equivalent check-down equity over typed IPC / engine modules. The C++ sketch below is retained so older rematch notes stay readable:

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

Pair-showdown constants are in `engine/src/analysis/equity.zig`. `default_max_pair_runouts` is 1,100,000. A full off-board random-vs-random river is 1,070,190 pair-runouts and fits that default. A full-range turn (`As Kd Qc Jh`, 51,369,120 pair-runouts) does not. Study node equity passes `study_explorer_max_pair_runouts` (51,369,120) from the host. `solver-engine` takes `--launch-id` only. Dense flop check-downs can still exceed the Study ceiling and return `error.WorkLimit` before evaluation. The function does not sample or drop runouts. After a solve, warm Study equity uses a separate hand×runout ceiling, `study_warm_max_hand_runouts`. The removed C++ tools took `--max-pair-runouts` and `POKER_EQUITY_MAX_PAIR_RUNOUTS`. Those switches are listed under the historical CLI below.

## Historical CLI (removed)

`equity_calculator` is not built. The command and exit codes below are the old C++ tool. Study equity is the IPC surface in the banner.

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

Pair showdown equity sits outside the `memory_mib` engine budget (`app/src/budget_allocator.zig`). Its bound is the explicit pair-runout limit plus the fixed buffers above.

## Numerical limits

`showdownEquity` uses `f64`. Errors are `InvalidEquity`, `InvalidWeight`, `WorkLimit`, and `OutOfMemory`. Compatible mass is the direct sum of opponent input weights.

The multiway Equity Calculator is `engine/src/analysis/equity_calculator.zig`. It takes 2–6 players, boards of length 0, 3, 4, or 5, dead cards, and methods `auto`, `exact`, and `monte_carlo`. `auto` enumerates exactly when the deal estimate is at or below `auto_exact_threshold` (2,000,000). Exact requests above `default_max_exact_deals` (5,000,000) return `WorkLimit`. `NumericalRange` is a calculator error for a non-finite scaled weight. Per-combo and next-card panes are not mounted. Study calls this through `start_equity_job` / `get_equity_job` / `cancel_equity_job`.

Enumeration in `showdownEquity` is complete. Pair outcomes use integer win, tie, and loss counts. Compatible mass is the direct sum of compatible opponent input weights. Reported `input_weight` and `compatible_mass` stay in the original unnormalized units.

Per combo, `showdownEquity` divides that combo's win, tie, and loss sums by `compatible_mass` (the sum of compatible opponent input weights). Range win, tie, loss, and equity divide by the joint mass (sum of `w0 * w1` over legal pairs). A combo with `compatible_mass <= 0` stays undefined. The function does not rescale by the heaviest weight in the range.

The removed C++ calculator normalized each hand by its largest compatible opponent and rejected an all-subnormal joint (`EquityFailure::NumericalRange`). Those rules are not in `showdownEquity`. The table below is from that C++ review.

The old C++ names were `EquityFailure::InvalidWeight` and `EquityFailure::NumericalRange` (CLI exit 5). On Zig, a bad pair-showdown weight is `InvalidWeight`. The multiway calculator returns `InvalidWeight` or `NumericalRange` when a scaled weight or a finished equity is not a finite `f64`. `showdownEquity` does not implement the old all-subnormal rejection.

A single opponent weight of `1e308` is representable and is accepted. Zig stores these products as `f64`.

Rounding `1 + 1e-18` to `1` is ordinary double-precision behavior. Losing `AhAd`'s only compatible opponent because `AhAc` has weight 1 is a different defect: subtracting the blocked weight from a total that has already rounded `1 + epsilon` to `1` yields zero and drops the hand. This calculator does not do that subtraction. On `Kh Kd 7c 4s`, OOP `AhAd,9c9d`, IP `AhAc:1,2c3d:epsilon`:

| Epsilon | `AhAd` equity | `AhAd` compatible mass | `AhAc` | `AhAc` compatible mass |
| --- | ---: | ---: | --- | ---: |
| `1e-12` | 1 | `9.9999999999999998e-13` | defined | 1 |
| `1e-18` | 1 | `1.0000000000000001e-18` | defined | 1 |

`AhAc` stays in the result because it is compatible with `9c9d`. `2c3d` has compatible mass 2. For `1e-18`, `9c9d`'s own mass prints as 1 because `1 + 1e-18` rounds to 1. For `1e-12`, that mass prints as `1.0000000000010001`.

The old oracle in `tests/equity/test_equity.cpp` is gone. It stored each pair's runout results, then accumulated in descending combo order with `long double`. Agreement on the small fixtures, including a seeded 5-combo flop, was within `1e-12`. On that MSVC toolchain `long double` had the same width as `double`.

## Tests

**Current:** Zig equity rematch / engine tests via `zig build test`; Study node equity + calculator via host IPC contract smoke and desktop Vitest. See [TESTING.md](auxiliary/engineering/TESTING.md).

**Historical (pre-#287 C++):** `equity_tests` was its own CTest target. Directory `build-review`, MSVC 19.40.33811.0, Visual Studio 17 2022, Release. Direct total after rejecting an all-subnormal joint: `equity_tests` `passed=845 failed=0`. The paragraphs below are archaeology from that suite — not current CI coverage.

The same Release `equity_calculator` reproduces the two review inputs on `Kh Kd 7c 4s 2h`. `AhAd:1e-200` against `2c3d:1e-200` exits 0 with `joint_defined` true, OOP equity 1, IP equity 0, and both marginals 1. Input weights and compatible masses stay at the parsed `1e-200` value (`9.9999999999999998e-201`). Before the correction this request exited 0 with `legal_pairs` 1, `joint_defined` false, null overall equities, and an `AhAd` marginal of 0. `AhAd` against `2c3d:1e308,5c6d:1e308,8c9d:1e308` now exits 5 with `equity numerical range exceeded: compatible mass is not representable` and no JSON. Before the correction it exited 0 with `legal_pairs` 3 and `joint_defined` false. `AhAd` against `AhAc` on that river still exits 0 with `legal_pairs` 0 and `joint_defined` false.

Debug `equity_tests` compiled with `/EHsc /fsanitize=address` and run with `clang_rt.asan_dynamic-x86_64.dll` on `PATH` reported `passed=841 failed=0`. That is the supported sanitizer on this host. `link.exe` warned LNK4300 and ignored `/INCREMENTAL` because of the sanitizer metadata. Passing `/fsanitize=address` only as a link option is ignored by `link.exe` and is not a sanitizer pass. UBSan is not available on this MSVC. The development suite was not run under ASan.

Coverage includes river certainty, a royal-flush tie, 990 and 44 completions, blockers, the `AhAd`/`AhAc`/`2c3d` fixture at `1e-12` and `1e-18`, ordinary rescaling, uniform and one-sided `1e-200` and `1e200` scales compared with the known `AhAd` versus `2c3d` result, one representable `1e308` opponent, the three-weight `1e308` rejection, rejection of the `1e123` / `8e-201` joint whose contributions are all subnormal, in both player orders, a dynamic range that would drop a compatible hand, `9c9d` against a blocked `1e121` or `1e123` opponent with its only live opponent at `1e-200`, a genuine empty joint, a changed hero prior, invalid input, player swap, suit permutation, posterior and equity identities, weighted reconstruction against an unweighted average, work-limit boundaries, deterministic cancellation, unchanged inputs, and seeded sparse ranges.

One earlier direct development-suite run, before this correction, reported `passed=438629 failed=1` at `test_value_worker.cpp:149` (`reader_count() == 0` immediately after resubmitting node A). Resubmitting A is a new request on the current solution, so the worker may borrow before that assertion. An isolated rerun was clean and is not the fix. Equity code does not call that worker, and this commit does not change that test.

## Study use

Study node equity uses host IPC `equity` with **reach-weighted** strategy-conditioned masses at the selected node (own actions × card removal), plus showdown rank tables. On a flop it averages one representative per unordered board completion; on a turn or river it uses the node's board. The result is the same check-down fraction as the standalone enumerator on those reaches. The Equity Calculator remains a separate IPC job surface and keeps the pair-runout work limit. The payload keeps the ten-bucket histogram and compact `oop_hands` / `ip_hands` rows (`combo`, check-down `equity`, raw `weight`) so the desktop Study Equity tab can filter histogram bands and plot an OOP vs IP equity distribution chart. Zero-weight and undefined combos remain omitted from those rows. Ledger status: [FEATURE_PARITY.md](auxiliary/planning/FEATURE_PARITY.md).

## Standalone Equity calculator

The desktop **Equity** workspace is independent of any solution. On `main`, packaged Study uses solver-engine IPC ops `start_equity_job` / `get_equity_job` / `cancel_equity_job` (result embedded on completed/stopped status). Legacy HTTP paths (removed on this tree) were:

| Method | Path |
| --- | --- |
| `POST` | `/api/equity/jobs` |
| `GET` | `/api/equity/jobs/{id}` |
| `POST` | `/api/equity/jobs/{id}/cancel` |
| `GET` | `/api/equity/jobs/{id}/result` |

Current entry point: `engine/src/analysis/equity_calculator.zig` (limits in the numerical section above). The removed C++ entry was `poker::holdem::calculate_equity` in `include/poker/equity_calculator.hpp`, with the same player count, board lengths, methods, and deal caps (`kEquityCalculatorAutoExactThreshold` 2,000,000, `max_exact_deals` 5,000,000).

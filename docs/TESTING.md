# Testing

Tests use a small in-repo harness (`tests/harness.hpp`) and CTest. There is no Catch2/GoogleTest dependency.

```sh
cmake --build build
ctest --test-dir build --output-on-failure
```

On Visual Studio multi-config builds, pass `-C Release` (or Debug) to `ctest`.

Build the solver and explorer binaries without compiling tests or benchmarks:

```sh
cmake --build build --config Release --target kuhn_solver --target leduc_solver --target river_solver --target street_solver --target explorer
```

Omit `--config Release` on a single-config generator. A plain `cmake --build build` still compiles the test binary and the benchmark binaries. The benchmarks stay outside CTest.

JavaScript checks, from the repository root:

```sh
node tests/ui/browse.test.js
```

On platforms other than Windows, the HTTP cases print `SKIP explorer HTTP tests: Windows-only in this suite` and the rest of `poker_solver_tests` still runs. CTest has one entry for that binary, so the skip is a log line. [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) builds the production targets, runs this C++ suite, and runs the JavaScript file on Windows and Linux. A second Linux job repeats the C++ suite under AddressSanitizer and UndefinedBehaviorSanitizer. The benchmark executables are not part of that workflow.

## Categories (Phase 2)

**Game correctness** (`tests/unit/test_kuhn.cpp`)

- Six distinct deals; no duplicate cards
- Legal actions and sequence transitions
- Pot and contribution accounting (antes included)
- Terminal utilities: check-check ±1, bet-call ±2, folds ±1
- Zero-sum: \(u_1 + u_2 = 0\) on every terminal of every deal
- Infoset ids depend only on the acting player’s private card and public sequence

**CFR primitives** (`tests/unit/test_cfr.cpp`)

- All-negative regrets → uniform
- Mixed positive regrets → normalized positive regrets
- Reach-weighted average accumulation on a hand-constructed two-action path

**Mathematical validation**

- After 200,000 vanilla CFR iterations and 200,000 CFR+ iterations, both through `CfrTrainer<KuhnGame>`: \(|u_1 + 1/18| \le 10^{-3}\) and Nash gap \(< 10^{-3}\)
- The generalized best response matches a separate enumeration of all 64 pure plans per player
- The generalized utility walk matches the original Kuhn utility walk
- CFR+ regrets stay non-negative; vanilla CFR still records negative regrets
- At 200,000 iterations the CFR+ Nash gap is smaller than the vanilla gap
- A CFR+ run with gap threshold \(10^{-2}\) and eval interval 200 stops before the iteration cap
- Two independent trainers with the same algorithm and iteration count produce identical strategies
- Strategy lies near Kuhn’s equilibrium family (bet King at \(3\alpha\), call Queen at \(\alpha + 1/3\))
- Nash gap after 200,000 vanilla iterations is smaller than after 200 iterations

**Leduc** (`tests/unit/test_leduc.cpp`)

- Six, then five, then four equally likely remaining cards, with dealt cards removed
- An information set is the acting player's card and the public history
- Fold, showdown, pair, and tie utilities
- Every terminal in the default tree is zero-sum and has a consistent pot
- Vanilla CFR and CFR+ both update regrets through `CfrTrainer<LeducGame>`
- CFR+ regrets stay non-negative
- Nash gap after 200 iterations is smaller than after 20, for both algorithms
- Two vanilla runs of 15 iterations match

**Hold'em fundamentals** (`tests/unit/test_holdem.cpp`)

- Card ids 0..51, parse/format including `10h`, deck removal
- Board sizes, duplicate cards, and private hands that use a board card
- Wheel, six-high straight, royal flush, flush, full house, quads, two pair, and kicker order
- Seven-card hands, including a straight that uses both hole cards
- Board-only ties (quads on board, royal on board) and a hole card that wins with ace-high
- All 1,326 combo indexes round-trip, and all 2,598,960 five-card hands are invariant to order
- `AA`, `AKs`, `AKo`, `AK`, `QQ+`, dashed ranges, `random`, weights, and last-assignment-wins
- Dead-card conditioning, ordered joint probabilities, and the uniform masses `1326 * 1225` and `1176 * 1081`
- JSON array of 1,326 weights

**River** (`tests/unit/test_river.cpp`)

- Blocked ranges leave no deals and are rejected
- More than eight actions at one decision is rejected; seven bet sizes plus check is accepted
- All-in sizes are capped at the stack, and disallowed all-ins are omitted
- Two opponent hands that share the actor's hand and the public line share an information set
- Check-down with the nuts is worth exactly half the pot and has Nash gap 0
- A board that neither hand improves is a tie worth 0
- Fold, call, and min-raise accounting, including an uncalled raise
- Weighted deals use the ordered joint distribution
- On the aces-or-fives versus kings toy, 4,000 CFR+ iterations move the value to +25, the bet and call frequencies toward the known mixture, and the Nash gap below the 40-iteration gap
- CFR+ regrets stay non-negative, and a second 40-iteration run matches
- On `AA` versus `KK` and on the all-in toy, the public-tree solver matches the reference strategy to `1e-8` and the value and Nash gap to `1e-6`, for both vanilla CFR and CFR+
- On `22+` versus `22+`, three vanilla iterations match the reference strategy to `1e-8` without running the reference best response; a separate 30-iteration public-tree solve reports its own gap

**Turn and flop** (`tests/unit/test_streets.cpp`)

- A blocked hand is rejected
- Turn check-down matches an independent average over the remaining rivers, and the only strategy has Nash gap 0
- Two opponent hands share the actor's information set on the turn and on a river card neither of them holds; two river cards do not
- A weighted pair of hands uses the joint distribution
- Aces versus `2c3d` on `Kh Kd 7c 4s` win every river and check down for +50
- A turn bet that is called, then a river bet that is folded, loses `pot / 2` plus the folding player's investment
- On that same lock, 400 CFR+ iterations move the value to +50 and the Nash gap below the 20-iteration gap
- Flop check-down matches the average over every turn and river
- A geometric size on the turn is the equal-fraction split of the stack, and the same size on the river is the rest of the stack
- A turn size and a river size can differ, and two river cards offer the same actions
- A bet that commits more than the all-in threshold becomes all-in, and a bet under the threshold stays as listed
- A fixed chip size bets that many chips, a 3x raise raises to three times the bet, a pot cap of 1 cuts a larger size to the pot, and turning off the 3-bet leaves only fold and call after a raise
- OOP uses the donk size after IP bets and OOP calls, and uses the normal bet size when the previous street checks through
- A `street-config 1` document round-trips to the same text and rebuilds the same turn tree. Field order in the file does not matter. Version 2, a missing newline, a duplicate field, `3x` on a bet list, and `0c` are rejected. A two-card board parses and then fails in `StreetGame`
- Two sizes that round to 50 chips are one bet. After a bet of 50, a raise increment of 20 is omitted and a raise of 200 remains. With 30 chips left above a call, all-in is offered below the minimum raise, and turning all-ins off leaves only fold and call
- The public turn and flop tree matches `StreetGame` action by action: check-down, a shared turn infoset with two hands, a different river size, and a geometric size. The largest strategy difference in those tests was 0
- Continuing a fresh public street solver for 4 iterations matches one that was reset and run for those same 4 iterations
- The frozen combo pass matches check-down equity on the turn and on the flop. On the nuts-versus-air turn lock, 400 CFR+ iterations reach a value within 1 chip of +50 and a smaller Nash gap than 20 iterations
- The budget resource accepts an allocation that fills its limit, refuses one byte past that limit, counts an old block and a new block together, returns to zero after deallocation, and rolls the charge back when the upstream allocator throws
- A zero memory budget is rejected. A 1 MiB budget rejects a `77+` versus `77+` check-down flop and names the budget, the current allocation, and the denied request. A later solve with a sufficient budget still runs
- The same 1 MiB budget rejects the branching flop `Ah Kd 7c`, pot 100, stack 10000, `QcQd` versus `JcJd`, bet sizes 0.25/0.5/1, raise sizes 0.5/1, all-in, max raises 3. An independent allocation observer records a peak at or below 1,048,576 bytes and a live total of zero after the exception
- Two sufficient budgets on the `77+` flop produce the same value and the same Nash gap. The report's scratch and rank-cache components are live allocations, reservation credit is zero, and one training pass does not change the live total. The peak is larger than the regret-plus-strategy-sum figure
- A finished solve's live bytes match that independent observer, including a turn tree whose action paths are longer than a check-down
- A weighted turn and a blocker turn match the existing closed form or `StreetGame` strategy check
- Expanded terminal and decision counts on that flop are 64-bit products of the deal count and the runout count
- Continuing a fresh public-tree solver for 40 iterations matches a solver that was reset and run for those same 40 iterations

`street_memory_bench` repeats the uniform full-range check-down on the turn and the flop and checks the centered value. It runs outside CTest and has no wall-time limit. `street_betting_bench` continues one frozen CFR+ solve through the checkpoints in [BENCHMARKS.md](BENCHMARKS.md) and is also outside CTest. Each case stops after ten minutes of wall time. `street_parallel_bench` times 1, 2, 4, and 8 frozen threads on those two betting trees and is outside CTest as well.

The street tests also compare one, two, four, and 64 frozen threads on small turn and flop trees. The raw regret and strategy-sum tables match, including a weighted range, a tied board, a shared card, a vanilla pass, a delayed card order, and a solve continued in pieces. One player's pass leaves the other player's regrets unchanged. A worker exception joins the batch and then refuses another pass or an evaluation. A thread count of 0 is rejected. More than one thread on the per-deal walk is rejected. A 64-thread request that does not fit the measured budget throws, releases the charge, and a one-thread solve of that budget still runs. The first frozen pass and the next one do not allocate. On the two betting trees in [BENCHMARKS.md](BENCHMARKS.md), two, four, and eight threads matched the one-thread raw tables at iterations 3, 30, and 100. ThreadSanitizer was not run. WSL g++ 11.4.0 is available, and the build was skipped because the machine was on battery. The card-delay stress is a Windows test.

An independent review of `e2ad8df` reported GCC 13.3.0 Release at 337,238 assertions and 0 failures. The Windows suite has one more assertion. That review's `street_memory_bench` reproduced the full-range check-down values, with engine heap 60,888,693 bytes on the turn and 418,369,763 bytes on the flop. A focused ThreadSanitizer run, GCC with `-O1 -g -fsanitize=thread -fno-omit-frame-pointer -pthread` on the core sources and `test_streets.cpp`, called `run_street_workspace_tests` and `run_street_parallel_tests` under `TSAN_OPTIONS=halt_on_error=1`. It passed 2,443 assertions with no race reports. That run covers those tests.

An independent review of `29cf58f` reported GCC 13.3.0 Release at 337,820 assertions and 0 failures. The Windows suite after the compact kernel was 337,821 assertions and 0 failures. The same review's focused ThreadSanitizer build used those flags on the core sources and `test_streets.cpp`, and the test called `run_street_workspace_tests`, `run_street_parallel_tests`, and `run_street_showdown_tests`. It passed 3,025 assertions with no race reports. That run covers those street tests. Linux engine heap on the full-range check-down was 62,647,533 and 81,082,053 bytes on the turn at one and four threads, and 531,364,379 and 550,581,875 bytes on the flop. The Windows heaps and the reset-30 comparison are in [BENCHMARKS.md](BENCHMARKS.md). Bit-exact agreement with the `e2ad8df` pins holds through iteration 300 on both betting trees at one and four threads.

The Windows suite after the chance-page and frequency pass is 364,982 assertions and 0 failures. That count includes the session state machine, a local explorer process on port 18765, and the chance-page oracle. An independent review of `70ccabc` reported GCC 13.3.0 Release at 346,787 assertions and 0 failures, and a focused ThreadSanitizer run at 11,992 assertions with no race reports. That sanitizer run covered the core sources and `test_streets.cpp`, including inspection. It did not cover the HTTP session. A later attempt to run the session state machine under WSL g++ 11.4.0 with `-fsanitize=thread` aborted before the test with `unexpected memory mapping`. The session tests passed in the Windows suite.

The session tests drive stop and publication with gates. A stop before construction, during a chunk, and after the chunk but before publication publishes nothing. A stop after `commit_success` returns already complete and the solution stays borrowable. A stop for the finished job does not set the stop flag on its replacement. A failed constructor or publication leaves the job failed, and `borrow` returns nothing. A replacement waits out a held reader, and a weak pointer to the old resource is expired at the release hook before the next construction flag is set.

The HTTP test launches `explorer.exe --port 18765` and stops that process handle when the test ends. On `Kh Kd 7c 4s 2h`, `AhAd` versus `2c3d`, pot 100, empty bet arrays, all-in off, three river iterations, status and export both report iterations 3 and value 50. The same agreement holds for a one-iteration frozen turn of that matchup. `s18446744073709551617`, `s1x`, and `s+1` return 400. `s2` while `s1` is current returns 404. Stopping the finished river job returns `complete` and the export remains. A node id with an overflowing index returns 400. Leading zeros in `p00.t-1.r-1` select the root.

Chance weights on a weighted flop and a weighted turn match an independent pair-and-card enumeration and sum to 1 over the undealt cards. A hand that always holds a card gives that card weight 0. A joint reach of 1e-18 still defines the marginals and the card weights. Forcing OOP to keep only AdAc and IP to keep only AcKh leaves both of those reaches positive and the child joint at 0, with null card weights. Inspecting the root, an action child, and a chance node does not change the regret table or the strategy-sum table.

`node tests/ui/browse.test.js` checks the group frequencies and the stale-response guard. One hand with Check 0.20, Bet 50 0.30, and Bet 100 0.50 reports total aggression 0.80. A slower JSON body that belongs to an older selection is not applied, including an error body. An older status generation is ignored. Two equally weighted suited broadway combos, one always taking action A and the other always taking action B, each with mixed EV 10, have group mixed EV 10. The same group's forced-action values are 5 and 5. A group whose marginals are zero has a null aggregate.

The Windows suite after conditional action EV is 408,504 assertions and 0 failures. That count includes the publication tests, the action-value oracle, and the values HTTP cases. Publication builds the status string before it stores a terminal phase. A throw on the accepted path and on the cancelled path leaves the job running, and the following failure record publishes nothing. The action-value tests cover the turn bluff, an in-position sign change, scale invariance, a zero hero reach with a defined continuation, a zero opponent denominator, blockers, a tie, a flop, and a later-street decision. A chance node is rejected. Regret, strategy sum, average strategy, iteration count, and evaluation time are unchanged by a query. The HTTP case is the one-iteration frozen check-down of `AhAd` versus `2c3d` on `Kh Kd 7c 4s`. The root value is 50. A second read returns the same body. Status and export are byte-for-byte unchanged, and the export has no action values. A chance node returns 400. A river solve returns 400. The replaced solution returns 404.

The profile cache follows mutations. On the turn bluff board `Kh Kd 7c 4s`, pot 100, stack 100, OOP `KcKs,2c3d`, IP `AhAd`, OOP turn bet `{1.0}`, all-in off, one raise, one frozen iteration reports node EV 12.5. Continuing 29 iterations after an intervening inspect, expected utility, average-strategy read, inspection prepare, or profile-epoch read used to return that same 12.5 page with `query_seconds` 0. A fresh 30-iteration solver reports 24.987324159506588. After the fix the continued solver matches the fresh one. `p00.t-1.r-1` is a cache hit for the root. `run`, `continue`, `solve`, a frozen reset to a different iteration count, and an explicit average edit each invalidate the page. A cancelled walk, a chance-node rejection, and an injected allocation failure leave the previous page unpublished.

Tiny compatible mass is summed directly when subtracting the blocked mass would cancel it. Before that change, IP `AhAc:1,2c3d:1e-12` made OOP `AhAd` check 49.995555366013498, and `1e-18` left the value undefined. Both are now defined at +50 within 1e-9, and the street oracle agrees. Swapping the ranges makes IP `AhAc` check +50. A blocked opponent that would have won (`AhKc` plus a tiny `2c3d`) does not leak into that +50. `9c9d` against `9c2c:1,AhAc:1e-18` stays the river-aware equity near −45.4545, between −50 and −40, rather than a leaked win. A true zero compatible opponent stays undefined. Rescaling the opponent and changing the hero prior leave the conditional value unchanged. Flop chance weights stay finite and sum to 1. A later decision with zero hero reach stays defined. Well-conditioned ranges stay on the subtraction path. The node value matches `expected_utility()`.

The value worker is the object under test, not only `action_values`. A newer node supersedes a paused walk and the paused result is not published. Replacing the solution while a walk holds the reader destroys the old engine before the next one is constructed, and the reader count returns to zero. An evaluation exception is returned, and the next node succeeds. Idle shutdown, a second shutdown, and shutdown during an active query with another request pending leave no live worker and no reader. Destroying a worker that has started its thread joins it.

A published solution can take more iterations without a new solution id. The session test holds a reader across the claim, then publishes the same resource after a stop. A mismatched job does not commit, and aborting the continuation leaves the solution borrowable. The HTTP case continues the one-iteration frozen turn of `AhAd` versus `2c3d` by one iteration. The solution id stays, the iteration count becomes 2, and the value stays 50. Zero iterations is 400. An unknown solution is 404. A stop on a new solve still publishes nothing. The Windows suite after these checks is 438,696 assertions and 0 failures. The MSVC test binary reserves an 8 MiB stack; a fresh compile of the street fixtures overflowed the 1 MiB default.

This Windows run did not use ThreadSanitizer or AddressSanitizer. MSVC does not provide ThreadSanitizer. A focused WSL g++ 11.4.0 ThreadSanitizer build of the value-worker tests, with `-O1 -g -fsanitize=thread -fno-omit-frame-pointer -pthread`, aborted at startup with `unexpected memory mapping` before any assertion ran. The value-worker tests were not executed under a sanitizer here. No 300-iteration campaign was run. The pinned engine heaps above were not remeasured; the epoch, the retained page, and the HTTP body remain outside the engine object.

One frozen iteration, pot 100, stack 100, bet 0.5, all-in, one raise, 1024 MiB, one thread. On the full-range turn `Ah Kd 7c 4s` the root conditional values took 0.1227594 seconds and the repeat took 0. The values JSON, with solution `s1`, job `j1`, and status generation 1, was 80,322 bytes. The root value was 15.1234567901, matching the stored EV, and the Nash gap was 81.2343664183. Engine allocated and peak stayed 143,384,982 bytes. Process RSS was 149,512,192 before the query and 150,056,960 after. The first river decision, `p3.t-1.r0`, took 0.0016188 seconds and was 77,848 bytes; the repeat took 0. On the paired flop `Ah Kd 7c`, `QQ,JJ,TT,99` versus the same range, the root took 0.3370098 seconds and the repeat took 0. That same JSON shape was 2,042 bytes. The value was 16.2637174211 and the Nash gap was 89.2478513202. Engine allocated and peak stayed 176,211,150 bytes. Process RSS was 183,361,536 before the query and 183,365,632 after. The first turn decision, `p3.t0.r-1`, took 0.0035858 seconds and was 2,053 bytes; the repeat took 0. Evaluation seconds were unchanged on both trees. The retained page and its profile epoch sit outside the engine budget. These are measurements from that run. The timing tables in [BENCHMARKS.md](BENCHMARKS.md) stay as recorded.

This Windows run did not use ThreadSanitizer or AddressSanitizer. MSVC does not provide ThreadSanitizer. The earlier WSL g++ 11.4.0 ThreadSanitizer attempt aborted at startup with `unexpected memory mapping`, so the new evaluator, its scratch lock, and the publication fix were not run under a sanitizer here. The Windows Release suite covers those paths.

One frozen iteration, pot 100, stack 100, bet 0.5, all-in, one raise, 1024 MiB, one thread. The full-range turn `Ah Kd 7c 4s` returned a status of 827 bytes, value 15.1234567901, Nash gap 81.2343664183, engine allocated and peak 143,384,982 bytes, process RSS 184,279,040. The root page was 86,174 bytes in 0.0282 seconds, the first action 86,174 bytes in 0.0136 seconds, and the chance page 3,404 bytes in 0.0018 seconds with 48 cards whose weights sum to 1. The paired flop `Ah Kd 7c`, `QQ,JJ,TT,99` versus the same range, returned a status of 831 bytes, value 16.2637174211, Nash gap 89.2478513202, engine allocated and peak 176,211,150 bytes, process RSS 184,565,760. Its root was 2,214 bytes in 0.0057 seconds, the first action 2,214 bytes in 0.0036 seconds, and the chance page 3,468 bytes in 0.0033 seconds with 49 cards whose weights sum to 1. A follow-up read of that flop chance page reported query 0.0000243 seconds and serialization 0.0000676 seconds. These are measurements from that run. The earlier full-range kernel heaps in [BENCHMARKS.md](BENCHMARKS.md) stay as recorded.

The explorer page at `http://127.0.0.1:8765` solved that paired flop for one frozen iteration. The root frequency menu listed Bet or raise, Check, Bet 50, and Bet 100 all-in. Bet 50 opened the IP node, whose menu listed Fold and Call. Selecting Fold showed `6 combos, Fold 0.500`. The turn card `2c` was labeled with weight 0.022 and opened the turn decision.

**Linear CFR** (`tests/unit/test_cfr.cpp`)

- 2,000 iterations on Kuhn are deterministic
- The average strategy differs from vanilla CFR at the same iteration count
- At least one cumulative regret is negative
- The player-1 value is within 0.01 of `-1/18`, and the Nash gap is below 0.05

The default Leduc tree has 936 decision information sets. Solver reports include iteration count, runtime, memory, player-0 value, Nash gap, and the information-set count.

Payoff accounting and exact best response are tested separately from the Nash gap.

## CLI smoke

```sh
kuhn_solver --iterations 1000 --print-strategies
```

Should print a Nash gap and a player-1 value. At 1,000 iterations the gap is still wide.

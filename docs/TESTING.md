# Testing

Tests use a small in-repo harness (`tests/harness.hpp`) and CTest. There is no Catch2/GoogleTest dependency.

```sh
cmake --build build
ctest --test-dir build --output-on-failure
```

On Visual Studio multi-config builds, pass `-C Release` (or Debug) to `ctest`.

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
- Reach-weighted average accumulation on a hand-constructed two-action path (not Kuhn equilibrium tables)

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
- An information set depends on the acting player's card and the public history, not the opponent's card
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
- A weighted pair of hands uses the joint distribution, not an equal average of the two deals
- Aces versus `2c3d` on `Kh Kd 7c 4s` win every river and check down for +50
- A turn bet that is called, then a river bet that is folded, loses `pot / 2` plus the folding player's investment
- On that same lock, 400 CFR+ iterations move the value to +50 and the Nash gap below the 20-iteration gap
- Flop check-down matches the average over every turn and river
- A geometric size on the turn is the equal-fraction split of the stack, and the same size on the river is the rest of the stack
- A turn size and a river size can differ, and two river cards offer the same actions
- A bet that commits more than the all-in threshold becomes all-in, and a bet under the threshold stays as listed
- A fixed chip size bets that many chips, a 3x raise raises to three times the bet, a pot cap of 1 cuts a larger size to the pot, and turning off the 3-bet leaves only fold and call after a raise
- OOP uses the donk size after IP bets and OOP calls, and uses the normal bet size when the previous street checks through
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

`street_memory_bench` repeats the uniform full-range check-down on the turn and the flop and checks the centered value. It is not a CTest test and it has no wall-time limit. `street_betting_bench` continues one frozen CFR+ solve through the checkpoints in [BENCHMARKS.md](BENCHMARKS.md) and is also outside CTest. Each case stops after ten minutes of wall time. `street_parallel_bench` times 1, 2, 4, and 8 frozen threads on those two betting trees and is outside CTest as well.

The street tests also compare one, two, four, and 64 frozen threads on small turn and flop trees. The raw regret and strategy-sum tables match, including a weighted range, a tied board, a shared card, a vanilla pass, a delayed card order, and a solve continued in pieces. One player's pass leaves the other player's regrets unchanged. A worker exception joins the batch and then refuses another pass or an evaluation. A thread count of 0 is rejected. More than one thread on the per-deal walk is rejected. A 64-thread request that does not fit the measured budget throws, releases the charge, and a one-thread solve of that budget still runs. The first frozen pass and the next one do not allocate. On the two betting trees in [BENCHMARKS.md](BENCHMARKS.md), two, four, and eight threads matched the one-thread raw tables at iterations 3, 30, and 100. ThreadSanitizer was not run. WSL g++ 11.4.0 is available, and the build was skipped because the machine was on battery. The card-delay stress is a Windows test, not a sanitizer run.

An independent review of `e2ad8df` reported GCC 13.3.0 Release at 337,238 assertions and 0 failures. The Windows suite has one more assertion. That review's `street_memory_bench` reproduced the full-range check-down values, with engine heap 60,888,693 bytes on the turn and 418,369,763 bytes on the flop. A focused ThreadSanitizer run, GCC with `-O1 -g -fsanitize=thread -fno-omit-frame-pointer -pthread` on the core sources and `test_streets.cpp`, called `run_street_workspace_tests` and `run_street_parallel_tests` under `TSAN_OPTIONS=halt_on_error=1`. It passed 2,443 assertions with no race reports. That covers those tests, not every workload.

An independent review of `29cf58f` reported GCC 13.3.0 Release at 337,820 assertions and 0 failures. The Windows suite after the compact kernel was 337,821 assertions and 0 failures. The same review's focused ThreadSanitizer build used those flags on the core sources and `test_streets.cpp`, and the test called `run_street_workspace_tests`, `run_street_parallel_tests`, and `run_street_showdown_tests`. It passed 3,025 assertions with no race reports. That is still those street tests, not the whole suite. Linux engine heap on the full-range check-down was 62,647,533 and 81,082,053 bytes on the turn at one and four threads, and 531,364,379 and 550,581,875 bytes on the flop. The Windows heaps and the reset-30 comparison are in [BENCHMARKS.md](BENCHMARKS.md). Bit-exact agreement with the `e2ad8df` pins holds through iteration 300 on both betting trees at one and four threads.

The explorer is not part of `poker_solver_tests`. It was checked in the browser at `http://127.0.0.1:8765`. Painting queens onto aces wrote `AA,QQ` and counted 9 live combos on the default river board. A check-only flop, `Ah Kd 7c` with `QcQd` versus `JcJd`, finished at value 41.6161616162 and Nash gap 0, and the history listed flop, turn, and river lines from that one solve.

**Linear CFR** (`tests/unit/test_cfr.cpp`)

- 2,000 iterations on Kuhn are deterministic
- The average strategy is not the vanilla strategy at the same iteration count
- At least one cumulative regret is negative
- The player-1 value is within 0.01 of `-1/18`, and the Nash gap is below 0.05

The default Leduc tree has 936 decision information sets. Solver reports include iteration count, runtime, memory, player-0 value, Nash gap, and the information-set count.

Convergence is never treated as sufficient by itself: payoff accounting and exact best response are tested separately.

## CLI smoke

```sh
kuhn_solver --iterations 1000 --print-strategies
```

Should print a Nash gap and a player-1 value; it will not yet be tightly converged at 1,000 iterations.

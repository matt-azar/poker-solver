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
- Continuing a fresh public-tree solver for 40 iterations matches a solver that was reset and run for those same 40 iterations

The river explorer is not part of `poker_solver_tests`. It was checked by opening `http://127.0.0.1:8765`, solving the default aces-versus-kings river, and reading the value, the ace-combo mixes, and a later betting line.

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

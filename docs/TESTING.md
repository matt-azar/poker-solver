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

The default Leduc tree has 936 decision information sets. Solver reports include iteration count, runtime, memory, player-0 value, Nash gap, and the information-set count.

Convergence is never treated as sufficient by itself: payoff accounting and exact best response are tested separately.

## CLI smoke

```sh
kuhn_solver --iterations 1000 --print-strategies
```

Should print a Nash gap and a player-1 value; it will not yet be tightly converged at 1,000 iterations.

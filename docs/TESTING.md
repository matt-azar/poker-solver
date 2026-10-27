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

Each solver test prints iteration count, runtime, memory estimate, player-1 value, Nash gap, and the average strategy.

Convergence is never treated as sufficient by itself: payoff accounting and exact best response are tested separately.

## CLI smoke

```sh
kuhn_solver --iterations 1000 --print-strategies
```

Should print a Nash gap and a player-1 value; it will not yet be tightly converged at 1,000 iterations.

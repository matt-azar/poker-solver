# poker-solver

Heads-up no-limit Texas Hold'em GTO solver under incremental development. The core is C++20. Python bindings and a graphical explorer are planned later; they are not required to build or run the solver.

**Current milestone:** Phase 5 — 52-card deck, seven-card evaluator, and 1,326-hand ranges. See [docs/HOLDEM.md](docs/HOLDEM.md).

This repository does **not** yet solve a Hold'em betting tree. Convergence on Kuhn Poker is exact-game equilibrium for that toy game, not unrestricted no-limit Hold'em.

## Requirements

- CMake 3.16 or newer
- A C++20 compiler:
  - Windows: Visual Studio 2019+ (MSVC) or MinGW-w64 GCC
  - Linux / WSL2: GCC 10+ or Clang 11+

No Python, pybind11, or other third-party libraries are required for the current C++ solver.

## Build (Windows, Visual Studio)

From a Developer Command Prompt or PowerShell with `cmake` and MSVC on `PATH`:

```bat
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
ctest --test-dir build -C Release --output-on-failure
```

The CLIs are `build\Release\kuhn_solver.exe` and `build\Release\leduc_solver.exe` (multi-config generators), or the same names without the `Release` directory for single-config generators.

## Build (Windows MinGW or WSL2 / Linux)

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
ctest --test-dir build --output-on-failure
```

Debug:

```sh
cmake -S . -B build-debug -DCMAKE_BUILD_TYPE=Debug
cmake --build build-debug
```

## Run

```sh
kuhn_solver --iterations 200000 --algorithm cfr_plus --print-strategies
leduc_solver --iterations 1000 --algorithm cfr_plus
leduc_solver --iterations 1000 --max-raises 2 --max-raises-round2 2
```

Kuhn chance is the six equally likely deals. Leduc chance deals two private cards and, if the hand continues, one board card. Neither solver uses an RNG. Rules and chip sizes for Leduc are in [docs/LEDUC.md](docs/LEDUC.md).

For Kuhn, the expected value of the first player approaches `-1/18`. The reported **Nash gap** is NashConv `u1(BR1, σ2) + u2(σ1, BR2)`. That is not NashConv/2. Leduc has no closed form in this repository; the tests check that its Nash gap falls.

Example flags: [`configs/kuhn_default.json`](configs/kuhn_default.json), [`configs/leduc_default.json`](configs/leduc_default.json).

## Layout

```text
include/game/     Kuhn and Leduc rules
include/solver/   CFR, CFR+, regret matching, best response
include/poker/    Hold'em cards, hand evaluator, 1,326-hand ranges
src/              Implementations and the kuhn_solver / leduc_solver CLIs
tests/            In-repo harness + CTest
docs/             Architecture, mathematics, testing, roadmap
```

Directories `python/` and `ui/` are placeholders for later phases.

## Documentation

- [docs/HOLDEM.md](docs/HOLDEM.md)
- [docs/LEDUC.md](docs/LEDUC.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/MATHEMATICS.md](docs/MATHEMATICS.md)
- [docs/TESTING.md](docs/TESTING.md)
- [docs/BENCHMARKS.md](docs/BENCHMARKS.md)
- [docs/ROADMAP.md](docs/ROADMAP.md)

## License

MIT. See [LICENSE](LICENSE).

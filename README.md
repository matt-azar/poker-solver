# poker-solver

Heads-up no-limit Texas Hold'em GTO solver under incremental development. The core is C++20. Python bindings and a graphical explorer are planned later; they are not required to build or run the solver.

**Current milestone:** Phase 2 — Kuhn Poker with vanilla CFR.

This repository does **not** yet solve Texas Hold'em. Convergence on Kuhn Poker is exact-game equilibrium for that toy game, not unrestricted no-limit Hold'em.

## Requirements

- CMake 3.16 or newer
- A C++20 compiler:
  - Windows: Visual Studio 2019+ (MSVC) or MinGW-w64 GCC
  - Linux / WSL2: GCC 10+ or Clang 11+

No Python, pybind11, or other third-party libraries are required for Phase 1–2.

## Build (Windows, Visual Studio)

From a Developer Command Prompt or PowerShell with `cmake` and MSVC on `PATH`:

```bat
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
ctest --test-dir build -C Release --output-on-failure
```

The CLI is `build\Release\kuhn_solver.exe` (multi-config generators) or `build\kuhn_solver.exe` (single-config).

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

## Run Kuhn solver

```sh
kuhn_solver --iterations 100000 --print-strategies
kuhn_solver --iterations 100000 --json kuhn_result.json
```

Chance is fully enumerated (six equally likely deals). There is no RNG; results are deterministic for a given iteration count and traversal order.

Expected player-1 value of the average strategy approaches `-1/18`. The reported **Nash gap** is NashConv `u1(BR1, σ2) + u2(σ1, BR2)`, which should decrease toward 0. That is not the same as NashConv/2 (sometimes called exploitability).

Example CLI flags are also recorded in [`configs/kuhn_default.json`](configs/kuhn_default.json).

## Layout

```text
include/game/     Kuhn game rules and infosets
include/solver/   Vanilla CFR, regret matching, best response
src/              Matching implementation and kuhn_solver CLI
tests/            In-repo harness + CTest
docs/             Architecture, mathematics, testing, roadmap
```

Directories `include/poker`, `python/`, and `ui/` are placeholders for later phases.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/MATHEMATICS.md](docs/MATHEMATICS.md)
- [docs/TESTING.md](docs/TESTING.md)
- [docs/BENCHMARKS.md](docs/BENCHMARKS.md)
- [docs/ROADMAP.md](docs/ROADMAP.md)

## License

MIT. See [LICENSE](LICENSE).

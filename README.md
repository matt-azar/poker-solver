# poker-solver

Heads-up no-limit Texas Hold'em GTO solver under incremental development. The core is C++20. Python bindings are planned later and are not required to build or run the solver. A local explorer is included.

**Current milestone:** The kernel through the old Phase 10 is the foundation. The active plan is Release A, a dependable postflop study tool. The next implementation milestone is M0, then the already specified conditional-action-EV work. See [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/HUNL.md](docs/HUNL.md).

Convergence on Kuhn, Leduc, or a fixed-size river tree is an equilibrium of that abstract game.

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

The CLIs are `build\Release\kuhn_solver.exe`, `build\Release\leduc_solver.exe`, `build\Release\river_solver.exe`, `build\Release\street_solver.exe`, and `build\Release\explorer.exe` (multi-config generators), or the same names without the `Release` directory for single-config generators.

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
river_solver --config configs/river_default.json
river_solver --iterations 2000 --algorithm cfr_plus
street_solver
street_solver --config configs/street_default.txt
street_solver --board Ah,Kd,7c --oop-range QcQd --ip-range JcJd --no-all-in --max-raises 0 --iterations 1
street_solver --board Ah,Kd,7c --oop-range random --ip-range random --no-all-in --max-raises 0 --iterations 1 --frozen --memory-mib 1024
explorer
```

`explorer` listens on `http://127.0.0.1:8765`. Solve, then use Save and Open on a `.psol` file to close the process and resume the same regrets and strategy sums. On a chance node, Compare runouts lists every legal next card. Check-down equity is a fraction of the pot and is separate from chip EV. `equity_calculator` is the standalone enumerator; its default work limit can reject a full-range river.

Kuhn chance is the six equally likely deals. Leduc chance deals two private cards and, if the hand continues, one board card. The river solver deals private hands from the two ranges on a fixed board. The street solver does that on a turn or a flop and then deals the missing board cards. `street_solver` uses one public betting tree; `--reference` walks `StreetGame` instead. `--memory-mib` sets the street solver's allocation budget in mebibytes. The default is 1024. That budget counts bytes the solver requests from its allocator. `--threads N` sets the frozen-pass thread count, including the caller. The default is 1, and a count above 1 requires `--frozen`. None of the solvers uses an RNG. Rules are in [docs/LEDUC.md](docs/LEDUC.md), [docs/RIVER.md](docs/RIVER.md), and [docs/STREETS.md](docs/STREETS.md).

For Kuhn, the expected value of the first player approaches `-1/18`. The reported **Nash gap** is NashConv `u1(BR1, σ2) + u2(σ1, BR2)`. Leduc has no closed form in this repository; the tests check that its Nash gap falls.

Example flags: [`configs/kuhn_default.json`](configs/kuhn_default.json), [`configs/leduc_default.json`](configs/leduc_default.json), [`configs/river_default.json`](configs/river_default.json), [`configs/street_default.txt`](configs/street_default.txt).

## Layout

```text
include/game/     Kuhn, Leduc, the river, and turn/flop trees
include/solver/   CFR, CFR+, regret matching, best response, public river tree
include/poker/    Hold'em cards, hand evaluator, 1,326-hand ranges
src/              Implementations and the CLIs
tests/            In-repo harness + CTest
docs/             Architecture, mathematics, testing, roadmap
```

The `python/` directory is reserved for a later binding. `ui/` is the local explorer: a flop or a turn is one tree through the river, and ranges are painted on a 13×13 grid.

## Documentation

- [docs/HUNL.md](docs/HUNL.md)
- [docs/EXPLORER.md](docs/EXPLORER.md)
- [docs/STREETS.md](docs/STREETS.md)
- [docs/RIVER.md](docs/RIVER.md)
- [docs/HOLDEM.md](docs/HOLDEM.md)
- [docs/LEDUC.md](docs/LEDUC.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/MATHEMATICS.md](docs/MATHEMATICS.md)
- [docs/TESTING.md](docs/TESTING.md)
- [docs/BENCHMARKS.md](docs/BENCHMARKS.md)
- [docs/ROADMAP.md](docs/ROADMAP.md)
- [docs/FEATURE_PARITY.md](docs/FEATURE_PARITY.md)

## License

This project is under development. No public license is currently granted for this version. See [LICENSE](LICENSE).

Earlier commits remain in the Git history with the license text they were written with.

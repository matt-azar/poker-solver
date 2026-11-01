# poker-solver

Heads-up no-limit Texas Hold'em GTO solver (C++20) with a local Study workstation.

**Product surface:** postflop study through `explorer` and the React Study UI (`desktop/`) — solve, browse, lock, compare, save/reopen, and analyze. A Windows NSIS installer wraps that stack. Details: [docs/DESKTOP_UI.md](docs/DESKTOP_UI.md), [docs/EXPLORER.md](docs/EXPLORER.md), [docs/ROADMAP.md](docs/ROADMAP.md).

Flop, turn, and river share one public betting tree (`StreetBatchSolver`). Convergence is an equilibrium of the configured bet-size tree.

## Windows installer

Download the unsigned NSIS setup from the latest Windows release:

**[Holdem Study 0.1.0 (Windows)](https://github.com/matt-azar/poker-solver/releases/tag/v0.1.0-windows)** → `Holdem-Study-0.1.0-x64-setup.exe`

1. Run the setup (current-user install; WebView2 may bootstrap)
2. Launch **Holdem Study** from the Start menu

Windows SmartScreen may warn because the binary is not code-signed — **More info → Run anyway**.

The installer places `holdem-explorer.exe` next to the UI, unblocks both binaries, and fails if the engine is missing. On launch the shell starts that sidecar on `127.0.0.1:8765` and waits until it accepts connections before the Study UI connects. No CMake or npm required.

Maintainers rebuild via Actions → **Windows Installer**. Packaging notes: [docs/DESKTOP_UI.md](docs/DESKTOP_UI.md#desktop-packaging).

## Study UI (developers)

```sh
# terminal 1 — after building explorer (see Build below)
./build/explorer --port 8765          # Windows: build\Release\explorer.exe --port 8765

# terminal 2
cd desktop && npm install && npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` to the explorer.

Production static serve (no Vite):

```sh
cd desktop && npm run build
./build/explorer --port 8765          # prefers desktop/dist when present
```

Then open `http://127.0.0.1:8765`.

## Requirements

- CMake 3.16+
- C++20 compiler: Visual Studio 2019+ (MSVC) or MinGW-w64 GCC on Windows; GCC 10+ or Clang 11+ on Linux / WSL2
- Node 22+ only for `desktop/` development or packaging

No Python or third-party C++ libraries are required for the solver.

## Build

Windows (Visual Studio):

```bat
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
ctest --test-dir build -C Release --output-on-failure
```

Use `"Visual Studio 16 2019"` if needed. Prefer `--config Release` with the VS generator.

Linux / WSL2 / MinGW:

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

Production CLIs (multi-config): `build\Release\street_solver.exe`, `build\Release\river_solver.exe`, `build\Release\explorer.exe`, `build\Release\equity_calculator.exe`. Single-config builds omit the `Release` directory. Reference-game CLIs `kuhn_solver` and `leduc_solver` are also built; see [docs/LEDUC.md](docs/LEDUC.md).

## Run

```sh
street_solver
street_solver --config configs/street_default.txt
street_solver --board Ah,Kd,7c --oop-range QcQd --ip-range JcJd --no-all-in --max-raises 0 --iterations 1
street_solver --board Ah,Kd,7c --oop-range random --ip-range random --no-all-in --max-raises 0 --iterations 1 --frozen --memory-mib 1024
river_solver --config configs/river_default.json
river_solver --iterations 2000 --algorithm cfr_plus
explorer
```

`explorer` listens on `http://127.0.0.1:8765`. Save/Open a `.psol` file to resume the same regrets and strategy sums. On a chance node, Compare runouts lists every legal next card. Check-down equity is a fraction of the pot and is separate from chip EV.

`street_solver` and `river_solver` both solve on `StreetBatchSolver` (or `StreetGame` with `--reference`). `river_solver` maps a fixed five-card board into that shared tree. `--memory-mib` is the engine allocation budget in mebibytes (default 1024). `--threads N` is the frozen-pass thread count including the caller (default 1; `N > 1` requires `--frozen`). No solver uses an RNG.

The reported **Nash gap** is NashConv: `u0(BR0) + u1(BR1)`. Accuracy stopping uses NashConv / pot.

Configs: [`configs/street_default.txt`](configs/street_default.txt), [`configs/river_default.json`](configs/river_default.json). Rules: [docs/STREETS.md](docs/STREETS.md), [docs/RIVER.md](docs/RIVER.md).

Standalone equity:

```sh
equity_calculator --board "Kh Kd 7c 4s" --oop "AhAd,9c9d" --ip "AhAc:1,2c3d:1e-18"
```

Raise or lower the work ceiling with `--max-pair-runouts` or `POKER_EQUITY_MAX_PAIR_RUNOUTS`. Defaults admit a full-range river and reject a full-range turn. See [docs/EQUITY.md](docs/EQUITY.md).

## Layout

```text
include/game/     Street/river trees; Kuhn/Leduc reference games
include/solver/   CFR, CFR+, public-tree batch solvers, best response
include/poker/    Hold'em cards, hand evaluator, 1,326-hand ranges
src/              Implementations and CLIs
desktop/          React Study UI + Tauri Windows shell
ui/               Legacy explorer page (fallback)
tests/            In-repo harness + CTest
docs/             Architecture, product, mathematics, roadmap
```

## Documentation

- [docs/DESKTOP_UI.md](docs/DESKTOP_UI.md) — Study workstation + Windows packaging
- [docs/EXPLORER.md](docs/EXPLORER.md) — local engine HTTP API and page
- [docs/STREETS.md](docs/STREETS.md) — flop / turn / river tree
- [docs/RIVER.md](docs/RIVER.md) — five-card river CLI and chip rules
- [docs/HOLDEM.md](docs/HOLDEM.md) — cards, evaluator, ranges
- [docs/EQUITY.md](docs/EQUITY.md) — check-down showdown equity
- [docs/HUNL.md](docs/HUNL.md) — abstraction limits and algorithm choices
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/MATHEMATICS.md](docs/MATHEMATICS.md)
- [docs/TESTING.md](docs/TESTING.md)
- [docs/BENCHMARKS.md](docs/BENCHMARKS.md)
- [docs/ROADMAP.md](docs/ROADMAP.md)
- [docs/FEATURE_PARITY.md](docs/FEATURE_PARITY.md)
- [docs/LEDUC.md](docs/LEDUC.md) — Kuhn/Leduc reference games (engine tests)

## License

No public license is granted for this version. See [LICENSE](LICENSE).

Earlier commits keep the license text they were written with.

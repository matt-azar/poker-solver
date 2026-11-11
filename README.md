# poker-solver

Heads-up no-limit Texas Hold'em GTO solver (C++20) with a local Study workstation.

**Product surface:** postflop study through `explorer` and the React Study UI (`desktop/`) — solve, browse, lock, compare, save/reopen, and analyze. A Windows NSIS installer wraps that stack. Details: [docs/DESKTOP_UI.md](docs/DESKTOP_UI.md), [docs/EXPLORER.md](docs/EXPLORER.md). Doc index: [docs/README.md](docs/README.md).

Flop, turn, and river share one public betting tree (`StreetBatchSolver`). Convergence is an equilibrium of the configured bet-size tree.

## Windows installer

Download the unsigned NSIS setup from the [latest GitHub Release](https://github.com/matt-azar/poker-solver/releases/latest) (current cut: `v0.1.2-windows`):

**[Holdem Study (Windows)](https://github.com/matt-azar/poker-solver/releases/latest/download/Holdem-Study-windows-x64-setup.exe)** → `Holdem-Study-windows-x64-setup.exe`

1. Run the setup (current-user install; WebView2 may bootstrap)
2. Launch **Holdem Study** from the Start menu

Windows SmartScreen may warn because the binary is not code-signed — **More info → Run anyway**.

The installer stops any running Study UI/engine, places `holdem-explorer.exe` next to the UI, unblocks both binaries, and fails if the engine is missing. On launch the shell starts that sidecar on `127.0.0.1:8765` and waits until it accepts connections before the Study UI connects. No CMake or npm required.

Maintainers: CI rebuilds the artifact on desktop changes (Actions → **Windows Installer**). Publishing a Release is intentional — push a `v*-windows` tag (see packaging notes). Packaging notes: [docs/DESKTOP_UI.md](docs/DESKTOP_UI.md#desktop-packaging).

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

Production CLIs (multi-config): `build\Release\street_solver.exe`, `build\Release\river_solver.exe`, `build\Release\explorer.exe`, `build\Release\equity_calculator.exe`. Single-config builds omit the `Release` directory. Reference-game CLIs `kuhn_solver` and `leduc_solver` are also built; see [docs/auxiliary/reference/LEDUC.md](docs/auxiliary/reference/LEDUC.md).

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

`explorer` listens on `http://127.0.0.1:8765`. Save/Open a `.psol` file to resume the same regrets and strategy sums. In Study, Compare runouts shows one betting line across turn and river cards. Equity is a fraction of the pot and is separate from chip EV.

`street_solver` and `river_solver` both solve on `StreetBatchSolver` (or `StreetGame` with `--reference`). `river_solver` maps a fixed five-card board into that shared tree. `--memory-mib` is the engine allocation budget in mebibytes (default 1024). `--threads N` is the frozen-pass thread count including the caller (default 1; `N > 1` requires `--frozen`). No solver uses an RNG.

The reported **Nash gap** is NashConv: `u0(BR0) + u1(BR1)`. **Accuracy** (Pio exploitability) is NashConv/2. Accuracy stopping uses Accuracy / pot by default.

Configs: [`configs/street_default.txt`](configs/street_default.txt), [`configs/river_default.json`](configs/river_default.json). Rules: [docs/STREETS.md](docs/STREETS.md), [docs/RIVER.md](docs/RIVER.md).

Standalone equity:

```sh
equity_calculator --board "Kh Kd 7c 4s" --oop "AhAd,9c9d" --ip "AhAc:1,2c3d:1e-18"
```

Raise or lower the work ceiling with `--max-pair-runouts` or `POKER_EQUITY_MAX_PAIR_RUNOUTS`. Defaults admit a full-range river and reject a full-range turn. See [docs/EQUITY.md](docs/EQUITY.md).

## Layout

```text
include/          Public C++ headers (game, solver, poker, explorer)
src/              Engine libraries (poker/, solver/, game/, explorer/)
src/cli/          Process entrypoints (street/river/explorer/equity/kuhn/leduc)
desktop/          React Study UI + Tauri Windows shell (product UI)
legacy/ui/        Legacy explorer static page (fallback + regression)
benchmarks/       Study benchmark runner, cases, and street micro-benches
tests/            CTest suites: engine / study / HTTP (+ equity)
configs/          Defaults, ranges, templates; canonical range-profiles/
docs/             Primary CFR+/UI docs; auxiliary/ for the rest
docs/ai-context/  Study assistant model packs (imported by desktop/)

CMake libraries: poker_primitives → poker_solver → poker_study; poker_equity → primitives
```

## Documentation

Index: [docs/README.md](docs/README.md). Primary docs stay at `docs/`; supporting material is under `docs/auxiliary/`.

### CFR+ workflow

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — modules, `StreetBatchSolver`, CFR+ schedules
- [docs/STREETS.md](docs/STREETS.md) — flop / turn / river tree
- [docs/MATHEMATICS.md](docs/MATHEMATICS.md) — regret matching, NashConv, EV
- [docs/HOLDEM.md](docs/HOLDEM.md) — cards, evaluator, ranges
- [docs/RIVER.md](docs/RIVER.md) — five-card CLI onto the shared tree
- [docs/EQUITY.md](docs/EQUITY.md) — check-down showdown equity

### Study UI

- [docs/DESKTOP_UI.md](docs/DESKTOP_UI.md) — Study workstation + Windows packaging
- [docs/EXPLORER.md](docs/EXPLORER.md) — local engine HTTP API
- [docs/STUDY_SETUP_ASSISTANT.md](docs/STUDY_SETUP_ASSISTANT.md) — Study assistant
- [docs/ai-context/](docs/ai-context/README.md) — model-facing context packs

### Auxiliary

- [docs/auxiliary/](docs/auxiliary/README.md) — planning, engineering, payoffs, reference games, archive notes
  ([ROADMAP](docs/auxiliary/planning/ROADMAP.md), [FEATURE_PARITY](docs/auxiliary/planning/FEATURE_PARITY.md), [PROJECT_HISTORY](docs/auxiliary/notes/PROJECT_HISTORY.md), [TESTING](docs/auxiliary/engineering/TESTING.md), [BENCHMARKS](docs/auxiliary/engineering/BENCHMARKS.md), [LEDUC](docs/auxiliary/reference/LEDUC.md), [HUNL](docs/auxiliary/reference/HUNL.md), …)

## License

No public license is granted for this version. See [LICENSE](LICENSE).

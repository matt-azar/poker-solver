# poker-solver

Heads-up no-limit Texas Hold'em GTO solver (C++20) with a local Study workstation.

**Product surface:** postflop study in the React Study UI (`desktop/`). Browser development talks to the C++ `explorer` HTTP server. The packaged shell in this tree starts the Zig `solver-engine` sidecar first (typed IPC, protocol 2). If that sidecar is missing or fails ready, the shell starts `holdem-explorer`. CLI solves use `street_solver` and `river_solver`. Details: [docs/DESKTOP_UI.md](docs/DESKTOP_UI.md), [docs/EXPLORER.md](docs/EXPLORER.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Doc index: [docs/README.md](docs/README.md).

Flop, turn, and river share one public betting tree on the C++ path (`StreetBatchSolver`). Convergence is an equilibrium of the configured bet-size tree. The Zig sidecar is a second CFR+ implementation of `street-config 1`. It writes PSOL v4 and rejects older checkpoints.

## Windows installer

The latest GitHub Release is [`v0.1.2-windows`](https://github.com/matt-azar/poker-solver/releases/tag/v0.1.2-windows):

**[Holdem Study (Windows)](https://github.com/matt-azar/poker-solver/releases/latest/download/Holdem-Study-windows-x64-setup.exe)** → `Holdem-Study-windows-x64-setup.exe`

1. Run the setup (current-user install; WebView2 may bootstrap)
2. Launch **Holdem Study** from the Start menu

Windows SmartScreen may warn because the binary is not code-signed — **More info → Run anyway**.

That release starts `holdem-explorer.exe` on `127.0.0.1:8765`. If something is already listening on that port, the shell treats it as the engine. It does not start `solver-engine`. The installer stops a running Study UI and `holdem-explorer.exe`, places that engine next to the UI, unblocks the binaries, and fails if the engine is missing. No CMake or npm required.

This tree is ahead of that release. Its installer ships `holdem-explorer.exe` and `solver-engine.exe`. On launch the shell starts `solver-engine` over inherited pipes (IPC protocol 2). If that sidecar is missing or fails ready, the shell picks a free `127.0.0.1` port, starts `holdem-explorer` with a launch id, and waits for `GET /api/ready`. A process already listening on port 8765 is not used. The package version in the tree is still `0.1.2`. A newer `v*-windows` tag has not been published. Packaging notes: [docs/DESKTOP_UI.md](docs/DESKTOP_UI.md#desktop-packaging).

Maintainers: CI rebuilds the artifact on desktop changes (Actions → **Windows Installer**). Publishing a Release is intentional — push a `v*-windows` tag (see packaging notes).

## Study UI (developers)

```sh
# terminal 1 — after building explorer (see Build below)
./build/explorer --port 8765          # Windows: build\Release\explorer.exe --port 8765

# terminal 2
cd desktop && npm ci && npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` to the explorer.

Production static serve (no Vite):

```sh
cd desktop && npm ci && npm run build
./build/explorer --port 8765          # prefers desktop/dist when present
```

Then open `http://127.0.0.1:8765`.

## Requirements

- CMake 3.16+
- C++20 compiler: Visual Studio 2022 (MSVC) on Windows; GCC 13+ on Linux (CI). MinGW-w64 / Clang / older VS are untested without a smoke lane.
- Node 22+ for `desktop/` (`engines.node` in `desktop/package.json`; CI uses Node 22 + `npm ci`)
- Rust 1.83+ for the Tauri shell (`desktop/src-tauri/Cargo.toml` `rust-version`)
- Zig 0.14.1 to build `solver-engine` (`./scripts/zig/install-toolchain.sh` on Linux x86_64). Pin, hashes, and commands: [docs/auxiliary/engineering/ZIG_RELEASE_GATES.md](docs/auxiliary/engineering/ZIG_RELEASE_GATES.md).

The C++ solver does not need Python or third-party C++ libraries. Zig ready-smoke and gate scripts use Python 3.

## Build

Windows (Visual Studio):

```bat
cmake -S . -B build -G "Visual Studio 17 2022" -A x64 -DPOKER_SOLVER_BUILD_BENCHMARKS=ON
cmake --build build --config Release
ctest --test-dir build -C Release --output-on-failure
```

Prefer `--config Release` with the VS generator. Or use `scripts\build.ps1`.

Linux / WSL2:

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DPOKER_SOLVER_BUILD_BENCHMARKS=ON
cmake --build build
ctest --test-dir build --output-on-failure
```

Or `scripts/build.sh`. Tests default on (`BUILD_TESTING`); micro-benchmarks opt in with `-DPOKER_SOLVER_BUILD_BENCHMARKS=ON`. CTest runs with the source tree as the working directory so `configs/` fixtures resolve from any build directory.

Debug:

```sh
cmake -S . -B build/debug -DCMAKE_BUILD_TYPE=Debug
cmake --build build/debug
```

Production CLIs (multi-config): `build\Release\street_solver.exe`, `build\Release\river_solver.exe`, `build\Release\explorer.exe`, `build\Release\equity_calculator.exe`. Single-config builds omit the `Release` directory.

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

`explorer` listens on `http://127.0.0.1:8765`. Save/Open a `.psol` file on that server resumes the same regrets and strategy sums (PSOL v1–v3). `solver-engine` writes PSOL v4 and rejects those older files. In Study, Compare runouts shows one betting line across turn and river cards. Equity is a fraction of the pot and is separate from chip EV.

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
src/              C++ engine libraries (poker/, solver/, game/, explorer/)
src/cli/          C++ process entrypoints (street/river/explorer/equity)
engine/           Zig engine (cards, street-config, CFR+ train, inspect)
app/              Zig session
formats/          Zig PSOL v4
host/             Zig solver-engine IPC host (protocol 2)
cli/              Zig street-config-check and gate-bench
desktop/          React Study UI + Tauri Windows shell (product UI)
legacy/ui/        Legacy explorer static page (fallback + regression)
benchmarks/       Study benchmark runner, cases, and street micro-benches
tests/            CTest suites: engine / study / HTTP (+ equity)
configs/          Defaults, ranges, templates; canonical range-profiles/
docs/             Primary CFR+/UI docs; auxiliary/ for the rest
docs/ai-context/  Study assistant model packs (imported by desktop/)

CMake libraries: poker_primitives → poker_solver → poker_study; poker_equity → primitives
Zig build: zig build / zig build test  (see build.zig)
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
  ([ROADMAP](docs/auxiliary/planning/ROADMAP.md), [FEATURE_PARITY](docs/auxiliary/planning/FEATURE_PARITY.md), [PROJECT_HISTORY](docs/auxiliary/notes/PROJECT_HISTORY.md), [TESTING](docs/auxiliary/engineering/TESTING.md), [BENCHMARKS](docs/auxiliary/engineering/BENCHMARKS.md), [HUNL](docs/auxiliary/reference/HUNL.md), …)

## License

No public license is granted for this version. See [LICENSE](LICENSE).

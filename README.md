# poker-solver

Heads-up no-limit Texas Hold'em GTO solver (**Zig**) with a local Study workstation.

**Product surface:** postflop Study through the Zig `solver-engine` sidecar and the React Study UI (`desktop/`) — solve, browse, lock, compare, save/reopen, and analyze. A Windows NSIS installer wraps that stack. Details: [docs/DESKTOP_UI.md](docs/DESKTOP_UI.md). Doc index: [docs/README.md](docs/README.md).

Flop, turn, and river share one public betting tree. Convergence is an equilibrium of the configured bet-size tree.

Study is Zig typed IPC.

## Windows installer

Download the unsigned NSIS setup from the [latest GitHub Release](https://github.com/matt-azar/poker-solver/releases/latest) (current cut: `v0.1.6-windows`):

**[Holdem Study (Windows)](https://github.com/matt-azar/poker-solver/releases/latest/download/Holdem-Study-windows-x64-setup.exe)** → `Holdem-Study-windows-x64-setup.exe`

1. Run the setup (current-user install; WebView2 may bootstrap)
2. Launch **Holdem Study** from the Start menu

Windows SmartScreen may warn because the binary is not code-signed — **More info → Run anyway**.

The installer stops any running Study UI and engine, places `solver-engine.exe` next to the UI, unblocks the binaries, and fails if the engine is missing. On launch the shell starts that Zig sidecar with a launch id over inherited pipes and waits for ready before the Study UI connects.

Maintainers: CI rebuilds the artifact on desktop / Zig engine changes (Actions → **Windows Installer**). Publishing a Release is intentional — push a `v*-windows` tag (see packaging notes). Packaging notes: [docs/DESKTOP_UI.md](docs/DESKTOP_UI.md#desktop-packaging).

## Study UI (developers)

```sh
# terminal 1 — Zig engine (optional smoke; Tauri also builds/copies the sidecar)
zig build -Doptimize=ReleaseFast
# or: scripts/build.sh

# terminal 2 — Tauri shell (spawns solver-engine over inherited pipes)
cd desktop && npm ci && npm run tauri dev
```

`npm run dev` starts Vite. `npm run tauri dev` starts the shell and `solver-engine`.

Limited **river** live browser beta (isolated sessions over typed IPC): see
[`services/river-beta/README.md`](services/river-beta/README.md) and open
`http://127.0.0.1:5173/?river-beta=1` with the service running. Boards must be
five cards. Turn and flop stay out of that service until its per-session CPU
and RSS numbers are reviewed.

Portable study jobs (`holdem-study-job/1`) are shared by Build **Export job** / **Import job** and `holdem-study-cli`:

```sh
zig build
./zig-out/bin/holdem-study-cli plan configs/examples/study-jobs/river_btn_bb_srp.job.json
./zig-out/bin/holdem-study-cli solve configs/examples/study-jobs/river_btn_bb_srp.job.json \
  --out /tmp/study.psol --engine ./zig-out/bin/solver-engine
./zig-out/bin/holdem-study-cli from-hh configs/examples/study-jobs/river_btn_bb_srp.hh.txt \
  --out /tmp/job.json
```

`from-hh` reads a five-card `hand-history 1` file. Details: [`configs/examples/study-jobs/README.md`](configs/examples/study-jobs/README.md).

Precomputed public demo (browse only): [`desktop/src/demo/README.md`](desktop/src/demo/README.md).
Pages URL: `https://matt-azar.github.io/poker-solver/?demo=flop-explore`
(repo Pages source must be GitHub Actions). Private QA is `?preview=` via
`npm run preview:scenario`. It is a separate entry.

## Requirements

- Zig **0.14.1** (pinned in `.github/workflows/zig.yml`)
- Node 22+ for `desktop/` (`engines.node` in `desktop/package.json`; CI uses Node 22 + `npm ci`)
- Rust 1.83+ for the Tauri shell (`desktop/src-tauri/Cargo.toml` `rust-version`)

## Build

```sh
zig build -Doptimize=ReleaseFast
zig build test
# optional local wrapper (build + ready smoke):
scripts/build.sh          # Windows: scripts\build.ps1
```

Windows Study installer packaging: see [docs/DESKTOP_UI.md](docs/DESKTOP_UI.md#desktop-packaging) and `.github/workflows/windows-installer.yml`.

## Layout

```text
engine/ app/ formats/ host/ cli/   Zig solver, `solver-engine`, `holdem-study-cli`
build.zig / build.zig.zon          Zig workspace
desktop/                           React Study UI + Tauri Windows shell
configs/                           Defaults, ranges, templates; range-profiles/
tests/fixtures/psol/               Tiny PSOL compatibility pins (Zig tests)
benchmarks/study/                  Study benchmark cases / configs
docs/                              Primary docs; auxiliary/ for the rest
docs/ai-context/                   Study assistant model packs (imported by desktop/)
```

## Documentation

Index: [docs/README.md](docs/README.md). Primary docs stay at `docs/`; supporting material is under `docs/auxiliary/`.

### CFR+ workflow

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — modules and CFR+ schedules
- [docs/STREETS.md](docs/STREETS.md) — flop / turn / river tree
- [docs/MATHEMATICS.md](docs/MATHEMATICS.md) — regret matching, NashConv, EV
- [docs/HOLDEM.md](docs/HOLDEM.md) — cards, evaluator, ranges
- [docs/RIVER.md](docs/RIVER.md) — five-card path onto the shared tree
- [docs/EQUITY.md](docs/EQUITY.md) — check-down showdown equity

### Study UI

- [docs/DESKTOP_UI.md](docs/DESKTOP_UI.md) — Study workstation + Windows packaging
- [docs/EXPLORER.md](docs/EXPLORER.md) — `solver-engine` protocol 2 frames
- [docs/STUDY_SETUP_ASSISTANT.md](docs/STUDY_SETUP_ASSISTANT.md) — Study assistant
- [docs/ai-context/](docs/ai-context/README.md) — model-facing context packs

### Auxiliary

- [docs/auxiliary/](docs/auxiliary/README.md) — planning, engineering, payoffs, reference games, archive notes
  ([ROADMAP](docs/auxiliary/planning/ROADMAP.md), [FEATURE_PARITY](docs/auxiliary/planning/FEATURE_PARITY.md), [PROJECT_HISTORY](docs/auxiliary/notes/PROJECT_HISTORY.md), [TESTING](docs/auxiliary/engineering/TESTING.md), [BENCHMARKS](docs/auxiliary/engineering/BENCHMARKS.md), [HUNL](docs/auxiliary/reference/HUNL.md), …)

## License

No public license is granted for this version. See [LICENSE](LICENSE).

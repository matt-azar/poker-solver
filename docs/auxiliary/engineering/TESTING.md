# Testing

Product validation on `main` is Zig engine tests, desktop Vitest, and real-sidecar IPC contract smokes.

## Quick commands

```sh
# Zig engine + host unit/integration tests
zig build test -Dcpu=x86_64_v2

# Optional ready handshake smoke
python3 scripts/zig/ready-smoke.py ./zig-out/bin/solver-engine

# Study IPC contract smoke (ready → begin_config → solve → status → node →
# equity → pause/stop → save/open/continue). River gate fixture; ≤60s; no Acc wall.
python3 scripts/zig/study-contract-smoke.py ./zig-out/bin/solver-engine

# Overlapping Solve/Stop/Continue/Open/nav with analysis in flight (ZR-152).
# Linux real-sidecar; Windows packaged Study overlap waits for ma1pc (ZR-147).
python3 scripts/zig/study-overlap-actions-smoke.py ./zig-out/bin/solver-engine

# Desktop unit tests (Vitest) + typecheck
cd desktop && npm ci && npm test && npx tsc -b

# After assistant / help-body label moves
cd desktop && npm run check:ai-context
```

Windows: use `python` and `zig-out/bin/solver-engine.exe` the same way. Prefer `-Dcpu=x86_64_v2` for any sidecar that may leave the builder host.

## What each layer covers

| Layer | Entry | Covers |
| --- | --- | --- |
| Zig unit / integration | `zig build test` | Engine CFR/frozen/locks/equity/ICM math pins, Session train/eval, host dispatch envelopes under `tests/zig/` + `engine/` |
| Ready smoke | `scripts/zig/ready-smoke.py` | Protocol-2 ready handshake on a live `solver-engine` process |
| Study contract smoke | `scripts/zig/study-contract-smoke.py` | Real-sidecar typed IPC lifecycle used by Study (ZR-104). Uses `benchmarks/study/configs/river_gate_smoke.txt`. **No Accuracy wall.** |
| Study overlap actions smoke | `scripts/zig/study-overlap-actions-smoke.py` | Alternating Solve/Stop/Continue/Open/nav with analysis in flight; late reply must not overwrite solution; memory settles; stdin EOF exits engine (ZR-152). Linux CI; Windows packaged suite → ZR-147/ma1pc. |
| Async IPC supervisor (Rust) | `scripts/desktop/ipc-async-acceptance.sh` | Controllable `ipc-test-sidecar` withholds `values` while status/cancel complete; kill reaps. Proves dedicated writer/reader ownership (not Zig-only). Also covers admission saturation, status coalesce, short solve-admit (`cargo test --lib solver_engine::`). |
| Async IPC WebView (Windows) | `scripts/desktop/ipc-async-acceptance.ps1 -StudyExe …` | Packaged/dev Study with `STUDY_IPC_ACCEPTANCE=1` + `STUDY_SOLVER_ENGINE` → WebView concurrent invokes; exit 0 on pass. |
| IPC race / bug-case replay | `python scripts/desktop/ipc_race_replay.py scripts/desktop/ipc-race-cases/values-hold-status-cancel.json` | Declarative cases (input + actions + expected + optional `build_sha`). **Pass bar:** Status + Cancel while EV withheld (`values-hold-status-cancel`). Engine repros: `sidecar: engine` + `--require-sha`. UI A→B stale-EV is browser/Playwright, not this layer. **Not** flop/memory benches. |
| Windows installer E2E Stage A | `scripts/desktop/windows-installer-e2e.ps1 -InstallerExe … -Stage A` | Silent-installs the **exact** NSIS artifact with explicit `/D=%LOCALAPPDATA%\Holdem Study` (PR installer when the follow-on job runs after `windows-installer`); resolves UI as `Holdem Study.exe` **or** Cargo/Tauri `poker-solver-study.exe` (registry `MainBinaryName`); requires an **interactive** Windows session; launches Study with `STUDY_INSTALLER_E2E=stage-a` so the WebView boot hook drives `ensure`+`status` (proves control); explicit timeouts; on failure writes `last-completed-step.txt` + `windows_collect` diagnostics. |
| Windows installer E2E Stage B | `scripts/desktop/windows-installer-e2e.ps1 -InstallerExe … -Stage B` | Same install bar, then `STUDY_INSTALLER_E2E=stage-b` + `STUDY_INSTALLER_E2E_STAGE_B=1`: tiny river solve → browse node → save PSOL → **clear active solution** (kill+re-ensure; assert `nothing_published`) → reopen PSOL → assert strategy fingerprint restored → close; sidecar exits. |
| Desktop Vitest | `cd desktop && npm test` | `EngineClient` IPC branches, Study store/lifecycle, locks/strategy-edits soft gates, analysis helpers, UI domain |
| Desktop typecheck | `cd desktop && npx tsc -b` | Store/client nullability that vitest can miss |
| AI context packs | `cd desktop && npm run check:ai-context` | Generated packs match `docs/ai-context/source/` |

Coverage claims use IPC envelope errors, host `error` replies, and the contract smoke above.

## CI

| Workflow | Role |
| --- | --- |
| `.github/workflows/zig.yml` | `zig build` / `zig build test` + ready smoke + Study contract smoke (Linux + Windows; Windows pins `-Dcpu=x86_64_v2`) |
| `.github/workflows/ci.yml` | Desktop Vitest, `tsc`, and build |
| `.github/workflows/public-demo-pages.yml` | Precomputed public Study demo: `npm run build:public-demo` + Playwright (desktop Chromium + touch Chromium/WebKit @ 360/390), then deploy `desktop/dist-public-demo` to GitHub Pages (`PUBLIC_DEMO_BASE=/poker-solver/`). One-time: repo Pages source = GitHub Actions. Not live solving; Windows download stays on GitHub Releases. |
| `.github/workflows/ipc-race-probes.yml` | Windows (+ Linux) hold-EV probe: Status + Cancel while values withheld. Separate from flop/memory benches, installer E2E, and UI stale-EV. |
| `.github/workflows/windows-installer.yml` | NSIS packs Zig `solver-engine`. The frontend Vite build is Tauri `beforeBuildCommand`. Follow-on `windows-installer-e2e` runs Stage A then Stage B against that artifact. |

Packaged Tauri webview lifecycle and the Windows installer remain a release gate (Actions → **Windows Installer**). See [DESKTOP_UI.md](../../DESKTOP_UI.md).

## Optional digs (not product CI)

Bounded flop microbenches / node-EV latency scripts under `scripts/zig/` are agent dig tools. Owner preference: Accuracy / time-to-Accuracy / NashConv walls are **not** cutover blockers and are not required for merge. See [ZIG_RELEASE_GATES.md](ZIG_RELEASE_GATES.md).


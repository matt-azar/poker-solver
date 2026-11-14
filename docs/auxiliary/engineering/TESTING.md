# Testing

Product validation on `main` is **Zig engine tests**, **desktop Vitest**, and **real-sidecar IPC contract smokes**. The C++ `ctest` / `poker_http_tests` / spawned-`explorer` matrix is removed (#286–#287).

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
| Async IPC supervisor (Rust) | `scripts/desktop/ipc-async-acceptance.sh` | Controllable `ipc-test-sidecar` withholds `values` while status/cancel complete; kill reaps. Proves dedicated writer/reader ownership (not Zig-only). |
| Async IPC WebView (Windows) | `scripts/desktop/ipc-async-acceptance.ps1 -StudyExe …` | Packaged/dev Study with `STUDY_IPC_ACCEPTANCE=1` + `STUDY_SOLVER_ENGINE` → WebView concurrent invokes; exit 0 on pass. |
| Desktop Vitest | `cd desktop && npm test` | `EngineClient` IPC branches, Study store/lifecycle, locks/strategy-edits soft gates, analysis helpers, UI domain |
| Desktop typecheck | `cd desktop && npx tsc -b` | Store/client nullability that vitest can miss |
| AI context packs | `cd desktop && npm run check:ai-context` | Generated packs match `docs/ai-context/source/` |

Do **not** claim coverage from deleted C++ HTTP suites (`test_explorer_http.cpp`, `poker_http_tests`, HTTP 400/404/409 explorer replies). Those strings and binaries are not a shipping surface on this branch. Prefer IPC envelope errors / host `error` replies and the contract smoke above.

## CI

| Workflow | Role |
| --- | --- |
| `.github/workflows/zig.yml` | `zig build` / `zig build test` + ready smoke + Study contract smoke (Linux + Windows; Windows pins `-Dcpu=x86_64_v2`) |
| `.github/workflows/ci.yml` | Desktop Vitest / `tsc` / build (C++ explorer matrices removed) |
| `.github/workflows/windows-installer.yml` | NSIS packs Zig `solver-engine` only; rejects leftover `holdem-explorer*.exe` |

Packaged Tauri webview lifecycle and the Windows installer remain a release gate (Actions → **Windows Installer**). See [DESKTOP_UI.md](../../DESKTOP_UI.md).

## Optional digs (not product CI)

Bounded flop microbenches / node-EV latency scripts under `scripts/zig/` are agent dig tools. Owner preference: Accuracy / time-to-Accuracy / NashConv walls are **not** cutover blockers and are not required for merge. See [ZIG_RELEASE_GATES.md](ZIG_RELEASE_GATES.md).

## Historical (pre-#287 C++ tree)

Older revisions of this file described CMake/`ctest` targets (`poker_engine_tests`, `poker_study_tests`, `poker_http_tests`, `equity_tests`) and assertion archaeology against `include/` / `src/` / `explorer --port`. That tree is gone. Do not restore cmake how-tos as present-tense product testing. Archaeology: [PROJECT_HISTORY.md](../notes/PROJECT_HISTORY.md), git history before the C++ strip.

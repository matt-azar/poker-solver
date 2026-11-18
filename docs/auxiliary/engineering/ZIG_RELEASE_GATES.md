# Zig release gates

The Windows cutover already shipped (owner GO 2026-11-12): stable NSIS is Zig
`solver-engine` typed IPC. This page is the in-repo procedure for what CI runs
and which measurements stay optional.

Scoreboard notes named below are store documents. They are not files in this
repository:

| Topic | Store doc |
| --- | --- |
| Scoreboard + measurement procedure | `zig-perf-scoreboard.md` |
| Cutover checklist / open blockers | `zig-cutover-criteria.md` |
| Toolchain pin | `zig-toolchain-pin.md` |
| Phase exit gates | `zig-phase-checklist.md` |
| Parity / oracle log | `zig-parity-oracle-log.md` |

Owner GO 2026-11-12: stable Windows NSIS ships Zig `solver-engine`
typed IPC. Scoreboard notes remain in the store docs above.

**Acc / perf are not cutover blockers** (owner preference 2026-11-12): do not
block merge or ship on Accuracy/NashConv / time-to-Accuracy walls. Keep real
sidecar contract tests and the Windows installer workflow. Optional Acc digs
stay bounded and store-recorded — they are not a green-check gate in this file.

## Locked fixtures (D12)

- `flop_srp_one_size` — existing Study / parity fixture
- `flop_srp_two_sizes` — same tree with both players’ flop opening bets set to
  **⅓ pot** and **¾ pot** only

Fixture assets live under `benchmarks/study/`. Memory plans use host `plan_memory`.

## Optional measurement procedure (digs only — not a cutover gate)

When recording store scoreboard rows (optional; not required for cutover):

1. Windows **Release** builds; **matched** thread counts.
2. Columns may include: cold wall to Accuracy/pot ≤ **0.001**, warm fixed-iteration
   train, Accuracy at cap, peak memory (RSS + plan notes).
3. Separately measure **live Study node EV latency** under active train on the
   same fixtures when that dig is scheduled.
4. Record rows in the store scoreboard — not as a green check here. Do not
   schedule new hour-long Acc walls by default (prefer ≤30–45 min soft+hard kill).

## CI scaffolding on `main`

| Workflow | Role |
| --- | --- |
| `.github/workflows/zig.yml` | Linux + Windows `zig build` / `zig build test` + ready smoke + `check-no-avx512.py` + equity-calculator smoke + Study contract smoke (`scripts/zig/study-contract-smoke.py`, river fixture, ≤60s) + `holdem-study-cli` smoke. Linux also runs engine-crash-recovery, stop-close-responsive, overlap-actions (`scripts/zig/study-overlap-actions-smoke.py`, ZR-152), and status-vs-mutation smokes. Windows passes `-Dcpu=x86_64_v2`. On x86_64, omitting `-Dcpu` already targets `x86_64_v2`. Windows packaged Study overlap waits for ma1pc (ZR-147). |
| `.github/workflows/windows-installer.yml` | Shipping NSIS. `externalBin` is Zig `solver-engine`. `windows-installer-e2e` Stage A (install + WebView drive), Stage B (river clear-then-reopen PSOL), Stage DelayedReply (packaged WebView concurrency via `ipc-async-acceptance.ps1`), Stage BlockedWrite, Stage NormalClosePending, and Stage StaleCallAfterReconnect. |
| `.github/workflows/windows-installer-release.yml` | Tag-triggered release wrapper that reuses `windows-installer.yml` |
| `.github/workflows/ci.yml` | Desktop Vitest, `tsc`, and build |
| `.github/workflows/public-demo-pages.yml` | Precomputed public Study demo build, Playwright (desktop + phone), deploy `desktop/dist-public-demo` |
| `.github/workflows/ipc-race-probes.yml` | Hold-EV probe + Rust `solver_engine::` supervisor tests; path filters cover production supervisor / Zig dispatch / TS transport |

Stable Study ships Zig typed IPC after owner GO (2026-11-12).
The installer packages `solver-engine`.

## Local toolchain

```bash
./scripts/zig/install-toolchain.sh   # Linux x86_64 — verifies official sha256
zig version                          # expect 0.14.1
./scripts/build.sh                   # passes -Dcpu=x86_64_v2 (ZIG_CPU overrides). On x86_64, omitting -Dcpu already targets x86_64_v2. -Dcpu=native follows the builder CPU.
# or: zig build -Doptimize=ReleaseFast -Dcpu=x86_64_v2 && zig build test -Dcpu=x86_64_v2
python3 scripts/zig/study-contract-smoke.py ./zig-out/bin/solver-engine
```

Pin fields (version, URLs, hashes) must match `.github/workflows/zig.yml` and
the store toolchain pin doc. Product testing overview: [TESTING.md](TESTING.md).

## Bounded measurement rule (agent digs)

Do **not** wait forever on flop-scale trains:

| Fixture class | Suggested wall bound | Tool |
| --- | --- | --- |
| River / smoke (`river_gate_smoke.txt`) | ≤ 60 s | `scripts/zig/run-gate-bounded.sh 60 …` / Study contract smoke |
| Flop `flop_srp_one_size` warm fixed-iter | ≤ 180 s (then kill + escalate) | same wrapper |
| Flop `flop_srp_one_size` Study node-EV (IPC) | train ≤ 180 s + values ≤ 60 s | `scripts/zig/node-ev-latency.py` |
| Flop cold Accuracy/pot ≤ 0.001 | dedicated Windows Release machine; optional dig only — **not** a cutover gate | — |
| `flop_srp_two_sizes` train | plan peak ~2.63 GiB with flop-only `oop-flop-bets`/`ip-flop-bets`; skip if host RAM tight | plan-memory first |

Harness: `zig-out/bin/gate-bench` (Zig Session frozen CFR+; NashConv via frozen
`response_walk`). Prefer `--skip-eval` only when measuring train wall alone.
Node-EV dig: `python3 scripts/zig/node-ev-latency.py` after `zig build`.
Linux numbers are interim only — Windows Release remains authoritative for
optional scoreboard digs.

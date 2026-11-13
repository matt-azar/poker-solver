# Zig release gates

Product path on `main`: Zig `solver-engine` typed IPC. The Windows NSIS installer ships that binary only. HTTP `holdem-explorer` is not packaged.

Accuracy, NashConv, and time-to-Accuracy numbers are not merge gates. Required checks are the sidecar contract tests and the Windows installer workflow. Optional timing digs stay bounded. They are not a green check in this file.

These files are not in the repository: `zig-perf-scoreboard.md`, `zig-cutover-criteria.md`, `zig-toolchain-pin.md`, `zig-phase-checklist.md`, `zig-parity-oracle-log.md`. Do not treat them as the product procedure. This file and [TESTING.md](TESTING.md) are the procedure.

## Locked fixtures (D12)

- `flop_srp_one_size` — existing Study / parity fixture
- `flop_srp_two_sizes` — same tree with both players’ flop opening bets set to
  **⅓ pot** and **¾ pot** only

Fixture assets live under `benchmarks/study/`. The C++ tree is removed.
Old `--plan-memory` notes are not in this repository.

## Optional measurement procedure

These runs are optional. They are not a merge gate.

When recording a timing dig:

1. Windows **Release** builds; **matched** thread counts.
2. Columns may include: cold wall to Accuracy/pot ≤ **0.001**, warm fixed-iteration
   train, Accuracy at cap, peak memory (RSS + plan notes).
3. Separately measure **live Study node EV latency** under active train on the
   same fixtures when that dig is scheduled.
4. Keep the numbers with the dig. Do not treat them as a green check in this
   file. Do not schedule new hour-long Accuracy walls by default (prefer a
   30–45 minute kill).

## CI scaffolding on `main`

| Workflow | Role |
| --- | --- |
| `.github/workflows/zig.yml` | Linux + Windows `zig build` / `zig build test` + ready smoke + Study contract smoke (`scripts/zig/study-contract-smoke.py`, river fixture, ≤60s) + Linux overlap-actions smoke (`scripts/zig/study-overlap-actions-smoke.py`, ZR-152); Windows pins `-Dcpu=x86_64_v2`. Windows packaged Study overlap waits for ma1pc (ZR-147). |
| `.github/workflows/windows-installer.yml` | Shipping NSIS; `externalBin` is Zig `solver-engine` only (no `holdem-explorer`) |
| `.github/workflows/windows-installer-release.yml` | Tag-triggered release wrapper that reuses `windows-installer.yml` |
| `.github/workflows/ci.yml` | Desktop Vitest / `tsc` / build (no C++ explorer matrix) |

The labeled Zig tech-preview installer workflow was removed with the C++ strip
(#287). Stable Study ships Zig typed IPC only.
There is no dual-sidecar / dormant `holdem-explorer` packaging path.

## Local toolchain

```bash
./scripts/zig/install-toolchain.sh   # Linux x86_64 — verifies official sha256
zig version                          # expect 0.14.1
./scripts/build.sh                   # pins -Dcpu=x86_64_v2 (override via ZIG_CPU)
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

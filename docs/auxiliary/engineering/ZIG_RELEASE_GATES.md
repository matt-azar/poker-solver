# Zig release gates (Phase 7 scaffolding)

Living cutover numbers and GO/NO-GO live in the Zig rewrite store docs (not this
file). This page is the **in-repo** procedure pointer so CI and reviewers know
what to run and what must stay blocked.

## Authority

| Topic | Store doc |
| --- | --- |
| Scoreboard + measurement procedure | `zig-perf-scoreboard.md` |
| Cutover checklist / open blockers | `zig-cutover-criteria.md` |
| Toolchain pin | `zig-toolchain-pin.md` |
| Phase exit gates | `zig-phase-checklist.md` |
| Parity / oracle log | `zig-parity-oracle-log.md` |

Owner GO 2026-11-12: stable Windows NSIS ships Zig `solver-engine` only
(typed IPC). HTTP `holdem-explorer` is not a packaged Study path on
`zig-rewrite`. Scoreboard/evidence remain in the store docs above.

## Locked fixtures (D12)

- `flop_srp_one_size` — existing Study / parity fixture
- `flop_srp_two_sizes` — same tree with both players’ flop opening bets set to
  **⅓ pot** and **¾ pot** only

Fixture assets live under `benchmarks/study/` (and parity harnesses that
consume them). Always run C++ `--plan-memory` first on each fixture before
comparing Zig.

## Locked measurement procedure (D12)

1. Windows **Release** builds; **matched** thread counts.
2. Columns: cold wall to Accuracy/pot ≤ **0.001**, warm fixed-iteration train,
   Accuracy at cap, peak memory (RSS + C++ plan notes).
3. Separately measure **live Study node EV latency** under active train on the
   same fixtures.
4. Compare Zig vs **pinned** C++ and **current** C++ (D10). Record rows in the
   store scoreboard — not as a green check here.

## CI scaffolding on `zig-rewrite`

| Workflow | Role |
| --- | --- |
| `.github/workflows/zig.yml` | Linux + Windows `zig build` / `zig build test` + ready smoke |
| `.github/workflows/windows-installer-zig-preview.yml` | Labeled NSIS artifact `holdem-study-zig-tech-preview-windows-installer` (`productName`: Holdem Study Zig Tech Preview) |
| `.github/workflows/windows-installer.yml` | Shipping-labeled installer; still bundles dormant `solver-engine.exe` because `externalBin` lists both |

Preview installers must stay clearly labeled. Shipping cutover flips the
default Study transport only after cutover criteria are green and the owner
records an explicit GO.

## Local toolchain

```bash
./scripts/zig/install-toolchain.sh   # Linux x86_64 — verifies official sha256
zig version                          # expect 0.14.1
zig build -Doptimize=ReleaseFast
zig build test
```

Pin fields (version, URLs, hashes) must match `.github/workflows/zig.yml` and
the store toolchain pin doc.

## Bounded measurement rule (agent digs)

Do **not** wait forever on flop-scale trains:

| Fixture class | Suggested wall bound | Tool |
| --- | --- | --- |
| River / smoke (`river_gate_smoke.txt`) | ≤ 60 s | `scripts/zig/run-gate-bounded.sh 60 …` |
| Flop `flop_srp_one_size` warm fixed-iter | ≤ 180 s (then kill + escalate) | same wrapper / C++ `--time-limit` |
| Flop `flop_srp_one_size` Study node-EV (IPC) | train ≤ 180 s + values ≤ 60 s | `scripts/zig/node-ev-latency.py` |
| Flop cold Accuracy/pot ≤ 0.001 | dedicated Windows Release machine; not an agent dig | — |
| `flop_srp_two_sizes` train | plan peak ~2.63 GiB with flop-only `oop-flop-bets`/`ip-flop-bets`; skip if host RAM tight | plan-memory first |

Harness: `zig-out/bin/gate-bench` (Zig Session frozen CFR+; NashConv via frozen
`response_walk`). Prefer `--skip-eval` only when measuring train wall alone.
Node-EV dig: `python3 scripts/zig/node-ev-latency.py` after `zig build`.
Linux numbers are interim only — Windows Release remains authoritative.

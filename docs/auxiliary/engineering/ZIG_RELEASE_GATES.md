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

Do not record a quality cutover from this file. The packaged shell starts
`solver-engine` first (IPC protocol 2). `holdem-explorer` starts when that
sidecar is missing or fails ready. Browser development still uses `explorer`
over HTTP. The published `v0.1.2-windows` installer starts `holdem-explorer`
on port 8765 and does not include this sidecar.

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
| `.github/workflows/windows-installer.yml` | Installer built from this tree. It bundles `holdem-explorer.exe` and `solver-engine.exe`. The shell starts `solver-engine` first. |

Preview installers stay labeled **Holdem Study Zig Tech Preview**. Quality
cutover (replacing the C++ CLI and HTTP engine, and accepting Zig numbers as
the shipping measurement) still requires the store checklist and an explicit
GO. The transport preference in this tree is already `solver-engine` first.

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
| Flop `flop_srp_one_size` Study node-EV (IPC) | train ≤ 120 s + values ≤ 180 s | `scripts/zig/node-ev-latency.py` (root = frozen `response_walk`) |
| Flop cold Accuracy/pot ≤ 0.001 | dedicated Windows Release machine; not an agent dig | — |
| `flop_srp_two_sizes` train | plan peak ~2.63 GiB with flop-only `oop-flop-bets`/`ip-flop-bets`; skip if host RAM tight | plan-memory first |

Harness: `zig-out/bin/gate-bench` (Zig Session frozen CFR+; NashConv via frozen
`response_walk`). Prefer `--skip-eval` only when measuring train wall alone.
Linux numbers are interim only — Windows Release remains authoritative.

# Study crash & hang debug suite

Practical scripts for diagnosing **crashes** vs **hangs** in Holdem Study
(Tauri UI + Zig `solver-engine` typed IPC). They observe from outside the app —
no HTTP `:8765`, no `holdem-explorer`, no product-code hooks required.

App-written evidence (Help → Open diagnostics folder) still matters:

| File | Meaning |
| --- | --- |
| `last-fault.json` | Hard session fault / kill / ensure-fail |
| `ui-hang-events.json` | Soft timeouts / main-thread stalls (may recover) |
| `last-solve.json` | Pre-solve parameters (survives if process dies mid-train) |
| `host-resources.json` | RSS / RAM snapshot (`pre-solve` vs `fault`) |
| `engine.log` | Rolling sidecar stderr |
| `session-meta.json` | App version, protocol, launch id |

Default folder: `%LOCALAPPDATA%\Holdem Study\diagnostics` (Windows), or
`$XDG_DATA_HOME/Holdem Study/diagnostics` / macOS Application Support.
Override with `HOLDEM_STUDY_DIAGNOSTICS_DIR`.

## Quick start

```bash
# From repo root
python3 scripts/debug/smoke_selftest.py

# While Study is misbehaving:
python3 scripts/debug/capture_snapshot.py
python3 scripts/debug/analyze_diagnostics.py
python3 scripts/debug/collect_bundle.py --zip --stacks

# With a built sidecar:
zig build -Dcpu=x86_64_v2
python3 scripts/debug/ipc_probe.py
python3 scripts/debug/train_freeze_probe.py
python3 scripts/debug/smoke_selftest.py --with-engine
```

Optional: `pip install psutil` for better CPU% sampling on `capture_snapshot` /
`watch_hang`.

## Scripts

| Script | Failure mode | What it does |
| --- | --- | --- |
| `capture_snapshot.py` | crash **or** hang | Process tree, RSS/CPU, orphan sidecar detection |
| `analyze_diagnostics.py` | crash **or** hang | Classifies app diagnostics / zip → crash vs hang |
| `watch_hang.py` | hang | Time-series CPU/RSS; alerts on idle sidecar / exit |
| `stack_sample.py` | hang (live) | Backtraces via eu-stack/gdb/sample/cdb |
| `ipc_probe.py` | IPC timeout / demux | Spawns `solver-engine`; checks ready + request_id demux + status budget |
| `train_freeze_probe.py` | train freeze | `solve` then interleaved `status` — status must stay live |
| `find_crash_dumps.py` | crash | Locates Windows minidumps / Linux cores |
| `windows_sidecar_check.py` | Windows GUI quirks | PE subsystem=GUI checklist + create-no-window / stderr drain notes |
| `collect_bundle.py` | any | One-shot zip: snapshot + diagnostics + dumps (+ stacks/probes) |
| `smoke_selftest.py` | suite health | Synthetic diagnostics + import smoke |

Shared helpers live in `_common.py` (not a CLI).

## Crash vs hang — how to read results

**Crash (process death)**

- `capture_snapshot`: UI without sidecar, or both gone after repro
- `analyze_diagnostics`: `primary=crash` / `crash_suspect`; `engine.log` panic/abort; only `pre-solve` host snapshot and no `last-fault`
- `find_crash_dumps`: `.dmp` / `core` for `Holdem Study.exe` or `solver-engine.exe`
- Windows `0xc000001d`: illegal instruction → rebuild with `-Dcpu=x86_64_v2`

**Hang / freeze (process alive, UI stuck)**

- `ui-hang-events.json`: `status-poll-timeout` / `status-poll-hung` / `main-thread-stall`
- `watch_hang`: sidecar **idle** while UI alive → sample stacks (possible IPC deadlock)
- sidecar **hot** CPU → likely active train/compile; confirm with status iterations (`train_freeze_probe`)
- `ipc_probe` demux/status_budget failure → request demux or stdin stall
- Product rule: **one soft RPC timeout must not kill train**; hung path is consecutive status failures (threshold 3)

**Train looks frozen but is working**

- Status polls succeed and iterations advance → not a hang; UI may just be slow to paint
- Status polls all time out while process alive → real freeze / demux block

## IPC timeout budgets (reference)

From `desktop/src-tauri/src/solver_engine.rs` and Study JS:

| Op | Budget |
| --- | --- |
| `ready` | 8s |
| `status` (Rust) | 8s |
| status poll abort (JS) | 4s |
| default RPC (`values`, `node`, …) | 240s |
| `begin_config` | 600s |
| `solve` / `resolve_locked` | 2h ceiling |

## Suggested workflows

### A. Packaged Study froze mid-Solve (Windows)

1. Leave it frozen; run `capture_snapshot.py` and `stack_sample.py`.
2. Help → Copy diagnostics zip → `analyze_diagnostics.py --zip …`.
3. `collect_bundle.py --zip --stacks`.
4. If processes already dead: `find_crash_dumps.py` + `analyze_diagnostics.py`.

### B. Cloud / Linux engine dig (no UI)

1. `zig build -Dcpu=x86_64_v2`
2. `ipc_probe.py` then `train_freeze_probe.py`
3. Compare with `scripts/zig/stop-close-responsive-smoke.py` / `engine-crash-recovery-smoke.py`

### C. Blank console / closing console kills Study

1. `windows_sidecar_check.py --exe path\to\solver-engine.exe` (expect subsystem GUI=2)
2. Confirm stderr drain + `CREATE_NO_WINDOW` notes in checklist (do not “fix” by reintroducing a console)

## Related in-repo tooling

- `scripts/zig/*-smoke.py` — contract / recovery / overlap smokes (CI gate path)
- `scripts/zig/check-pe-subsystem.py` — PE subsystem assert
- `scripts/zig/check-no-avx512.py` — illegal-instruction guard
- Desktop Help diagnostics zip (ZR-160 / ZR-173)

## Design notes

- Prefer **external observation** first; avoid editing `solver_engine.rs`,
  `transport.ts`, or host dispatch unless a dig proves a product bug.
- Do not reintroduce HTTP fallthrough or `holdem-explorer`.
- Scripts are stdlib-first (Python 3.10+); `psutil` optional.

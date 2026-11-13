# Study crash & hang debug suite

Practical scripts for diagnosing **crashes** vs **hangs** in Holdem Study
(Tauri UI + Zig `solver-engine` typed IPC). They observe from outside the app —
no HTTP `:8765`, no `holdem-explorer`, no product-code hooks required.

**Primary audience:** the **Windows installed** (NSIS) build — persistent
crashes/hangs have been hard to root-cause there. Linux cloud probes still work
against a built `zig-out/bin/solver-engine` for engine-only digs.

## Windows installed Study (start here)

Evidence the packaged app already writes:

| Path | Contents |
| --- | --- |
| `%LOCALAPPDATA%\Holdem Study\diagnostics\` | `last-fault.json`, `ui-hang-events.json`, `last-solve.json`, `host-resources.json`, `engine.log`, `session-meta.json` |
| Help → **Copy diagnostics zip** | Same folder zipped (preferred for bug reports) |
| `%LOCALAPPDATA%\CrashDumps\` | Minidumps if LocalDumps is enabled (`Holdem Study.exe.*.dmp`, `solver-engine.exe.*.dmp`) |

Installed binaries (typical):

- `%LOCALAPPDATA%\…` is **data**; the exe usually lives under Program Files /
  the NSIS install dir next to `solver-engine.exe` (GUI subsystem, no console).

### While the app is frozen (do this first)

Leave Study open if possible — killing it loses stacks.

```powershell
# From a clone of this repo (Python 3.10+ on PATH)
cd path\to\poker-solver
python scripts\debug\capture_snapshot.py --out $env:TEMP\study-snap.json
python scripts\debug\stack_sample.py --out $env:TEMP\study-stacks.txt
python scripts\debug\collect_bundle.py --zip --stacks --out $env:TEMP\study-bundle
```

Or one shot:

```powershell
powershell -File scripts\debug\windows_collect.ps1
```

Then in Study: Help → **Copy diagnostics zip**, and:

```powershell
python scripts\debug\analyze_diagnostics.py --zip path\to\holdem-study-diagnostics.zip
python scripts\debug\find_crash_dumps.py --since-hours 48
python scripts\debug\windows_sidecar_check.py --exe "C:\Path\To\Install\solver-engine.exe"
```

### After a hard crash (app already gone)

1. Help is unavailable — open `%LOCALAPPDATA%\Holdem Study\diagnostics\` manually  
   or use the last diagnostics zip if you copied one earlier.
2. `analyze_diagnostics.py --dir "%LOCALAPPDATA%\Holdem Study\diagnostics"`
3. `find_crash_dumps.py` — if empty, enable LocalDumps (script prints the registry recipe) and repro once.
4. Check `last-solve.json` (`snapshotKind=pre-solve`) vs missing `last-fault.json` → died before fault write (classic hard crash).

### Windows-only failure modes this suite targets

| Symptom | Likely cause | Script / check |
| --- | --- | --- |
| Blank console; closing it kills Study | Console-subsystem sidecar | `windows_sidecar_check.py` (expect PE subsystem **GUI=2**) |
| Ready hang on spawn | stderr not drained | Checklist in `windows_sidecar_check.py` |
| `0xc000001d` | AVX-512 binary on older CPU | Rebuild/install with `-Dcpu=x86_64_v2` |
| Solve “stuck”, then Reconnect | Soft status timeouts → hung threshold (3) | `analyze_diagnostics` + `ui-hang-events.json` |
| UI frozen, sidecar still in Task Manager | IPC deadlock / main-thread stall | `capture_snapshot` + `stack_sample` + hang events |

Override diagnostics path: `$env:HOLDEM_STUDY_DIAGNOSTICS_DIR = "D:\copy\diagnostics"`.

Optional: `pip install psutil` for better CPU% on `capture_snapshot` / `watch_hang`.

## Quick start (any OS / engine-only)

```bash
python3 scripts/debug/smoke_selftest.py

# Live or offline triage
python3 scripts/debug/capture_snapshot.py
python3 scripts/debug/analyze_diagnostics.py
python3 scripts/debug/collect_bundle.py --zip --stacks

# Built sidecar (Linux cloud / local zig)
zig build -Dcpu=x86_64_v2
python3 scripts/debug/ipc_probe.py
python3 scripts/debug/train_freeze_probe.py
python3 scripts/debug/smoke_selftest.py --with-engine
```

On Windows you can point probes at the **installed** sidecar:

```powershell
python scripts\debug\ipc_probe.py --binary "C:\Path\To\Install\solver-engine.exe"
python scripts\debug\train_freeze_probe.py --binary "C:\Path\To\Install\solver-engine.exe"
```

## Scripts

| Script | Failure mode | What it does |
| --- | --- | --- |
| `capture_snapshot.py` | crash **or** hang | Process tree, RSS/CPU, orphan sidecar detection |
| `analyze_diagnostics.py` | crash **or** hang | Classifies app diagnostics / zip → crash vs hang |
| `watch_hang.py` | hang | Time-series CPU/RSS; alerts on idle sidecar / exit |
| `stack_sample.py` | hang (live) | Backtraces (eu-stack/gdb; Windows: cdb / ProcDump guidance) |
| `ipc_probe.py` | IPC timeout / demux | Spawns `solver-engine`; ready + request_id demux + status budget |
| `train_freeze_probe.py` | train freeze | `solve` then interleaved `status` — status must stay live |
| `find_crash_dumps.py` | crash | Windows LocalDumps / Linux cores |
| `windows_sidecar_check.py` | Windows GUI quirks | PE subsystem=GUI checklist + CREATE_NO_WINDOW / stderr drain |
| `windows_collect.ps1` | Windows install | One-shot snapshot + diagnostics analysis + dump search + zip |
| `collect_bundle.py` | any | Cross-platform evidence directory/zip |
| `smoke_selftest.py` | suite health | Synthetic diagnostics + import smoke |

Shared helpers: `_common.py` (not a CLI).

## Crash vs hang — how to read results

**Crash (process death)**

- `capture_snapshot`: UI without sidecar, or both gone after repro
- `analyze_diagnostics`: `primary=crash` / `crash_suspect`; `engine.log` panic/abort; only `pre-solve` host snapshot and no `last-fault`
- `find_crash_dumps`: `.dmp` for `Holdem Study.exe` or `solver-engine.exe`
- Windows `0xc000001d`: illegal instruction → `-Dcpu=x86_64_v2` install

**Hang / freeze (process alive, UI stuck)**

- `ui-hang-events.json`: `status-poll-timeout` / `status-poll-hung` / `main-thread-stall`
- `watch_hang`: sidecar **idle** while UI alive → sample stacks (possible IPC deadlock)
- sidecar **hot** CPU → likely active train/compile; confirm iterations via status
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

## Other workflows

### Cloud / Linux engine dig (no UI)

1. `zig build -Dcpu=x86_64_v2`
2. `ipc_probe.py` then `train_freeze_probe.py`
3. Compare with `scripts/zig/stop-close-responsive-smoke.py` / `engine-crash-recovery-smoke.py`

### Blank console / closing console kills Study

1. `windows_sidecar_check.py --exe path\to\solver-engine.exe` (expect subsystem GUI=2)
2. Do **not** “fix” by shipping a Console PE — that is the bug class (#290)

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

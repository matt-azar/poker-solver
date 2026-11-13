# Study crash & hang debug suite

Practical scripts for diagnosing **crashes** vs **hangs** in Holdem Study
(Tauri UI + Zig `solver-engine` typed IPC). They observe from outside the app —
no HTTP `:8765`, no `holdem-explorer`, no product-code hooks required.

**Primary audience:** the **Windows installed** (NSIS) build — persistent
crashes/hangs have been hard to root-cause there. Linux cloud probes still work
against a built `zig-out/bin/solver-engine` for engine-only digs.

---

## How Matt runs this on Windows

You need a **clone of this repo** (tooling only) and **Python 3.10+** on PATH.
The installed Study app stays in Program Files / the NSIS install dir — do **not**
copy the installed exe into the repo.

Diagnostics the app already writes live under
`%LOCALAPPDATA%\Holdem Study\diagnostics\`.

### One of these (pick a front door)

```powershell
# A) Mini-app (buttons for collect / analyze / dumps / sidecar / watch)
.\scripts\debug\study-debug.cmd

# B) Same thing via PowerShell
powershell -ExecutionPolicy Bypass -File .\scripts\debug\study-debug.ps1
```

### Or 4 CLI commands (while Study is frozen, leave it open)

```powershell
cd path\to\poker-solver

.\scripts\debug\study-debug.cmd collect
.\scripts\debug\study-debug.cmd analyze --zip $env:USERPROFILE\Desktop\holdem-study-diagnostics.zip
.\scripts\debug\study-debug.cmd dumps
.\scripts\debug\study-debug.cmd sidecar --exe "C:\Path\To\Install\solver-engine.exe"
```

`collect` with no extra flags means `--zip --stacks` (evidence bundle under `%TEMP%`).

Equivalent without the `.cmd` launcher:

```powershell
python scripts\debug\study_debug.py collect
python scripts\debug\study_debug.py gui
# or: set PYTHONPATH=scripts && python -m debug collect
```

Optional: `pip install psutil` for better CPU% on snapshot / watch.

---

## Send report (Windows → GitHub)

Uploads a diagnostics zip + analyze summary into the **poker-solver** repo as a
**GitHub Issue** (structured body). The zip is attached via a **secret gist**
by default (or a prerelease asset). Dumps are **not** committed to `main`.

### Authenticate once

Preferred (GitHub CLI on your machine):

```powershell
winget install GitHub.cli   # if needed
gh auth login -s repo,gist
gh auth status
```

Or set a PAT in the environment (**never commit the token**):

```powershell
# classic PAT: repo + gist scopes
# fine-grained: Issues (read/write) + Gists (read/write) on matt-azar/poker-solver
$env:HOLDEM_STUDY_GITHUB_TOKEN = "ghp_…"   # or GH_TOKEN
```

Optional override: `$env:HOLDEM_STUDY_GITHUB_REPO = "matt-azar/poker-solver"`.

### One-click / one-command

```powershell
cd path\to\poker-solver

# A) Mini-app → set Diagnostics zip → "Send report to GitHub"
.\scripts\debug\study-debug.cmd

# B) CLI after Help → Copy diagnostics zip
.\scripts\debug\study-debug.cmd send --zip $env:USERPROFILE\Desktop\holdem-study-diagnostics.zip

# C) Collect while frozen, then send that bundle
.\scripts\debug\study-debug.cmd send --collect --yes

# Dry-run (no GitHub calls) — good smoke check
.\scripts\debug\study-debug.cmd send --zip path\to\zip --dry-run
.\scripts\debug\study-debug.cmd send --auth-check
```

Privacy: bodies redact home / `%LOCALAPPDATA%` / username path segments where
possible, but **warn** before send — logs can still leak machine-local paths.

Attach modes: `--attach gist` (default), `--attach release` (rolling prerelease
`study-debug-reports`), or `--attach none` (issue text only; attach zip in the UI).

Optional Actions archive: add `--dispatch` to fire `repository_dispatch` type
`study-debug-report` (workflow `.github/workflows/study-debug-report.yml`
downloads the gist/release URL and stores a 90-day Actions artifact). Requires
`repo` scope that can dispatch workflows.

---

## Windows installed Study (details)

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
.\scripts\debug\study-debug.cmd collect
# or one-shot PowerShell helper:
powershell -File scripts\debug\windows_collect.ps1
```

Then in Study: Help → **Copy diagnostics zip**, and:

```powershell
.\scripts\debug\study-debug.cmd analyze --zip path\to\holdem-study-diagnostics.zip
.\scripts\debug\study-debug.cmd dumps --since-hours 48
.\scripts\debug\study-debug.cmd sidecar --exe "C:\Path\To\Install\solver-engine.exe"
```

### After a hard crash (app already gone)

1. Help is unavailable — open `%LOCALAPPDATA%\Holdem Study\diagnostics\` manually  
   or use the last diagnostics zip if you copied one earlier.
2. `study-debug.cmd analyze` (defaults to the LocalAppData diagnostics dir)  
   or `analyze --dir "%LOCALAPPDATA%\Holdem Study\diagnostics"`
3. `study-debug.cmd dumps` — if empty, enable LocalDumps (script prints the registry recipe) and repro once.
4. Check `last-solve.json` (`snapshotKind=pre-solve`) vs missing `last-fault.json` → died before fault write (classic hard crash).

### Windows-only failure modes this suite targets

| Symptom | Likely cause | Script / check |
| --- | --- | --- |
| Blank console; closing it kills Study | Console-subsystem sidecar | `sidecar` (expect PE subsystem **GUI=2**) |
| Ready hang on spawn | stderr not drained | Checklist in `windows_sidecar_check.py` |
| `0xc000001d` | AVX-512 binary on older CPU | Rebuild/install with `-Dcpu=x86_64_v2` |
| Solve “stuck”, then Reconnect | Soft status timeouts → hung threshold (3) | `analyze` + `ui-hang-events.json` |
| UI frozen, sidecar still in Task Manager | IPC deadlock / main-thread stall | `snapshot` + `stacks` + hang events |

Override diagnostics path: `$env:HOLDEM_STUDY_DIAGNOSTICS_DIR = "D:\copy\diagnostics"`.

---

## Front-door CLI reference

| Command | Wraps | Purpose |
| --- | --- | --- |
| `collect` | `collect_bundle.py` | Evidence dir/zip (default `--zip --stacks`) |
| `analyze` | `analyze_diagnostics.py` | Crash vs hang triage on dir or Help zip |
| `send` | `send_report.py` | Open GitHub Issue + attach zip (gist/release) |
| `dumps` | `find_crash_dumps.py` | LocalDumps / cores |
| `sidecar` | `windows_sidecar_check.py` | GUI PE / CREATE_NO_WINDOW checklist |
| `probe` | `ipc_probe.py` | Ready + demux + status budget |
| `freeze` | `train_freeze_probe.py` | Status live during solve |
| `watch` | `watch_hang.py` | Idle-sidecar / exit alerts |
| `snapshot` / `stacks` | matching scripts | Live process / backtraces |
| `gui` / `app` | `study_debug_app.py` | Mini-app window |
| `windows-collect` | `windows_collect.ps1` | One-shot Windows collect |
| `smoke` | `smoke_selftest.py` | Suite self-test |

Extra args after the subcommand are forwarded unchanged
(e.g. `study_debug.py analyze --json-only`).

---

## Quick start (any OS / engine-only)

```bash
python3 scripts/debug/study_debug.py smoke
# or legacy:
python3 scripts/debug/smoke_selftest.py

python3 scripts/debug/study_debug.py snapshot
python3 scripts/debug/study_debug.py analyze
python3 scripts/debug/study_debug.py collect --zip --stacks

zig build -Dcpu=x86_64_v2
python3 scripts/debug/study_debug.py probe
python3 scripts/debug/study_debug.py freeze
python3 scripts/debug/study_debug.py smoke --with-engine
```

On Windows you can point probes at the **installed** sidecar:

```powershell
.\scripts\debug\study-debug.cmd probe --binary "C:\Path\To\Install\solver-engine.exe"
.\scripts\debug\study-debug.cmd freeze --binary "C:\Path\To\Install\solver-engine.exe"
```

## Scripts

| Script | Failure mode | What it does |
| --- | --- | --- |
| `study_debug.py` | — | **Front door** CLI (subcommands above) |
| `study_debug_app.py` | — | Stdlib tkinter mini-app |
| `study-debug.cmd` / `.ps1` | — | Find Python + launch CLI/GUI |
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
| `send_report.py` | any | Issue + secret gist / release attach (no git commit) |
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
2. `study_debug.py probe` then `freeze`
3. Compare with `scripts/zig/stop-close-responsive-smoke.py` / `engine-crash-recovery-smoke.py`

### Blank console / closing console kills Study

1. `study_debug.py sidecar --exe path\to\solver-engine.exe` (expect subsystem GUI=2)
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
- Scripts are stdlib-first (Python 3.10+); `psutil` optional; mini-app needs tkinter
  (usually bundled with Python on Windows).

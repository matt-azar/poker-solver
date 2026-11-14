# Study crash & hang debug suite

Practical scripts for diagnosing **crashes** vs **hangs** in Holdem Study
(Tauri UI + Zig `solver-engine` typed IPC). They observe from outside the app —
no HTTP `:8765`, no `holdem-explorer`, no product-code hooks required.

**Primary audience:** the **Windows installed** (NSIS) build — persistent
crashes/hangs have been hard to root-cause there. Linux cloud probes still work
against a built `zig-out/bin/solver-engine` for engine-only digs.

---

## Windows capture loop (feed reports back to Cursor)

Goal: systematically capture runtime evidence from the **installed** Study build
and drop it into this Debugging Suite Project / Cursor chat — **minimal manual
steps**, no Cloudflare / `gh` auth.

You need a **clone** at e.g. `C:\Users\matta\poker-solver` (tooling only) and
**Python 3.10+** on PATH. Do **not** copy the installed exe into the repo.

### Automated path (preferred)

```powershell
cd C:\Users\matta\poker-solver
.\scripts\debug\study-debug-session.cmd
```

That single entrypoint:

1. Optionally `git pull --ff-only` when the clone is on `main`
2. Ensures LocalDumps (idempotent; elevates **once** only if needed)
3. Starts local receiver + hang watcher if not already healthy
4. Launches installed Study when found (Program Files / LOCALAPPDATA / registry;
   skip with `--no-launch-study` or set `HOLDEM_STUDY_EXE`)
5. Interactive keys: **C** = collect, **H** = handoff, **O** = open folder,
   **G** = mini-app, **Q** = quit (receiver keeps running)

On freeze/crash (or on demand):

```powershell
.\scripts\debug\study-debug-session.cmd collect
# or press C in the session window
```

Collect writes under `%LOCALAPPDATA%\Holdem Study\debug-reports\` and stages:

| Path | Purpose |
| --- | --- |
| `debug-reports\<stamp>_session-collect\` | Full bundle (zip + snapshot + stacks + diary) |
| `debug-reports\CURSOR_DROP\CURSOR_HANDOFF.md` | Short summary to **paste/drag into Cursor** |
| `debug-reports\CURSOR_DROP\latest-report\` | Junction to the latest report folder |
| `debug-reports\CURSOR_DROP\LATEST.txt` | Absolute path pointer |

Explorer opens the report + `CURSOR_DROP` automatically. Drag
`CURSOR_HANDOFF.md` or `latest-report\` into Cursor / this Project.

```powershell
.\scripts\debug\study-debug-session.cmd handoff   # re-stage latest without re-collect
.\scripts\debug\study-debug-session.cmd status
```

### Set and forget (login)

Start receiver + hang watcher with Windows login (disk intake only; no Cloudflare):

```powershell
cd C:\Users\matta\poker-solver
# Startup folder shortcut (simplest):
.\scripts\debug\study-debug-session.cmd install-startup

# Or Task Scheduler at logon:
.\scripts\debug\study-debug-session.cmd install-startup --method schtasks

# Optional: also launch Study at login
.\scripts\debug\study-debug-session.cmd install-startup --with-study

# Remove:
.\scripts\debug\study-debug-session.cmd install-startup --remove
.\scripts\debug\study-debug-session.cmd install-startup --method schtasks --remove
```

Startup uses `--background` (no interactive menu / UAC dump prompt). Enable
LocalDumps once interactively first (`enable-dumps` or a normal session start).

### Notify without secrets (optional)

Safe, no-auth options already covered by the drop folder:

- **Disk + Explorer** (default) — drag into Cursor
- Desktop shortcut to `CURSOR_DROP` (create manually if you want)
- Do **not** put webhook secrets in chat; local receiver secret stays under
  `%LOCALAPPDATA%\Holdem Study\local-receiver-secret.txt`

Cloudflare Worker / `gh` remain optional for remote GitHub Issues — not required
for this Project loop.

### Manual / lower-level front doors

```powershell
# A) Receiver + hang watcher + mini-app (no session menu)
.\scripts\debug\study-debug-local.cmd

# B) Mini-app only
.\scripts\debug\study-debug.cmd

# C) PowerShell session launcher
powershell -ExecutionPolicy Bypass -File .\scripts\debug\study-debug-session.ps1
```

Once per machine if you skip the session launcher:

```powershell
.\scripts\debug\study-debug.cmd enable-dumps   # elevated; LocalDumps for Study + solver-engine
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

## Send report (Windows → local disk or GitHub)

Uploads a diagnostics zip + analyze summary. Preferred on Windows without
Cloudflare: **local Python receiver** saves the zip to disk. Optional: open a
GitHub Issue (Worker, local receiver + token, or `gh` on the PC). Dumps are
**not** committed to `main`.

### Preferred: session / local receiver (no Cloudflare, no `gh`)

```powershell
cd C:\Users\matta\poker-solver
.\scripts\debug\study-debug-session.cmd          # automated (preferred)
# or: .\scripts\debug\study-debug-local.cmd      # receiver + mini-app only
# leave tools running; use installed Study as usual
# then: press C / session collect, or mini-app → Send report
```

Reports land in `%LOCALAPPDATA%\Holdem Study\debug-reports\` (zip + issue body +
analysis + `CURSOR_DROP\`). The launcher writes
`%USERPROFILE%\.holdem-study\report-webhook.json` for the session. Details:
[`report-receiver/README.md`](report-receiver/README.md).

### Optional remote webhook (Cloudflare Worker)

If you later want always-on intake without keeping a local window open, deploy
the Worker once (see report-receiver README) and set:

```powershell
[System.Environment]::SetEnvironmentVariable(
  "HOLDEM_STUDY_REPORT_WEBHOOK_URL",
  "https://holdem-study-report-receiver.<you>.workers.dev/report",
  "User")
[System.Environment]::SetEnvironmentVariable(
  "HOLDEM_STUDY_REPORT_WEBHOOK_SECRET",
  "<same REPORT_SHARED_SECRET as the server>",
  "User")
```

### Fallback: local GitHub CLI / PAT

```powershell
winget install GitHub.cli   # if needed
gh auth login -s repo,gist
gh auth status
# or: $env:HOLDEM_STUDY_GITHUB_TOKEN = "ghp_…"   # never commit
```

Force local path even when a webhook URL is set: `send --local-gh`.

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

# Dry-run (no GitHub / webhook calls) — good smoke check
.\scripts\debug\study-debug.cmd send --zip path\to\zip --dry-run
.\scripts\debug\study-debug.cmd send --auth-check
```

Privacy: bodies redact home / `%LOCALAPPDATA%` / username path segments where
possible, but **warn** before send — logs can still leak machine-local paths.

Attach modes (local-gh): `--attach gist` (default), `--attach release` (rolling
prerelease `study-debug-reports`), or `--attach none`. Webhook path uses release
assets on the server (binary-safe).

Optional Actions archive (local-gh only): add `--dispatch` to fire
`repository_dispatch` type `study-debug-report` (workflow
`.github/workflows/study-debug-report.yml`).

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
| `session` | `study_debug_session.py` | **Automated** capture loop + CURSOR_DROP handoff |
| `collect` | `collect_bundle.py` | Evidence dir/zip (default `--zip --stacks`) |
| `analyze` | `analyze_diagnostics.py` | Crash vs hang triage on dir or Help zip |
| `send` | `send_report.py` | Local/webhook/gh → disk and/or GitHub Issue |
| `local-debug` | `start_local_debug.py` | Start localhost receiver + hang watcher + mini-app |
| `enable-dumps` | `enable_local_dumps.ps1` | One-shot LocalDumps for Study + solver-engine |
| `diary` | `repro_diary.py` | Create / prompt a repro diary |
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
| `send_report.py` | any | Webhook POST or local Issue + gist/release (no git commit) |
| `start_local_debug.py` | any | Local disk receiver + hang watcher launcher |
| `study_debug_session.py` | Windows | Automated session: dumps + receiver + collect + CURSOR_DROP |
| `study-debug-session.cmd` / `.ps1` | Windows | **Preferred** double-click / Startup entrypoint |
| `study-debug-local.cmd` / `.ps1` | Windows | Double-click local debug launcher |
| `enable_local_dumps.ps1` | Windows | One-shot LocalDumps registry (admin) |
| `repro_diary.py` / `repro_diary_template.md` | any | Repro diary for collect/send |
| `report-receiver/` | any | Intake (local-disk / CF Worker / Python); optional GitHub PAT |
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

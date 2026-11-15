# IPC race / bug-case replays

Small, declarative cases for the **IPC layer**. Each JSON file keeps **input**,
**action sequence**, **expected result**, and optional **build_sha** together
so reproduction is one command.

## Pass bar (Track 1)

Windows CI must run the existing controllable test-sidecar probe and pass when:

**Status and Cancel complete while EV (`values`) is withheld.**

That is `values-hold-status-cancel.json`. Longer flop/memory benchmarks stay
in their own jobs. **UI A→B stale-EV** (navigate away while EV pending; delayed
reply for A must not replace B) is **not** this track — browser/Playwright owns
it (see project plan Track 3).

## One command

```sh
# CI / pass-bar case
python scripts/desktop/ipc_race_replay.py \
  scripts/desktop/ipc-race-cases/values-hold-status-cancel.json

# Or every non-example test-sidecar case under this directory
python scripts/desktop/ipc_race_replay.py --all --filter-sidecar test

# Real engine failure: pin SHA + fixture + actions
python scripts/desktop/ipc_race_replay.py path/to/engine-case.json --require-sha
```

Windows (PowerShell):

```powershell
.\scripts\desktop\ipc-race-replay.ps1 -All
.\scripts\desktop\ipc-race-replay.ps1 -Case scripts\desktop\ipc-race-cases\values-hold-status-cancel.json
```

Build the controllable sidecar first (CI does this):

```sh
cargo build --release --manifest-path desktop/ipc-test-sidecar/Cargo.toml
```

The Python fallback `scripts/desktop/ipc_test_sidecar.py` works when the Rust
binary is missing.

## Case kinds

| `sidecar` | Binary | Use |
| --- | --- | --- |
| `test` | `ipc-test-sidecar` | Quick withhold / control-path races (CI) |
| `engine` | `solver-engine` | Real engine failures; set `build_sha` + `input.config` |

Engine cases should set `build_sha` to the commit that produced the failure and
pass `--require-sha` so the tree matches before replaying.

## Shipped cases

| File | Role |
| --- | --- |
| `values-hold-status-cancel.json` | **Pass bar** — Status + Cancel while first `values` withheld |
| `engine-case.example.json` | Template only (skipped by `--all`); copy + fill `build_sha` |

## Out of this job

- Flop / memory / Accuracy benchmarks
- UI stale-EV after node navigation (browser track)

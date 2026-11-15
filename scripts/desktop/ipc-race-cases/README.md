# IPC race / bug-case replays

Small, declarative cases for recurring IPC/UI races. Each JSON file keeps
**input**, **action sequence**, **expected result**, and optional **build_sha**
together so reproduction is one command.

## One command

```sh
# All quick test-sidecar cases (what Windows CI runs)
python scripts/desktop/ipc_race_replay.py --all --filter-sidecar test

# One case
python scripts/desktop/ipc_race_replay.py \
  scripts/desktop/ipc-race-cases/node-switch-while-ev-pending.json

# Real engine failure: pin SHA + fixture + actions
python scripts/desktop/ipc_race_replay.py path/to/engine-case.json --require-sha
```

Windows (PowerShell):

```powershell
.\scripts\desktop\ipc-race-replay.ps1 -All
.\scripts\desktop\ipc-race-replay.ps1 -Case scripts\desktop\ipc-race-cases\node-switch-while-ev-pending.json
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
| `test` | `ipc-test-sidecar` | Quick demux / withhold races (CI) |
| `engine` | `solver-engine` | Real engine failures; set `build_sha` + `input.config` |

Engine cases should set `build_sha` to the commit that produced the failure and
pass `--require-sha` so the tree matches before replaying.

## Shipped cases

| File | Race |
| --- | --- |
| `values-hold-status-cancel.json` | Existing probe: Status + Cancel while first `values` withheld |
| `node-switch-while-ev-pending.json` | Switch nodes while EV pending; later `request_id` demuxes |

## Not in this job

Longer flop / memory / Accuracy benchmarks stay in their own scripts and CI
jobs. Do not fold them into these quick probes.

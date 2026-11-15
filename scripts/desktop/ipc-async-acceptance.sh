#!/usr/bin/env bash
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
# Linux harness for the connection-supervisor concurrency gate.
# Full WebView → Tauri → pipe gate is Windows-packaged (ipc-async-acceptance.ps1).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SIDECAR="$ROOT/desktop/ipc-test-sidecar"
TAURI="$ROOT/desktop/src-tauri"

echo "==> Building ipc-test-sidecar"
(cd "$SIDECAR" && cargo build)

echo "==> Supervisor concurrency test (status+cancel while values withheld)"
(cd "$TAURI" && cargo test --lib status_and_cancel_complete_while_values_held -- --nocapture)

echo "PASS: Rust supervisor concurrency"

echo "==> Declarative IPC race cases (test sidecar)"
python3 "$ROOT/scripts/desktop/ipc_race_replay.py" --all --filter-sidecar test

echo "PASS: IPC race cases"
echo "Windows CI: .github/workflows/ipc-race-probes.yml"
echo "Windows WebView gate: scripts/desktop/ipc-async-acceptance.ps1 -StudyExe <Holdem Study.exe>"

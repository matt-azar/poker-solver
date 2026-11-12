# Sidecar binaries

Tauri `bundle.externalBin` lists:

| Entry | Product role |
| --- | --- |
| `binaries/holdem-explorer` | Shipping C++ HTTP explorer (default Study path) |
| `binaries/solver-engine` | Zig typed-IPC tech-preview (`solver-engine` / `.exe`) |

Default Study still speaks HTTP to `holdem-explorer`. Zig cutover uses inherited-pipe IPC to `solver-engine` (protocol 2).

## Naming (required by Tauri)

CI (or a local pack script) must copy the built C++ `explorer` executable into
this directory using the **target triple** suffix:

| Platform | File name |
| --- | --- |
| Windows MSVC | `holdem-explorer-x86_64-pc-windows-msvc.exe` |
| Linux GNU | `holdem-explorer-x86_64-unknown-linux-gnu` |
| macOS Intel | `holdem-explorer-x86_64-apple-darwin` |
| macOS ARM | `holdem-explorer-aarch64-apple-darwin` |

At runtime / in the NSIS payload the sidecar is exposed as `holdem-explorer.exe`
beside the app (basename of `binaries/holdem-explorer`).

**Spawn footgun:** `shell().sidecar("binaries/holdem-explorer")` resolves to
`<exe_dir>/binaries/holdem-explorer.exe`, which does **not** exist after install.
The shell always spawns the absolute path beside the app (or
`sidecar("holdem-explorer")` as a fallback).

The Windows Installer workflow builds `explorer` with the **static MSVC CRT**
(`CMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded`) so end users do not need a separate
Visual C++ Redistributable. NSIS POSTINSTALL verifies this file exists and runs
`Unblock-File` on the UI and engine exes.

## Source binary

Build the C++ `explorer` target from the repo root, then:

```bash
# Example (Windows CI)
cp path/to/explorer.exe \
  desktop/src-tauri/binaries/holdem-explorer-x86_64-pc-windows-msvc.exe
```

Do not commit large binaries here; `.gitkeep` only reserves the folder.
The packaged Study UI does not assume port 8765. `ensure_engine` allocates a
loopback port, spawns this sidecar with `--launch-id` and `--study-packaged`,
and returns after `GET /api/ready` matches protocol 1 and that launch id.
Browser development still uses an explorer on port 8765.

## Zig `solver-engine` (Phase 6 tech-preview)

```bash
zig build
# Linux example — rename with target triple for Tauri externalBin:
cp zig-out/bin/solver-engine \
  desktop/src-tauri/binaries/solver-engine-x86_64-unknown-linux-gnu
```

At runtime the basename is `solver-engine[.exe]` beside the app. Framing:
little-endian `u32` length + JSON envelope (`desktop/src/engine/ipcProtocol.ts`).
Logs go to stderr; do not mix into the frame stream.

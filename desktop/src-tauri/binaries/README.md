# Sidecar binaries

Tauri `bundle.externalBin` lists:

| Entry | Product role |
| --- | --- |
| `binaries/solver-engine` | Zig typed-IPC Study sidecar (`solver-engine` / `.exe`) |

Packaged Study uses inherited-pipe IPC to `solver-engine` (protocol 2) only.
HTTP `holdem-explorer` is not shipped after the Zig cutover (owner GO 2026-11-12).
Browser / Vite-dev can still talk to a separately started explorer process.

## Naming (required by Tauri)

CI (or a local pack script) must copy the built Zig `solver-engine` executable
into this directory using the **target triple** suffix:

| Platform | File name |
| --- | --- |
| Windows MSVC | `solver-engine-x86_64-pc-windows-msvc.exe` |
| Linux GNU | `solver-engine-x86_64-unknown-linux-gnu` |
| macOS Intel | `solver-engine-x86_64-apple-darwin` |
| macOS ARM | `solver-engine-aarch64-apple-darwin` |

At runtime / in the NSIS payload the sidecar is exposed as `solver-engine.exe`
beside the app (basename of `binaries/solver-engine`).

**Spawn footgun:** `shell().sidecar("binaries/solver-engine")` resolves to
`<exe_dir>/binaries/solver-engine.exe`, which does **not** exist after install.
The shell always spawns the absolute path beside the app (or
`sidecar("solver-engine")` as a fallback).

## Source binary

```bash
zig build -Doptimize=ReleaseFast
# Windows CI example:
cp zig-out/bin/solver-engine.exe \
  desktop/src-tauri/binaries/solver-engine-x86_64-pc-windows-msvc.exe
```

Do not commit large binaries here; `.gitkeep` only reserves the folder.

Framing: little-endian `u32` length + JSON envelope
(`desktop/src/engine/ipcProtocol.ts`). Logs go to stderr; do not mix into the
frame stream.

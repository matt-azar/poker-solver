# Holdem-explorer sidecar binaries

Tauri `bundle.externalBin` is configured as `binaries/holdem-explorer`
(not `explorer`, to avoid colliding with Windows File Explorer).

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
The Study UI talks to `http://127.0.0.1:8765` on this process. The Tauri shell
command `ensure_engine` spawns the sidecar and waits until that port accepts TCP.

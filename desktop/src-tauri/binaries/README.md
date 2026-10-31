# Explorer sidecar binaries

Tauri `bundle.externalBin` is configured as `binaries/explorer`.

## Naming (required by Tauri)

CI (or a local pack script) must copy the built explorer executable into this
directory using the **target triple** suffix:

| Platform | File name |
| --- | --- |
| Windows MSVC | `explorer-x86_64-pc-windows-msvc.exe` |
| Linux GNU | `explorer-x86_64-unknown-linux-gnu` |
| macOS Intel | `explorer-x86_64-apple-darwin` |
| macOS ARM | `explorer-aarch64-apple-darwin` |

At runtime / in the NSIS payload the sidecar is exposed as `explorer` /
`explorer.exe` beside the app (basename of `binaries/explorer`).

## Source binary

Build the C++ `explorer` target from the repo root, then:

```bash
# Example (Windows CI)
cp path/to/explorer.exe \
  desktop/src-tauri/binaries/explorer-x86_64-pc-windows-msvc.exe
```

Do not commit large binaries here; `.gitkeep` only reserves the folder.
The Vite UI in `desktop/dist` talks to `http://127.0.0.1:8765` on this process.

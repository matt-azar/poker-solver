# Explorer HTTP API (retired)

**Status on `main`:** the C++ `holdem-explorer` HTTP server (`:8765`) is **removed**. Packaged and Tauri Study use the Zig `solver-engine` sidecar over typed IPC (protocol 2, inherited pipes). There is no dual-sidecar / HTTP fallback shipping path.

For the live Study workstation and Windows packaging, see [DESKTOP_UI.md](DESKTOP_UI.md).

Historical API detail that lived in this file described the deleted C++ explorer process (`GET /api/ready` protocol 1, `/api/solve`, `/api/values`, static `desktop/dist` / `legacy/ui` serving, etc.). That surface is not a product path on this branch. Archaeology: [auxiliary/notes/PROJECT_HISTORY.md](auxiliary/notes/PROJECT_HISTORY.md).

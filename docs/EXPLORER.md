# Engine IPC

Study calls `solver-engine` over protocol 2. A frame is a little-endian `u32` length plus a UTF-8 JSON object. The process reads stdin and writes stdout. Logs go to stderr. The argument is `--launch-id`.

Host code: `host/src/ipc.zig`, `host/src/dispatch.zig`, `host/src/main.zig`.

The Tauri shell encodes the same frames in `desktop/src-tauri/src/solver_engine.rs`. The web client calls `solver_engine_request` from `desktop/src/engine/client.ts`.

Operations, the desktop map, and Windows packaging are in [DESKTOP_UI.md](DESKTOP_UI.md).

# Engine IPC

Study calls `solver-engine` over protocol 2. A frame is a little-endian `u32` length plus a UTF-8 JSON object. The process reads stdin and writes stdout. Logs go to stderr. The argument is `--launch-id`.

The JSON body after the length prefix is at most 16 MiB (`max_payload_bytes` in `host/src/ipc.zig`). The Zig host and the desktop Rust framer reject a larger frame on read and on encode. `holdem-study-cli` and the river-beta Python reader still accept up to 64 MiB. Shared fixtures under `host/testdata/ipc/` use the 16 MiB ceiling. JSON strings may be raw UTF-8 or `\u` escapes, including surrogate pairs. Both forms decode to the same text.

`node`, `values`, `equity`, `categories`, `line_card_report`, and `value_bluffs_post_call` run on one persistent analysis worker. Each metric has its own generation. A newer request supersedes only that metric. The queue prefers `node`, then values and equity, then categories, then reports. Identical queued work for the same solution, policy revision, node, and metric is coalesced. A full queue (8) drops the lowest-priority queued task.

Build, Open, Save, Solve, Continue, Resolve locked, and synchronous lock and strategy edits share one exclusive mutation gate. Status, cancel, and pause stay available while that gate is held.

Parent stdin EOF requests stop, supersedes in-flight analysis and preview, joins Save/Open and the other owned workers, then requests stop again so teardown cannot clear the stop latch.

Host code: `host/src/ipc.zig`, `host/src/dispatch.zig`, `host/src/main.zig`.

The Tauri shell encodes the same frames in `desktop/src-tauri/src/solver_engine.rs`. The web client calls `solver_engine_request` from `desktop/src/engine/client.ts`.

Operations, the desktop map, and Windows packaging are in [DESKTOP_UI.md](DESKTOP_UI.md).

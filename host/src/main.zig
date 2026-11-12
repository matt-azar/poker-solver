//! Desktop host stub. Phase 6 ships the `solver-engine` sidecar (D11) with
//! typed IPC over inherited pipes (D1). IPC stays outside the engine.
const poker_app = @import("poker_app");
const poker_engine = @import("poker_engine");
const poker_formats = @import("poker_formats");

pub const sidecar_name = "solver-engine";
pub const phase = "phase-6";

pub fn linkedLayers() []const []const u8 {
    _ = poker_app;
    _ = poker_engine;
    _ = poker_formats;
    return &.{ "poker_engine", "poker_app", "poker_formats" };
}

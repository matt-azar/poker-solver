//! Application layer: jobs, admission, policy publication — Phase 5.
const std = @import("std");
const poker_engine = @import("poker_engine");

pub const phase = "phase-5";

/// Placeholder so the module links against the engine in Phase 1.
pub fn engineModuleName() []const u8 {
    _ = poker_engine;
    return "poker_engine";
}

test "app stub links engine" {
    try std.testing.expectEqualStrings("poker_engine", engineModuleName());
}

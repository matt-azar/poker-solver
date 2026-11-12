//! poker_engine — Zig postflop engine (Phase 1: primitives + StreetSpec parse).
const std = @import("std");

pub const poker = @import("poker/root.zig");
pub const game = @import("game/root.zig");
pub const kernel = @import("kernel/root.zig");
pub const solve = @import("solve/root.zig");
pub const analysis = @import("analysis/root.zig");

test {
    std.testing.refAllDeclsRecursive(@This());
}

//! `.psol` v4 codec — Phase 5. Legacy checkpoints and kind=2 are rejected (D5/D6).
const std = @import("std");
const poker_engine = @import("poker_engine");

pub const phase = "phase-5";
pub const psol_version: u32 = 4;

pub const OpenError = error{
    LegacyCheckpointRejected,
    Kind2RiverRejected,
    UnsupportedFormat,
};

/// Locked policy: no import path for pre-v4 `.psol` or kind=2 river files.
pub fn rejectLegacyCheckpoint() OpenError!void {
    _ = poker_engine;
    return error.LegacyCheckpointRejected;
}

test "formats stub rejects legacy" {
    try std.testing.expectError(error.LegacyCheckpointRejected, rejectLegacyCheckpoint());
}

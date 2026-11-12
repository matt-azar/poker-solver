//! `.psol` v4 codec — Phase 5. Legacy checkpoints and kind=2 are rejected (D5/D6).
const std = @import("std");

pub const psol_v4 = @import("psol_v4.zig");
pub const phase = "phase-5";
pub const psol_version = psol_v4.version;

pub const OpenError = psol_v4.OpenError;
pub const Document = psol_v4.Document;
pub const Metrics = psol_v4.Metrics;

pub const encode = psol_v4.encode;
pub const decode = psol_v4.decode;
pub const writeFile = psol_v4.writeFile;
pub const readFile = psol_v4.readFile;

test {
    _ = psol_v4;
}

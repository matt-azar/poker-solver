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
pub const SaveFault = psol_v4.SaveFault;
pub const writeFile = psol_v4.writeFile;
pub const writeFileInjected = psol_v4.writeFileInjected;
pub const readFile = psol_v4.readFile;
pub const peekConfigText = psol_v4.peekConfigText;
pub const encodedFileBytes = psol_v4.encodedFileBytes;
pub const max_psol_bytes = psol_v4.max_psol_bytes;
pub const stream_chunk_bytes = psol_v4.stream_chunk_bytes;

test {
    _ = psol_v4;
}

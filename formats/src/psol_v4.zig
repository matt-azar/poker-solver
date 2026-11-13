const std = @import("std");
const builtin = @import("builtin");
const poker_engine = @import("poker_engine");

pub const version: u32 = 4;
pub const magic = "PSOL";
pub const header_bytes: usize = 32;

pub const flag_training: u32 = 1 << 0;
pub const flag_overlays: u32 = 1 << 1;
pub const flag_metrics: u32 = 1 << 2;

pub const algorithm_cfr_plus: u8 = 1;

pub const OpenError = error{
    LegacyCheckpointRejected,
    Kind2RiverRejected,
    UnsupportedFormat,
    InvalidPsol,
    OutOfMemory,
};

pub const Metrics = struct {
    value: f64 = 0,
    br0: f64 = 0,
    br1: f64 = 0,
    nash_gap: f64 = 0,
    accuracy: f64 = 0,
};

/// In-memory v4 document. Overlays are separate from policy/trainer (D7).
pub const Document = struct {
    allocator: std.mem.Allocator,
    algorithm: u8 = algorithm_cfr_plus,
    frozen: bool = false,
    config_text: []u8 = &.{},
    oop_combos: []i32 = &.{},
    ip_combos: []i32 = &.{},
    /// Per-slot action arity (logical index; matches CompiledGame.slots order).
    slot_actions: []u16 = &.{},
    /// Browsable average strategy (table_entries).
    average: []f32 = &.{},
    /// Optional exact-continue tables.
    trained: i32 = 0,
    regret: []f32 = &.{},
    strategy_sum: []f32 = &.{},
    /// Separate overlay persistence (D7).
    locks_text: []u8 = &.{},
    strategy_edits_text: []u8 = &.{},
    metrics: Metrics = .{},
    has_metrics: bool = false,
    /// True when the v4 `flag_training` bit is set (may have empty tables on
    /// degenerate check-only trees). Distinct from browse-only documents.
    has_training_flag: bool = false,

    pub fn deinit(self: *Document) void {
        freeSlice(self.allocator, self.config_text);
        freeSlice(self.allocator, self.oop_combos);
        freeSlice(self.allocator, self.ip_combos);
        freeSlice(self.allocator, self.slot_actions);
        freeSlice(self.allocator, self.average);
        freeSlice(self.allocator, self.regret);
        freeSlice(self.allocator, self.strategy_sum);
        freeSlice(self.allocator, self.locks_text);
        freeSlice(self.allocator, self.strategy_edits_text);
        self.* = .{ .allocator = self.allocator };
    }

    pub fn hasTraining(self: Document) bool {
        return self.has_training_flag or self.regret.len != 0 or self.strategy_sum.len != 0;
    }

    pub fn hasOverlays(self: Document) bool {
        return self.locks_text.len != 0 or self.strategy_edits_text.len != 0;
    }
};

fn freeSlice(allocator: std.mem.Allocator, slice: anytype) void {
    if (slice.len != 0) allocator.free(slice);
}

fn fnv1a64(payload: []const u8) u64 {
    var hash: u64 = 0xcbf29ce484222325;
    for (payload) |b| {
        hash ^= b;
        hash *%= 0x100000001b3;
    }
    return hash;
}

const Writer = struct {
    list: std.ArrayList(u8),

    fn init(allocator: std.mem.Allocator) Writer {
        return .{ .list = std.ArrayList(u8).init(allocator) };
    }

    fn deinit(self: *Writer) void {
        self.list.deinit();
    }

    fn bytes(self: *Writer) []u8 {
        return self.list.items;
    }

    fn u8w(self: *Writer, value: u8) OpenError!void {
        self.list.append(value) catch return error.OutOfMemory;
    }

    fn u16w(self: *Writer, value: u16) OpenError!void {
        var buf: [2]u8 = undefined;
        std.mem.writeInt(u16, &buf, value, .little);
        self.list.appendSlice(&buf) catch return error.OutOfMemory;
    }

    fn u32w(self: *Writer, value: u32) OpenError!void {
        var buf: [4]u8 = undefined;
        std.mem.writeInt(u32, &buf, value, .little);
        self.list.appendSlice(&buf) catch return error.OutOfMemory;
    }

    fn i32w(self: *Writer, value: i32) OpenError!void {
        try self.u32w(@bitCast(value));
    }

    fn f32w(self: *Writer, value: f32) OpenError!void {
        try self.u32w(@bitCast(value));
    }

    fn f64w(self: *Writer, value: f64) OpenError!void {
        var buf: [8]u8 = undefined;
        std.mem.writeInt(u64, &buf, @bitCast(value), .little);
        self.list.appendSlice(&buf) catch return error.OutOfMemory;
    }

    fn text(self: *Writer, value: []const u8) OpenError!void {
        if (value.len > std.math.maxInt(u32)) return error.InvalidPsol;
        try self.u32w(@intCast(value.len));
        self.list.appendSlice(value) catch return error.OutOfMemory;
    }

    fn i32s(self: *Writer, values: []const i32) OpenError!void {
        if (values.len > std.math.maxInt(u32)) return error.InvalidPsol;
        try self.u32w(@intCast(values.len));
        for (values) |v| try self.i32w(v);
    }

    fn u16s(self: *Writer, values: []const u16) OpenError!void {
        if (values.len > std.math.maxInt(u32)) return error.InvalidPsol;
        try self.u32w(@intCast(values.len));
        for (values) |v| try self.u16w(v);
    }

    fn f32s(self: *Writer, values: []const f32) OpenError!void {
        if (values.len > std.math.maxInt(u32)) return error.InvalidPsol;
        try self.u32w(@intCast(values.len));
        for (values) |v| try self.f32w(v);
    }
};

const Reader = struct {
    data: []const u8,
    at: usize = 0,

    fn remaining(self: Reader) usize {
        return self.data.len - self.at;
    }

    fn need(self: *Reader, n: usize) OpenError!void {
        if (self.remaining() < n) return error.InvalidPsol;
        // Positive space: after accept, the requested span is inside the payload.
        std.debug.assert(self.at + n <= self.data.len);
    }

    /// Reject oversized counts before allocating: count × elem_size must fit in remaining bytes.
    fn needCount(self: *Reader, count: usize, elem_size: usize) OpenError!void {
        // Programmer invariant: callers pass a real element width (never 0).
        std.debug.assert(elem_size > 0);
        const nbytes = std.math.mul(usize, count, elem_size) catch return error.InvalidPsol;
        try self.need(nbytes);
        // Pair with encode length writes: accepted count must fit remaining bytes.
        std.debug.assert(self.remaining() >= nbytes);
    }

    fn u8r(self: *Reader) OpenError!u8 {
        try self.need(1);
        const v = self.data[self.at];
        self.at += 1;
        return v;
    }

    fn u16r(self: *Reader) OpenError!u16 {
        try self.need(2);
        const v = std.mem.readInt(u16, self.data[self.at..][0..2], .little);
        self.at += 2;
        return v;
    }

    fn u32r(self: *Reader) OpenError!u32 {
        try self.need(4);
        const v = std.mem.readInt(u32, self.data[self.at..][0..4], .little);
        self.at += 4;
        return v;
    }

    fn i32r(self: *Reader) OpenError!i32 {
        return @bitCast(try self.u32r());
    }

    fn f32r(self: *Reader) OpenError!f32 {
        return @bitCast(try self.u32r());
    }

    fn f64r(self: *Reader) OpenError!f64 {
        try self.need(8);
        const v: f64 = @bitCast(std.mem.readInt(u64, self.data[self.at..][0..8], .little));
        self.at += 8;
        return v;
    }

    fn text(self: *Reader, allocator: std.mem.Allocator) OpenError![]u8 {
        const len = try self.u32r();
        try self.needCount(len, 1);
        const out = allocator.dupe(u8, self.data[self.at .. self.at + len]) catch return error.OutOfMemory;
        self.at += len;
        return out;
    }

    fn i32s(self: *Reader, allocator: std.mem.Allocator) OpenError![]i32 {
        const len = try self.u32r();
        try self.needCount(len, @sizeOf(i32));
        var out = allocator.alloc(i32, len) catch return error.OutOfMemory;
        errdefer allocator.free(out);
        var i: usize = 0;
        while (i < len) : (i += 1) out[i] = try self.i32r();
        return out;
    }

    fn u16s(self: *Reader, allocator: std.mem.Allocator) OpenError![]u16 {
        const len = try self.u32r();
        try self.needCount(len, @sizeOf(u16));
        var out = allocator.alloc(u16, len) catch return error.OutOfMemory;
        errdefer allocator.free(out);
        var i: usize = 0;
        while (i < len) : (i += 1) out[i] = try self.u16r();
        return out;
    }

    fn f32s(self: *Reader, allocator: std.mem.Allocator) OpenError![]f32 {
        const len = try self.u32r();
        try self.needCount(len, @sizeOf(f32));
        var out = allocator.alloc(f32, len) catch return error.OutOfMemory;
        errdefer allocator.free(out);
        var i: usize = 0;
        while (i < len) : (i += 1) out[i] = try self.f32r();
        return out;
    }
};

fn writeHeader(buf: *[header_bytes]u8, flags: u32, payload_len: u64, checksum: u64) void {
    @memcpy(buf[0..4], magic);
    std.mem.writeInt(u32, buf[4..8], version, .little);
    std.mem.writeInt(u32, buf[8..12], flags, .little);
    std.mem.writeInt(u64, buf[12..20], payload_len, .little);
    std.mem.writeInt(u64, buf[20..28], checksum, .little);
    std.mem.writeInt(u32, buf[28..32], 0, .little);
}

/// Encode a v4 document to bytes (header + payload).
pub fn encode(allocator: std.mem.Allocator, document: Document) OpenError![]u8 {
    if (document.algorithm != algorithm_cfr_plus) return error.InvalidPsol;
    if (document.config_text.len == 0) return error.InvalidPsol;
    if (document.average.len == 0 and document.slot_actions.len != 0) return error.InvalidPsol;
    // Positive space after soft rejects (paired with decode dimension pins).
    std.debug.assert(document.algorithm == algorithm_cfr_plus);
    std.debug.assert(document.config_text.len > 0);
    if (document.slot_actions.len != 0) std.debug.assert(document.average.len > 0);

    var flags: u32 = 0;
    if (document.hasTraining()) flags |= flag_training;
    if (document.hasOverlays()) flags |= flag_overlays;
    if (document.has_metrics) flags |= flag_metrics;

    var writer = Writer.init(allocator);
    defer writer.deinit();

    try writer.u8w(document.algorithm);
    try writer.u8w(if (document.frozen) 1 else 0);
    try writer.u16w(0);
    try writer.text(document.config_text);
    try writer.i32s(document.oop_combos);
    try writer.i32s(document.ip_combos);
    try writer.u16s(document.slot_actions);
    try writer.f32s(document.average);

    if ((flags & flag_training) != 0) {
        try writer.i32w(document.trained);
        try writer.f32s(document.regret);
        try writer.f32s(document.strategy_sum);
        if (document.regret.len != document.average.len) return error.InvalidPsol;
        if (document.strategy_sum.len != document.average.len) return error.InvalidPsol;
        // Write-side pair for the decode length equality checks below.
        std.debug.assert(document.regret.len == document.average.len);
        std.debug.assert(document.strategy_sum.len == document.average.len);
    }
    if ((flags & flag_overlays) != 0) {
        try writer.text(document.locks_text);
        try writer.text(document.strategy_edits_text);
    }
    if ((flags & flag_metrics) != 0) {
        try writer.f64w(document.metrics.value);
        try writer.f64w(document.metrics.br0);
        try writer.f64w(document.metrics.br1);
        try writer.f64w(document.metrics.nash_gap);
        try writer.f64w(document.metrics.accuracy);
    }

    const payload = writer.bytes();
    const checksum = fnv1a64(payload);
    var header: [header_bytes]u8 = undefined;
    writeHeader(&header, flags, payload.len, checksum);
    // Header contract the reader trusts (magic / version / payload_len).
    std.debug.assert(std.mem.eql(u8, header[0..4], magic));
    std.debug.assert(std.mem.readInt(u32, header[4..8], .little) == version);
    std.debug.assert(std.mem.readInt(u64, header[12..20], .little) == payload.len);

    var out = allocator.alloc(u8, header_bytes + payload.len) catch return error.OutOfMemory;
    @memcpy(out[0..header_bytes], &header);
    @memcpy(out[header_bytes..], payload);
    std.debug.assert(out.len == header_bytes + payload.len);
    return out;
}

/// Decode bytes. Rejects pre-v4 and kind=2 with clear errors (D5/D6).
pub fn decode(allocator: std.mem.Allocator, file: []const u8) OpenError!Document {
    if (file.len < header_bytes) return error.UnsupportedFormat;
    if (!std.mem.eql(u8, file[0..4], magic)) return error.UnsupportedFormat;

    const file_version = std.mem.readInt(u32, file[4..8], .little);
    if (file_version < 4) {
        // Legacy: kind sits at the first payload byte (offset 32).
        if (file.len > header_bytes and file[header_bytes] == 2) {
            return error.Kind2RiverRejected;
        }
        return error.LegacyCheckpointRejected;
    }
    if (file_version != 4) return error.UnsupportedFormat;

    const flags = std.mem.readInt(u32, file[8..12], .little);
    const payload_len = std.mem.readInt(u64, file[12..20], .little);
    const expected = std.mem.readInt(u64, file[20..28], .little);
    if (payload_len != file.len - header_bytes) return error.InvalidPsol;
    const payload = file[header_bytes..];
    if (fnv1a64(payload) != expected) return error.InvalidPsol;

    var reader = Reader{ .data = payload };
    var document = Document{ .allocator = allocator };
    errdefer document.deinit();

    document.algorithm = try reader.u8r();
    const frozen = try reader.u8r();
    _ = try reader.u16r();
    if (document.algorithm != algorithm_cfr_plus) return error.InvalidPsol;
    if (frozen != 0 and frozen != 1) return error.InvalidPsol;
    document.frozen = frozen == 1;
    document.config_text = try reader.text(allocator);
    if (document.config_text.len == 0) return error.InvalidPsol;
    document.oop_combos = try reader.i32s(allocator);
    document.ip_combos = try reader.i32s(allocator);
    document.slot_actions = try reader.u16s(allocator);
    document.average = try reader.f32s(allocator);
    // Dimension pin before session replace: empty average only with empty slots.
    if (document.average.len == 0 and document.slot_actions.len != 0) return error.InvalidPsol;
    // Read-side pair for encode's average/slot precondition.
    if (document.slot_actions.len != 0) std.debug.assert(document.average.len > 0);

    if ((flags & flag_training) != 0) {
        document.has_training_flag = true;
        document.trained = try reader.i32r();
        document.regret = try reader.f32s(allocator);
        document.strategy_sum = try reader.f32s(allocator);
        if (document.regret.len != document.average.len) return error.InvalidPsol;
        if (document.strategy_sum.len != document.average.len) return error.InvalidPsol;
        // Read-side pair for encode training length asserts.
        std.debug.assert(document.regret.len == document.average.len);
        std.debug.assert(document.strategy_sum.len == document.average.len);
    }
    if ((flags & flag_overlays) != 0) {
        document.locks_text = try reader.text(allocator);
        document.strategy_edits_text = try reader.text(allocator);
    }
    if ((flags & flag_metrics) != 0) {
        document.metrics.value = try reader.f64r();
        document.metrics.br0 = try reader.f64r();
        document.metrics.br1 = try reader.f64r();
        document.metrics.nash_gap = try reader.f64r();
        document.metrics.accuracy = try reader.f64r();
        document.has_metrics = true;
    }
    if (reader.at != reader.data.len) return error.InvalidPsol;
    _ = poker_engine;
    return document;
}

pub const max_psol_bytes: usize = 512 * 1024 * 1024;
/// Bounded scratch for streaming Save/Open (ZR-156). Not a second full-file buffer.
pub const stream_chunk_bytes: usize = 64 * 1024;

/// Injectable save faults for unit tests (ZR-144). Production callers use `.none`.
/// Every non-`.none` fault must leave an existing destination checkpoint readable.
pub const SaveFault = enum {
    none,
    /// Fail while streaming bytes to the sibling temp (disk-full class).
    write,
    /// Fail after a complete write when flushing/syncing the temp.
    sync,
    /// Fail the single replace/rename step (file-in-use / AccessDenied class).
    rename,
    /// Write+sync succeed but replace never runs (interrupted / crash-before-rename).
    interrupt_before_replace,
};

/// Exact on-disk size (header + payload) without building the file bytes.
pub fn encodedFileBytes(document: Document) OpenError!u64 {
    const payload = try encodedPayloadBytes(document);
    const total = std.math.add(u64, header_bytes, payload) catch return error.InvalidPsol;
    return total;
}

fn encodedPayloadBytes(document: Document) OpenError!u64 {
    if (document.algorithm != algorithm_cfr_plus) return error.InvalidPsol;
    if (document.config_text.len == 0) return error.InvalidPsol;
    if (document.average.len == 0 and document.slot_actions.len != 0) return error.InvalidPsol;

    var n: u64 = 4; // algorithm + frozen + pad u16
    n = try addLenPrefixed(n, document.config_text.len, 1);
    n = try addLenPrefixed(n, document.oop_combos.len, 4);
    n = try addLenPrefixed(n, document.ip_combos.len, 4);
    n = try addLenPrefixed(n, document.slot_actions.len, 2);
    n = try addLenPrefixed(n, document.average.len, 4);
    if (document.hasTraining()) {
        n = std.math.add(u64, n, 4) catch return error.InvalidPsol; // trained i32
        n = try addLenPrefixed(n, document.regret.len, 4);
        n = try addLenPrefixed(n, document.strategy_sum.len, 4);
        if (document.regret.len != document.average.len) return error.InvalidPsol;
        if (document.strategy_sum.len != document.average.len) return error.InvalidPsol;
    }
    if (document.hasOverlays()) {
        n = try addLenPrefixed(n, document.locks_text.len, 1);
        n = try addLenPrefixed(n, document.strategy_edits_text.len, 1);
    }
    if (document.has_metrics) {
        n = std.math.add(u64, n, 5 * 8) catch return error.InvalidPsol;
    }
    return n;
}

fn addLenPrefixed(base: u64, count: usize, elem_size: usize) OpenError!u64 {
    const body = std.math.mul(u64, count, elem_size) catch return error.InvalidPsol;
    const with_len = std.math.add(u64, base, 4) catch return error.InvalidPsol;
    return std.math.add(u64, with_len, body) catch return error.InvalidPsol;
}

/// Streams payload bytes to a file while hashing and enforcing `max_psol_bytes`.
const PayloadSink = struct {
    file: std.fs.File,
    hash: u64 = 0xcbf29ce484222325,
    payload_len: u64 = 0,

    fn writeAll(self: *PayloadSink, bytes: []const u8) OpenError!void {
        if (bytes.len == 0) return;
        const next = std.math.add(u64, self.payload_len, bytes.len) catch return error.InvalidPsol;
        const total = std.math.add(u64, header_bytes, next) catch return error.InvalidPsol;
        if (total > max_psol_bytes) return error.InvalidPsol;
        for (bytes) |b| {
            self.hash ^= b;
            self.hash *%= 0x100000001b3;
        }
        self.file.writeAll(bytes) catch return error.InvalidPsol;
        self.payload_len = next;
        std.debug.assert(header_bytes + self.payload_len <= max_psol_bytes);
    }

    fn u8w(self: *PayloadSink, value: u8) OpenError!void {
        try self.writeAll(&[_]u8{value});
    }

    fn u16w(self: *PayloadSink, value: u16) OpenError!void {
        var buf: [2]u8 = undefined;
        std.mem.writeInt(u16, &buf, value, .little);
        try self.writeAll(&buf);
    }

    fn u32w(self: *PayloadSink, value: u32) OpenError!void {
        var buf: [4]u8 = undefined;
        std.mem.writeInt(u32, &buf, value, .little);
        try self.writeAll(&buf);
    }

    fn i32w(self: *PayloadSink, value: i32) OpenError!void {
        try self.u32w(@bitCast(value));
    }

    fn f64w(self: *PayloadSink, value: f64) OpenError!void {
        var buf: [8]u8 = undefined;
        std.mem.writeInt(u64, &buf, @bitCast(value), .little);
        try self.writeAll(&buf);
    }

    fn text(self: *PayloadSink, value: []const u8) OpenError!void {
        if (value.len > std.math.maxInt(u32)) return error.InvalidPsol;
        try self.u32w(@intCast(value.len));
        try self.writeAll(value);
    }

    fn i32s(self: *PayloadSink, values: []const i32) OpenError!void {
        if (values.len > std.math.maxInt(u32)) return error.InvalidPsol;
        try self.u32w(@intCast(values.len));
        var i: usize = 0;
        var buf: [stream_chunk_bytes]u8 = undefined;
        while (i < values.len) {
            const n = @min(values.len - i, buf.len / 4);
            var j: usize = 0;
            while (j < n) : (j += 1) {
                std.mem.writeInt(i32, buf[j * 4 ..][0..4], values[i + j], .little);
            }
            try self.writeAll(buf[0 .. n * 4]);
            i += n;
        }
    }

    fn u16s(self: *PayloadSink, values: []const u16) OpenError!void {
        if (values.len > std.math.maxInt(u32)) return error.InvalidPsol;
        try self.u32w(@intCast(values.len));
        var i: usize = 0;
        var buf: [stream_chunk_bytes]u8 = undefined;
        while (i < values.len) {
            const n = @min(values.len - i, buf.len / 2);
            var j: usize = 0;
            while (j < n) : (j += 1) {
                std.mem.writeInt(u16, buf[j * 2 ..][0..2], values[i + j], .little);
            }
            try self.writeAll(buf[0 .. n * 2]);
            i += n;
        }
    }

    fn f32s(self: *PayloadSink, values: []const f32) OpenError!void {
        if (values.len > std.math.maxInt(u32)) return error.InvalidPsol;
        try self.u32w(@intCast(values.len));
        var i: usize = 0;
        var buf: [stream_chunk_bytes]u8 = undefined;
        while (i < values.len) {
            const n = @min(values.len - i, buf.len / 4);
            var j: usize = 0;
            while (j < n) : (j += 1) {
                std.mem.writeInt(u32, buf[j * 4 ..][0..4], @bitCast(values[i + j]), .little);
            }
            try self.writeAll(buf[0 .. n * 4]);
            i += n;
        }
    }
};

fn streamDocumentPayload(sink: *PayloadSink, document: Document, flags: u32) OpenError!void {
    if (document.algorithm != algorithm_cfr_plus) return error.InvalidPsol;
    if (document.config_text.len == 0) return error.InvalidPsol;
    if (document.average.len == 0 and document.slot_actions.len != 0) return error.InvalidPsol;
    std.debug.assert(document.algorithm == algorithm_cfr_plus);
    std.debug.assert(document.config_text.len > 0);

    try sink.u8w(document.algorithm);
    try sink.u8w(if (document.frozen) 1 else 0);
    try sink.u16w(0);
    try sink.text(document.config_text);
    try sink.i32s(document.oop_combos);
    try sink.i32s(document.ip_combos);
    try sink.u16s(document.slot_actions);
    try sink.f32s(document.average);

    if ((flags & flag_training) != 0) {
        try sink.i32w(document.trained);
        try sink.f32s(document.regret);
        try sink.f32s(document.strategy_sum);
        if (document.regret.len != document.average.len) return error.InvalidPsol;
        if (document.strategy_sum.len != document.average.len) return error.InvalidPsol;
        std.debug.assert(document.regret.len == document.average.len);
        std.debug.assert(document.strategy_sum.len == document.average.len);
    }
    if ((flags & flag_overlays) != 0) {
        try sink.text(document.locks_text);
        try sink.text(document.strategy_edits_text);
    }
    if ((flags & flag_metrics) != 0) {
        try sink.f64w(document.metrics.value);
        try sink.f64w(document.metrics.br0);
        try sink.f64w(document.metrics.br1);
        try sink.f64w(document.metrics.nash_gap);
        try sink.f64w(document.metrics.accuracy);
    }
}

/// Atomic save (ZR-92 / ZR-144 / ZR-156): stream the payload with a bounded scratch
/// buffer (no full-file encode before the 512 MiB gate), require write+flush, then
/// replace the destination in one rename. Never deletes the destination on failure.
pub fn writeFile(allocator: std.mem.Allocator, path: []const u8, document: Document) OpenError!void {
    _ = allocator;
    return writeFileInjected(path, document, .none);
}

pub fn writeFileInjected(
    path: []const u8,
    document: Document,
    fault: SaveFault,
) OpenError!void {
    // Size gate before any disk write — exact, no staging buffer.
    const total_bytes = try encodedFileBytes(document);
    if (total_bytes > max_psol_bytes) return error.InvalidPsol;
    std.debug.assert(total_bytes >= header_bytes);
    std.debug.assert(total_bytes <= max_psol_bytes);

    var flags: u32 = 0;
    if (document.hasTraining()) flags |= flag_training;
    if (document.hasOverlays()) flags |= flag_overlays;
    if (document.has_metrics) flags |= flag_metrics;

    // Callers pass an already-unescaped filesystem path (host JSON unescape).
    const dirname = std.fs.path.dirname(path) orelse ".";
    const basename = std.fs.path.basename(path);
    if (basename.len == 0) return error.InvalidPsol;
    std.debug.assert(basename.len > 0);

    var dir = std.fs.cwd().openDir(dirname, .{}) catch return error.InvalidPsol;
    defer dir.close();

    var tmp_name_buf: [std.fs.max_path_bytes]u8 = undefined;
    // Same-directory sibling so rename stays atomic (incl. Windows ReplaceIfExists).
    const tmp_name = std.fmt.bufPrint(&tmp_name_buf, ".{s}.tmp-{d}", .{
        basename,
        std.time.nanoTimestamp(),
    }) catch return error.InvalidPsol;
    // Sibling temp must stay in this directory (basename only — no separators).
    std.debug.assert(std.fs.path.dirname(tmp_name) == null);
    std.debug.assert(std.mem.indexOfScalar(u8, tmp_name, '/') == null);
    std.debug.assert(std.mem.indexOfScalar(u8, tmp_name, '\\') == null);

    const file = dir.createFile(tmp_name, .{ .exclusive = true }) catch return error.InvalidPsol;
    var file_open = true;
    errdefer {
        if (file_open) file.close();
        // Temp only — never touch the destination on the failure path.
        dir.deleteFile(tmp_name) catch {};
    }

    // Placeholder header; rewritten after the payload hash/length are known.
    var zero_header: [header_bytes]u8 = .{0} ** header_bytes;
    file.writeAll(&zero_header) catch return error.InvalidPsol;

    if (fault == .write) {
        // Partial write then fail: models ENOSPC mid-stream without truncating dest.
        std.debug.assert(fault == .write);
        const stub = [_]u8{algorithm_cfr_plus, 0, 0, 0};
        file.writeAll(&stub) catch {};
        return error.InvalidPsol;
    }

    var sink = PayloadSink{ .file = file };
    try streamDocumentPayload(&sink, document, flags);
    std.debug.assert(sink.payload_len + header_bytes == total_bytes);

    var header: [header_bytes]u8 = undefined;
    writeHeader(&header, flags, sink.payload_len, sink.hash);
    std.debug.assert(std.mem.eql(u8, header[0..4], magic));
    std.debug.assert(std.mem.readInt(u32, header[4..8], .little) == version);
    std.debug.assert(std.mem.readInt(u64, header[12..20], .little) == sink.payload_len);

    file.seekTo(0) catch return error.InvalidPsol;
    file.writeAll(&header) catch return error.InvalidPsol;

    if (fault == .sync) {
        std.debug.assert(fault == .sync);
        return error.InvalidPsol;
    }
    file.sync() catch return error.InvalidPsol;

    file.close();
    file_open = false;

    if (fault == .interrupt_before_replace) {
        // Crash-before-rename: dest untouched; errdefer removes the orphan temp.
        std.debug.assert(fault == .interrupt_before_replace);
        return error.InvalidPsol;
    }
    if (fault == .rename) {
        // Rename/replace refused (e.g. Windows file-in-use). Dest stays intact.
        std.debug.assert(fault == .rename);
        return error.InvalidPsol;
    }

    // Positive space: only the no-fault path performs the single replace.
    std.debug.assert(fault == .none);
    // Single replace. Do not delete-then-retry (that race deletes the only good
    // checkpoint). Windows file-in-use → SHARING_VIOLATION must map cleanly.
    try renameReplace(dir, tmp_name, basename);
}

/// Atomic same-directory replace. On Windows, Zig 0.14 `Dir.rename` → `renameatW`
/// leaves `STATUS_SHARING_VIOLATION` (0xC0000043) as `error.Unexpected` and prints
/// via `unexpectedStatus`. Map that (and AccessDenied) to InvalidPsol without the
/// stderr noise so file-in-use Save failures stay a clean codec error (ZR-178).
fn renameReplace(dir: std.fs.Dir, tmp_name: []const u8, basename: []const u8) error{InvalidPsol}!void {
    if (builtin.os.tag == .windows) {
        renameReplaceWindows(dir, tmp_name, basename) catch return error.InvalidPsol;
        return;
    }
    dir.rename(tmp_name, basename) catch return error.InvalidPsol;
}

fn renameReplaceWindows(dir: std.fs.Dir, tmp_name: []const u8, basename: []const u8) !void {
    const w = std.os.windows;
    const tmp_w = try w.sliceToPrefixedFileW(dir.fd, tmp_name);
    const dest_w = try w.sliceToPrefixedFileW(dir.fd, basename);

    const src_fd = w.OpenFile(tmp_w.span(), .{
        .dir = dir.fd,
        .access_mask = w.SYNCHRONIZE | w.GENERIC_WRITE | w.DELETE,
        .creation = w.FILE_OPEN,
        .filter = .any,
        .follow_symlinks = false,
    }) catch |err| switch (err) {
        error.WouldBlock => unreachable,
        else => |e| return e,
    };
    defer w.CloseHandle(src_fd);

    const new_path_w = dest_w.span();
    const struct_buf_len = @sizeOf(w.FILE_RENAME_INFORMATION) + (std.fs.max_path_bytes - 1);
    var rename_info_buf: [struct_buf_len]u8 align(@alignOf(w.FILE_RENAME_INFORMATION)) = undefined;
    const struct_len = @sizeOf(w.FILE_RENAME_INFORMATION) - 1 + new_path_w.len * 2;
    if (struct_len > struct_buf_len) return error.NameTooLong;

    const rename_info: *w.FILE_RENAME_INFORMATION = @ptrCast(&rename_info_buf);
    var io_status_block: w.IO_STATUS_BLOCK = undefined;
    rename_info.* = .{
        .Flags = w.TRUE, // ReplaceIfExists
        .RootDirectory = if (std.fs.path.isAbsoluteWindowsWTF16(new_path_w)) null else dir.fd,
        .FileNameLength = @intCast(new_path_w.len * 2),
        .FileName = undefined,
    };
    @memcpy((&rename_info.FileName).ptr, new_path_w);

    const rc = w.ntdll.NtSetInformationFile(
        src_fd,
        &io_status_block,
        rename_info,
        @intCast(struct_len),
        .FileRenameInformation,
    );
    switch (rc) {
        .SUCCESS => {},
        // Dest held open without FILE_SHARE_DELETE/WRITE (Explorer/AV file-in-use).
        .SHARING_VIOLATION => return error.AccessDenied,
        .ACCESS_DENIED => return error.AccessDenied,
        .OBJECT_NAME_NOT_FOUND => return error.FileNotFound,
        .OBJECT_PATH_NOT_FOUND => return error.FileNotFound,
        .NOT_SAME_DEVICE => return error.RenameAcrossMountPoints,
        .OBJECT_NAME_COLLISION => return error.PathAlreadyExists,
        .DIRECTORY_NOT_EMPTY => return error.PathAlreadyExists,
        .FILE_IS_A_DIRECTORY => return error.IsDir,
        .NOT_A_DIRECTORY => return error.NotDir,
        else => return w.unexpectedStatus(rc),
    }
}

/// Streaming payload reader with a bounded readahead buffer (ZR-156).
const PayloadSource = struct {
    file: std.fs.File,
    remaining: u64,
    hash: u64 = 0xcbf29ce484222325,
    buf: [stream_chunk_bytes]u8 = undefined,
    at: usize = 0,
    len: usize = 0,

    fn fill(self: *PayloadSource) OpenError!void {
        std.debug.assert(self.at == self.len);
        if (self.remaining == 0) return error.InvalidPsol;
        const want = @min(self.buf.len, self.remaining);
        const n = self.file.read(self.buf[0..want]) catch return error.InvalidPsol;
        if (n == 0) return error.InvalidPsol;
        self.at = 0;
        self.len = n;
        std.debug.assert(self.len <= self.remaining);
    }

    fn readExact(self: *PayloadSource, dest: []u8) OpenError!void {
        var filled: usize = 0;
        while (filled < dest.len) {
            if (self.at == self.len) try self.fill();
            const take = @min(dest.len - filled, self.len - self.at);
            @memcpy(dest[filled .. filled + take], self.buf[self.at .. self.at + take]);
            var i: usize = 0;
            while (i < take) : (i += 1) {
                self.hash ^= self.buf[self.at + i];
                self.hash *%= 0x100000001b3;
            }
            self.at += take;
            self.remaining -= take;
            filled += take;
        }
    }

    fn need(self: *PayloadSource, n: usize) OpenError!void {
        if (self.remaining < n) return error.InvalidPsol;
    }

    fn needCount(self: *PayloadSource, count: usize, elem_size: usize) OpenError!void {
        std.debug.assert(elem_size > 0);
        const nbytes = std.math.mul(usize, count, elem_size) catch return error.InvalidPsol;
        try self.need(nbytes);
        std.debug.assert(self.remaining >= nbytes);
    }

    fn u8r(self: *PayloadSource) OpenError!u8 {
        var b: [1]u8 = undefined;
        try self.readExact(&b);
        return b[0];
    }

    fn u16r(self: *PayloadSource) OpenError!u16 {
        var b: [2]u8 = undefined;
        try self.readExact(&b);
        return std.mem.readInt(u16, &b, .little);
    }

    fn u32r(self: *PayloadSource) OpenError!u32 {
        var b: [4]u8 = undefined;
        try self.readExact(&b);
        return std.mem.readInt(u32, &b, .little);
    }

    fn i32r(self: *PayloadSource) OpenError!i32 {
        return @bitCast(try self.u32r());
    }

    fn f32r(self: *PayloadSource) OpenError!f32 {
        return @bitCast(try self.u32r());
    }

    fn f64r(self: *PayloadSource) OpenError!f64 {
        var b: [8]u8 = undefined;
        try self.readExact(&b);
        return @bitCast(std.mem.readInt(u64, &b, .little));
    }

    fn text(self: *PayloadSource, allocator: std.mem.Allocator) OpenError![]u8 {
        const len = try self.u32r();
        try self.needCount(len, 1);
        const out = allocator.alloc(u8, len) catch return error.OutOfMemory;
        errdefer allocator.free(out);
        try self.readExact(out);
        return out;
    }

    fn i32s(self: *PayloadSource, allocator: std.mem.Allocator) OpenError![]i32 {
        const len = try self.u32r();
        try self.needCount(len, @sizeOf(i32));
        var out = allocator.alloc(i32, len) catch return error.OutOfMemory;
        errdefer allocator.free(out);
        var i: usize = 0;
        var scratch: [stream_chunk_bytes]u8 = undefined;
        while (i < len) {
            const n = @min(len - i, scratch.len / 4);
            try self.readExact(scratch[0 .. n * 4]);
            var j: usize = 0;
            while (j < n) : (j += 1) {
                out[i + j] = std.mem.readInt(i32, scratch[j * 4 ..][0..4], .little);
            }
            i += n;
        }
        return out;
    }

    fn u16s(self: *PayloadSource, allocator: std.mem.Allocator) OpenError![]u16 {
        const len = try self.u32r();
        try self.needCount(len, @sizeOf(u16));
        var out = allocator.alloc(u16, len) catch return error.OutOfMemory;
        errdefer allocator.free(out);
        var i: usize = 0;
        var scratch: [stream_chunk_bytes]u8 = undefined;
        while (i < len) {
            const n = @min(len - i, scratch.len / 2);
            try self.readExact(scratch[0 .. n * 2]);
            var j: usize = 0;
            while (j < n) : (j += 1) {
                out[i + j] = std.mem.readInt(u16, scratch[j * 2 ..][0..2], .little);
            }
            i += n;
        }
        return out;
    }

    fn f32s(self: *PayloadSource, allocator: std.mem.Allocator) OpenError![]f32 {
        const len = try self.u32r();
        try self.needCount(len, @sizeOf(f32));
        var out = allocator.alloc(f32, len) catch return error.OutOfMemory;
        errdefer allocator.free(out);
        var i: usize = 0;
        var scratch: [stream_chunk_bytes]u8 = undefined;
        while (i < len) {
            const n = @min(len - i, scratch.len / 4);
            try self.readExact(scratch[0 .. n * 4]);
            var j: usize = 0;
            while (j < n) : (j += 1) {
                out[i + j] = @bitCast(std.mem.readInt(u32, scratch[j * 4 ..][0..4], .little));
            }
            i += n;
        }
        return out;
    }
};

/// Stream only the street-config text from a v4 file (bounded; for memory-mib peek).
pub fn peekConfigText(allocator: std.mem.Allocator, path: []const u8) OpenError![]u8 {
    const file = std.fs.cwd().openFile(path, .{}) catch return error.UnsupportedFormat;
    defer file.close();

    var header_buf: [header_bytes]u8 = undefined;
    const header_n = file.readAll(&header_buf) catch return error.UnsupportedFormat;
    if (header_n < header_bytes) return error.UnsupportedFormat;
    if (!std.mem.eql(u8, header_buf[0..4], magic)) return error.UnsupportedFormat;

    const file_version = std.mem.readInt(u32, header_buf[4..8], .little);
    if (file_version < 4) {
        var kind_buf: [1]u8 = undefined;
        const kn = file.read(&kind_buf) catch return error.LegacyCheckpointRejected;
        if (kn == 1 and kind_buf[0] == 2) return error.Kind2RiverRejected;
        return error.LegacyCheckpointRejected;
    }
    if (file_version != 4) return error.UnsupportedFormat;

    const payload_len = std.mem.readInt(u64, header_buf[12..20], .little);
    const total = std.math.add(u64, header_bytes, payload_len) catch return error.InvalidPsol;
    if (total > max_psol_bytes) return error.InvalidPsol;

    var src = PayloadSource{ .file = file, .remaining = payload_len };
    const algorithm = try src.u8r();
    const frozen = try src.u8r();
    _ = try src.u16r();
    if (algorithm != algorithm_cfr_plus) return error.InvalidPsol;
    if (frozen != 0 and frozen != 1) return error.InvalidPsol;
    const config_text = try src.text(allocator);
    if (config_text.len == 0) {
        allocator.free(config_text);
        return error.InvalidPsol;
    }
    return config_text;
}

/// Open a v4 checkpoint by streaming the payload (bounded readahead; no full-file alloc).
pub fn readFile(allocator: std.mem.Allocator, path: []const u8) OpenError!Document {
    const file = std.fs.cwd().openFile(path, .{}) catch return error.UnsupportedFormat;
    defer file.close();

    var header_buf: [header_bytes]u8 = undefined;
    const header_n = file.readAll(&header_buf) catch return error.UnsupportedFormat;
    if (header_n < header_bytes) return error.UnsupportedFormat;
    if (!std.mem.eql(u8, header_buf[0..4], magic)) return error.UnsupportedFormat;

    const file_version = std.mem.readInt(u32, header_buf[4..8], .little);
    if (file_version < 4) {
        // Legacy kind check needs the first payload byte; peek one byte.
        var kind_buf: [1]u8 = undefined;
        const kn = file.read(&kind_buf) catch return error.LegacyCheckpointRejected;
        if (kn == 1 and kind_buf[0] == 2) return error.Kind2RiverRejected;
        return error.LegacyCheckpointRejected;
    }
    if (file_version != 4) return error.UnsupportedFormat;

    const flags = std.mem.readInt(u32, header_buf[8..12], .little);
    const payload_len = std.mem.readInt(u64, header_buf[12..20], .little);
    const expected = std.mem.readInt(u64, header_buf[20..28], .little);
    const total = std.math.add(u64, header_bytes, payload_len) catch return error.InvalidPsol;
    if (total > max_psol_bytes) return error.InvalidPsol;

    var src = PayloadSource{ .file = file, .remaining = payload_len };
    var document = Document{ .allocator = allocator };
    errdefer document.deinit();

    document.algorithm = try src.u8r();
    const frozen = try src.u8r();
    _ = try src.u16r();
    if (document.algorithm != algorithm_cfr_plus) return error.InvalidPsol;
    if (frozen != 0 and frozen != 1) return error.InvalidPsol;
    document.frozen = frozen == 1;
    document.config_text = try src.text(allocator);
    if (document.config_text.len == 0) return error.InvalidPsol;
    document.oop_combos = try src.i32s(allocator);
    document.ip_combos = try src.i32s(allocator);
    document.slot_actions = try src.u16s(allocator);
    document.average = try src.f32s(allocator);
    if (document.average.len == 0 and document.slot_actions.len != 0) return error.InvalidPsol;
    if (document.slot_actions.len != 0) std.debug.assert(document.average.len > 0);

    if ((flags & flag_training) != 0) {
        document.has_training_flag = true;
        document.trained = try src.i32r();
        document.regret = try src.f32s(allocator);
        document.strategy_sum = try src.f32s(allocator);
        if (document.regret.len != document.average.len) return error.InvalidPsol;
        if (document.strategy_sum.len != document.average.len) return error.InvalidPsol;
        std.debug.assert(document.regret.len == document.average.len);
        std.debug.assert(document.strategy_sum.len == document.average.len);
    }
    if ((flags & flag_overlays) != 0) {
        document.locks_text = try src.text(allocator);
        document.strategy_edits_text = try src.text(allocator);
    }
    if ((flags & flag_metrics) != 0) {
        document.metrics.value = try src.f64r();
        document.metrics.br0 = try src.f64r();
        document.metrics.br1 = try src.f64r();
        document.metrics.nash_gap = try src.f64r();
        document.metrics.accuracy = try src.f64r();
        document.has_metrics = true;
    }
    if (src.remaining != 0 or src.at != src.len) return error.InvalidPsol;
    if (src.hash != expected) return error.InvalidPsol;
    _ = poker_engine;
    return document;
}

test "v4 roundtrip browse + training + overlays" {
    var doc = Document{ .allocator = std.testing.allocator };
    defer doc.deinit();
    doc.config_text = try std.testing.allocator.dupe(u8, "street-config 1\nboard Ah Kd 7c\npot 100\n");
    doc.oop_combos = try std.testing.allocator.dupe(i32, &.{1, 2});
    doc.ip_combos = try std.testing.allocator.dupe(i32, &.{3});
    doc.slot_actions = try std.testing.allocator.dupe(u16, &.{2, 3});
    doc.average = try std.testing.allocator.dupe(f32, &.{ 0.25, 0.75, 0.1, 0.2, 0.7 });
    doc.trained = 7;
    doc.regret = try std.testing.allocator.dupe(f32, &.{ 1, 2, 3, 4, 5 });
    doc.strategy_sum = try std.testing.allocator.dupe(f32, &.{ 5, 4, 3, 2, 1 });
    doc.locks_text = try std.testing.allocator.dupe(u8, "lock 0");
    doc.strategy_edits_text = try std.testing.allocator.dupe(u8, "");
    doc.metrics = .{ .value = 1.5, .br0 = 2, .br1 = -2, .nash_gap = 0.5, .accuracy = 0.25 };
    doc.has_metrics = true;

    const bytes = try encode(std.testing.allocator, doc);
    defer std.testing.allocator.free(bytes);

    var loaded = try decode(std.testing.allocator, bytes);
    defer loaded.deinit();
    try std.testing.expectEqualStrings(doc.config_text, loaded.config_text);
    try std.testing.expect(loaded.hasTraining());
    try std.testing.expect(loaded.hasOverlays());
    try std.testing.expect(loaded.has_metrics);
    try std.testing.expectEqual(@as(i32, 7), loaded.trained);
    try std.testing.expectEqual(@as(usize, 5), loaded.average.len);
    try std.testing.expectApproxEqAbs(@as(f64, 0.25), loaded.metrics.accuracy, 1e-12);
}

test "reject legacy street fixture" {
    const bytes = try std.fs.cwd().readFileAlloc(
        std.testing.allocator,
        "tests/fixtures/psol/street_kind1_v2_cfrplus_tiny.psol",
        1024 * 1024,
    );
    defer std.testing.allocator.free(bytes);
    try std.testing.expectError(error.LegacyCheckpointRejected, decode(std.testing.allocator, bytes));
}

test "reject kind2 river fixture" {
    const bytes = try std.fs.cwd().readFileAlloc(
        std.testing.allocator,
        "tests/fixtures/psol/river_kind2_v2_cfrplus_tiny.psol",
        1024 * 1024,
    );
    defer std.testing.allocator.free(bytes);
    try std.testing.expectError(error.Kind2RiverRejected, decode(std.testing.allocator, bytes));
}

/// Rebuild header payload_len + FNV for a crafted payload (tests only).
fn sealTestFile(allocator: std.mem.Allocator, flags: u32, payload: []const u8) ![]u8 {
    var header: [header_bytes]u8 = undefined;
    writeHeader(&header, flags, payload.len, fnv1a64(payload));
    var out = try allocator.alloc(u8, header_bytes + payload.len);
    @memcpy(out[0..header_bytes], &header);
    @memcpy(out[header_bytes..], payload);
    return out;
}

test "oversized f32 count rejects before allocate" {
    // Minimal GAME prefix then average count that cannot fit in remaining bytes.
    var payload = std.ArrayList(u8).init(std.testing.allocator);
    defer payload.deinit();
    try payload.append(algorithm_cfr_plus); // algorithm
    try payload.append(0); // frozen
    try payload.appendSlice(&[_]u8{ 0, 0 }); // pad
    // config_text "x"
    try payload.appendSlice(&[_]u8{ 1, 0, 0, 0 });
    try payload.append('x');
    // oop_combos / ip_combos / slot_actions empty
    try payload.appendSlice(&[_]u8{ 0, 0, 0, 0 });
    try payload.appendSlice(&[_]u8{ 0, 0, 0, 0 });
    try payload.appendSlice(&[_]u8{ 0, 0, 0, 0 });
    // average count = 0x10000000 → 1 GiB of f32s; only this count field remains.
    try payload.appendSlice(&[_]u8{ 0x00, 0x00, 0x00, 0x10 });

    const file = try sealTestFile(std.testing.allocator, 0, payload.items);
    defer std.testing.allocator.free(file);
    try std.testing.expectError(error.InvalidPsol, decode(std.testing.allocator, file));
}

test "truncated average payload rejects before allocate" {
    var payload = std.ArrayList(u8).init(std.testing.allocator);
    defer payload.deinit();
    try payload.append(algorithm_cfr_plus);
    try payload.append(0);
    try payload.appendSlice(&[_]u8{ 0, 0 });
    try payload.appendSlice(&[_]u8{ 1, 0, 0, 0 });
    try payload.append('x');
    try payload.appendSlice(&[_]u8{ 0, 0, 0, 0 });
    try payload.appendSlice(&[_]u8{ 0, 0, 0, 0 });
    try payload.appendSlice(&[_]u8{ 0, 0, 0, 0 });
    // Claim 4 f32s but supply only one.
    try payload.appendSlice(&[_]u8{ 4, 0, 0, 0 });
    try payload.appendSlice(&[_]u8{ 0, 0, 0, 0 });

    const file = try sealTestFile(std.testing.allocator, 0, payload.items);
    defer std.testing.allocator.free(file);
    try std.testing.expectError(error.InvalidPsol, decode(std.testing.allocator, file));
}

test "oversized u16 slot_actions count rejects before allocate" {
    var payload = std.ArrayList(u8).init(std.testing.allocator);
    defer payload.deinit();
    try payload.append(algorithm_cfr_plus);
    try payload.append(0);
    try payload.appendSlice(&[_]u8{ 0, 0 });
    try payload.appendSlice(&[_]u8{ 1, 0, 0, 0 });
    try payload.append('x');
    try payload.appendSlice(&[_]u8{ 0, 0, 0, 0 });
    try payload.appendSlice(&[_]u8{ 0, 0, 0, 0 });
    // slot_actions count = 0x20000000 → 1 GiB of u16s with no body.
    try payload.appendSlice(&[_]u8{ 0x00, 0x00, 0x00, 0x20 });

    const file = try sealTestFile(std.testing.allocator, 0, payload.items);
    defer std.testing.allocator.free(file);
    try std.testing.expectError(error.InvalidPsol, decode(std.testing.allocator, file));
}

test "empty average with non-empty slots rejects" {
    var doc = Document{ .allocator = std.testing.allocator };
    defer doc.deinit();
    doc.config_text = try std.testing.allocator.dupe(u8, "street-config 1\nboard Ah Kd 7c\npot 100\n");
    doc.slot_actions = try std.testing.allocator.dupe(u16, &.{2});
    // average left empty — encode rejects; craft payload to hit decode pin.
    var payload = std.ArrayList(u8).init(std.testing.allocator);
    defer payload.deinit();
    try payload.append(algorithm_cfr_plus);
    try payload.append(0);
    try payload.appendSlice(&[_]u8{ 0, 0 });
    {
        const cfg = doc.config_text;
        var lenbuf: [4]u8 = undefined;
        std.mem.writeInt(u32, &lenbuf, @intCast(cfg.len), .little);
        try payload.appendSlice(&lenbuf);
        try payload.appendSlice(cfg);
    }
    try payload.appendSlice(&[_]u8{ 0, 0, 0, 0 }); // oop
    try payload.appendSlice(&[_]u8{ 0, 0, 0, 0 }); // ip
    try payload.appendSlice(&[_]u8{ 1, 0, 0, 0 }); // one slot
    try payload.appendSlice(&[_]u8{ 2, 0 }); // arity 2
    try payload.appendSlice(&[_]u8{ 0, 0, 0, 0 }); // average count 0

    const file = try sealTestFile(std.testing.allocator, 0, payload.items);
    defer std.testing.allocator.free(file);
    try std.testing.expectError(error.InvalidPsol, decode(std.testing.allocator, file));
}

fn testDoc(allocator: std.mem.Allocator, marker: []const u8) !Document {
    var doc = Document{ .allocator = allocator };
    errdefer doc.deinit();
    doc.config_text = try std.fmt.allocPrint(allocator, "street-config 1\nboard Ah Kd 7c\npot 100\n# {s}\n", .{marker});
    doc.oop_combos = try allocator.dupe(i32, &.{1, 2});
    doc.ip_combos = try allocator.dupe(i32, &.{3});
    doc.slot_actions = try allocator.dupe(u16, &.{2});
    doc.average = try allocator.dupe(f32, &.{ 0.4, 0.6 });
    return doc;
}

fn expectReadableMarker(allocator: std.mem.Allocator, path: []const u8, marker: []const u8) !void {
    var loaded = try readFile(allocator, path);
    defer loaded.deinit();
    try std.testing.expect(std.mem.indexOf(u8, loaded.config_text, marker) != null);
}

test "streamed writeFile rejects over max_psol_bytes before touching payload" {
    var doc = Document{ .allocator = std.testing.allocator };
    defer {
        // Fake oversize slice — never allocated; clear before deinit.
        doc.average = &.{};
        doc.deinit();
    }
    doc.config_text = try std.testing.allocator.dupe(u8, "street-config 1\nboard Ah Kd 7c\npot 100\n");
    doc.slot_actions = try std.testing.allocator.dupe(u16, &.{2});
    // Length-only slice: size gate must refuse without encoding/allocating 512 MiB+.
    const too_many: usize = (max_psol_bytes / 4) + 1024;
    doc.average = @as([*]f32, @ptrFromInt(@alignOf(f32)))[0..too_many];

    const total = try encodedFileBytes(doc);
    try std.testing.expect(total > max_psol_bytes);

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const abs = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(abs);
    const path = try std.fs.path.join(std.testing.allocator, &.{ abs, "too_big.psol" });
    defer std.testing.allocator.free(path);
    // writeFile checks encoded size before createFile/stream — no payload deref.
    try std.testing.expectError(error.InvalidPsol, writeFile(std.testing.allocator, path, doc));
}

test "streamed writeFile readFile roundtrip matches encode decode" {
    var doc = try testDoc(std.testing.allocator, "stream-roundtrip");
    defer doc.deinit();
    doc.trained = 3;
    doc.regret = try std.testing.allocator.dupe(f32, &.{ 1, 2 });
    doc.strategy_sum = try std.testing.allocator.dupe(f32, &.{ 3, 4 });
    doc.has_training_flag = true;

    const encoded = try encode(std.testing.allocator, doc);
    defer std.testing.allocator.free(encoded);
    try std.testing.expectEqual(encoded.len, try encodedFileBytes(doc));

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const abs = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(abs);
    const path = try std.fs.path.join(std.testing.allocator, &.{ abs, "stream.psol" });
    defer std.testing.allocator.free(path);
    try writeFile(std.testing.allocator, path, doc);

    var loaded = try readFile(std.testing.allocator, path);
    defer loaded.deinit();
    var from_bytes = try decode(std.testing.allocator, encoded);
    defer from_bytes.deinit();
    try std.testing.expectEqualStrings(from_bytes.config_text, loaded.config_text);
    try std.testing.expectEqual(from_bytes.average.len, loaded.average.len);
    try std.testing.expectEqual(from_bytes.regret.len, loaded.regret.len);
    try std.testing.expectEqual(@as(i32, 3), loaded.trained);
}

test "writeFile overwrite replaces and stays readable" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const abs = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(abs);
    const path = try std.fs.path.join(std.testing.allocator, &.{ abs, "ckpt.psol" });
    defer std.testing.allocator.free(path);

    var first = try testDoc(std.testing.allocator, "first");
    defer first.deinit();
    try writeFile(std.testing.allocator, path, first);
    try std.testing.expect((try encodedFileBytes(first)) <= max_psol_bytes);
    try expectReadableMarker(std.testing.allocator, path, "first");

    var second = try testDoc(std.testing.allocator, "second");
    defer second.deinit();
    try writeFile(std.testing.allocator, path, second);
    try expectReadableMarker(std.testing.allocator, path, "second");
}

test "injected write fault leaves prior checkpoint readable" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const abs = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(abs);
    const path = try std.fs.path.join(std.testing.allocator, &.{ abs, "ckpt.psol" });
    defer std.testing.allocator.free(path);

    var prior = try testDoc(std.testing.allocator, "prior-write");
    defer prior.deinit();
    try writeFile(std.testing.allocator, path, prior);

    var next = try testDoc(std.testing.allocator, "next-write");
    defer next.deinit();
    try std.testing.expectError(error.InvalidPsol, writeFileInjected(path, next, .write));
    try expectReadableMarker(std.testing.allocator, path, "prior-write");
}

test "injected sync fault leaves prior checkpoint readable" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const abs = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(abs);
    const path = try std.fs.path.join(std.testing.allocator, &.{ abs, "ckpt.psol" });
    defer std.testing.allocator.free(path);

    var prior = try testDoc(std.testing.allocator, "prior-sync");
    defer prior.deinit();
    try writeFile(std.testing.allocator, path, prior);

    var next = try testDoc(std.testing.allocator, "next-sync");
    defer next.deinit();
    try std.testing.expectError(error.InvalidPsol, writeFileInjected(path, next, .sync));
    try expectReadableMarker(std.testing.allocator, path, "prior-sync");
}

test "injected rename fault leaves prior checkpoint readable" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const abs = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(abs);
    const path = try std.fs.path.join(std.testing.allocator, &.{ abs, "ckpt.psol" });
    defer std.testing.allocator.free(path);

    var prior = try testDoc(std.testing.allocator, "prior-rename");
    defer prior.deinit();
    try writeFile(std.testing.allocator, path, prior);

    var next = try testDoc(std.testing.allocator, "next-rename");
    defer next.deinit();
    try std.testing.expectError(error.InvalidPsol, writeFileInjected(path, next, .rename));
    try expectReadableMarker(std.testing.allocator, path, "prior-rename");
}

test "interrupted save before replace leaves prior checkpoint readable" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const abs = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(abs);
    const path = try std.fs.path.join(std.testing.allocator, &.{ abs, "ckpt.psol" });
    defer std.testing.allocator.free(path);

    var prior = try testDoc(std.testing.allocator, "prior-interrupt");
    defer prior.deinit();
    try writeFile(std.testing.allocator, path, prior);

    var next = try testDoc(std.testing.allocator, "next-interrupt");
    defer next.deinit();
    try std.testing.expectError(
        error.InvalidPsol,
        writeFileInjected(path, next, .interrupt_before_replace),
    );
    try expectReadableMarker(std.testing.allocator, path, "prior-interrupt");
}

test "windows file-in-use replace failure leaves prior checkpoint readable" {
    // Linux rename succeeds while the destination is open. Zig's default Windows
    // opens also grant FILE_SHARE_DELETE, so a std.fs handle alone does not block
    // MoveFileEx REPLACE. Open with share_access=0 to model Explorer/AV file-in-use.
    // Injected `.rename` covers the class on every OS (incl. Linux cloud); this
    // case is for zig-windows CI.
    //
    // NtCreateFile rejects Win32 absolutes (`C:\...`) with OBJECT_PATH_SYNTAX_BAD —
    // it wants an NT-prefixed path (`\??\C:\...`) or a directory-relative name.
    // Open the basename against the tmp Dir handle (same file writeFile targets).
    if (@import("builtin").os.tag != .windows) return;

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const abs = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(abs);
    const path = try std.fs.path.join(std.testing.allocator, &.{ abs, "ckpt.psol" });
    defer std.testing.allocator.free(path);

    var prior = try testDoc(std.testing.allocator, "prior-in-use");
    defer prior.deinit();
    try writeFile(std.testing.allocator, path, prior);

    const w = std.os.windows;
    const name_w = try std.unicode.wtf8ToWtf16LeAllocZ(std.testing.allocator, "ckpt.psol");
    defer std.testing.allocator.free(name_w);
    {
        const held = try w.OpenFile(name_w, .{
            .dir = tmp.dir.fd,
            .access_mask = w.GENERIC_READ | w.SYNCHRONIZE,
            .share_access = 0,
            .creation = w.FILE_OPEN,
            .filter = .any,
        });
        defer w.CloseHandle(held);

        var next = try testDoc(std.testing.allocator, "next-in-use");
        defer next.deinit();
        try std.testing.expectError(error.InvalidPsol, writeFile(std.testing.allocator, path, next));
    }
    // Prior bytes must still decode after the failed replace attempt.
    try expectReadableMarker(std.testing.allocator, path, "prior-in-use");
}

const std = @import("std");
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
        return self.regret.len != 0 or self.strategy_sum.len != 0;
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
        try self.need(len);
        const out = allocator.dupe(u8, self.data[self.at .. self.at + len]) catch return error.OutOfMemory;
        self.at += len;
        return out;
    }

    fn i32s(self: *Reader, allocator: std.mem.Allocator) OpenError![]i32 {
        const len = try self.u32r();
        var out = allocator.alloc(i32, len) catch return error.OutOfMemory;
        errdefer allocator.free(out);
        var i: usize = 0;
        while (i < len) : (i += 1) out[i] = try self.i32r();
        return out;
    }

    fn u16s(self: *Reader, allocator: std.mem.Allocator) OpenError![]u16 {
        const len = try self.u32r();
        var out = allocator.alloc(u16, len) catch return error.OutOfMemory;
        errdefer allocator.free(out);
        var i: usize = 0;
        while (i < len) : (i += 1) out[i] = try self.u16r();
        return out;
    }

    fn f32s(self: *Reader, allocator: std.mem.Allocator) OpenError![]f32 {
        const len = try self.u32r();
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

    var out = allocator.alloc(u8, header_bytes + payload.len) catch return error.OutOfMemory;
    @memcpy(out[0..header_bytes], &header);
    @memcpy(out[header_bytes..], payload);
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

    if ((flags & flag_training) != 0) {
        document.trained = try reader.i32r();
        document.regret = try reader.f32s(allocator);
        document.strategy_sum = try reader.f32s(allocator);
        if (document.regret.len != document.average.len) return error.InvalidPsol;
        if (document.strategy_sum.len != document.average.len) return error.InvalidPsol;
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

pub fn writeFile(allocator: std.mem.Allocator, path: []const u8, document: Document) OpenError!void {
    const bytes = try encode(allocator, document);
    defer allocator.free(bytes);
    const file = std.fs.cwd().createFile(path, .{}) catch return error.InvalidPsol;
    defer file.close();
    file.writeAll(bytes) catch return error.InvalidPsol;
}

pub fn readFile(allocator: std.mem.Allocator, path: []const u8) OpenError!Document {
    const file = std.fs.cwd().openFile(path, .{}) catch return error.UnsupportedFormat;
    defer file.close();
    const bytes = file.readToEndAlloc(allocator, 512 * 1024 * 1024) catch return error.OutOfMemory;
    defer allocator.free(bytes);
    return decode(allocator, bytes);
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

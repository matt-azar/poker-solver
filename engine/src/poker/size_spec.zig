const std = @import("std");

/// Pio-style size tokens stored as f64 sentinels (same encoding as C++ size_spec.hpp).
pub const chip_spec_floor: f64 = -1.0e8;
pub const all_in_spec: f64 = -1.0e9;
pub const geo_base: f64 = -2.0e9;
pub const multiple_base: f64 = -3.0e9;
pub const explicit_empty_spec: f64 = -4.0e9;

pub const SpecError = error{InvalidSizeSpec};

pub fn isChipSpec(spec: f64) bool {
    return spec < 0.0 and spec > chip_spec_floor;
}

pub fn isAllInSpec(spec: f64) bool {
    return spec < -5.0e8 and spec > -1.5e9;
}

pub fn isGeometricSpec(spec: f64) bool {
    return spec <= geo_base + 0.5 and spec > multiple_base + 0.5;
}

pub fn isMultipleSpec(spec: f64) bool {
    return spec <= multiple_base + 0.5 and spec > explicit_empty_spec + 0.5;
}

pub fn isExplicitEmptySpec(spec: f64) bool {
    return spec <= explicit_empty_spec + 0.5 and spec > explicit_empty_spec - 1.0e6;
}

pub fn isExplicitEmptyList(specs: []const f64) bool {
    return specs.len == 1 and isExplicitEmptySpec(specs[0]);
}

pub fn geometricSpec(streets: i32) f64 {
    const n: i32 = if (streets < 0) 0 else streets;
    return geo_base - @as(f64, @floatFromInt(n));
}

pub fn multipleSpec(multiple: f64) f64 {
    return multiple_base - multiple;
}

pub fn geometricStreetsOf(spec: f64) i32 {
    return @intFromFloat(@round(-(spec - geo_base)));
}

pub fn multipleOf(spec: f64) f64 {
    return -(spec - multiple_base);
}

fn toLowerInPlace(buf: []u8) void {
    for (buf) |*c| {
        if (c.* >= 'A' and c.* <= 'Z') c.* = c.* - 'A' + 'a';
    }
}

/// Parse one token. `allow_multiple` is false on bet/donk lists.
pub fn parseSizeToken(token: []const u8, allow_multiple: bool) SpecError!f64 {
    if (token.len == 0 or std.mem.eql(u8, token, "-")) {
        return explicit_empty_spec;
    }
    var lower_buf: [64]u8 = undefined;
    if (token.len > lower_buf.len) return error.InvalidSizeSpec;
    @memcpy(lower_buf[0..token.len], token);
    const lower = lower_buf[0..token.len];
    toLowerInPlace(lower);

    if (std.mem.eql(u8, lower, "a") or std.mem.eql(u8, lower, "allin") or std.mem.eql(u8, lower, "all-in")) {
        return all_in_spec;
    }
    if (std.mem.eql(u8, lower, "none") or std.mem.eql(u8, lower, "x")) {
        return explicit_empty_spec;
    }
    if (lower[lower.len - 1] == 'e') {
        const prefix = lower[0 .. lower.len - 1];
        var streets: i32 = 0;
        if (prefix.len != 0) {
            streets = std.fmt.parseInt(i32, prefix, 10) catch return error.InvalidSizeSpec;
            if (streets <= 0 or streets > 100) return error.InvalidSizeSpec;
        }
        return geometricSpec(streets);
    }
    if (lower[lower.len - 1] == 'x') {
        if (!allow_multiple) return error.InvalidSizeSpec;
        const prefix = lower[0 .. lower.len - 1];
        const multiple = std.fmt.parseFloat(f64, prefix) catch return error.InvalidSizeSpec;
        if (!(multiple > 0.0)) return error.InvalidSizeSpec;
        return multipleSpec(multiple);
    }
    if (lower[lower.len - 1] == '%') {
        const prefix = lower[0 .. lower.len - 1];
        const percent = std.fmt.parseFloat(f64, prefix) catch return error.InvalidSizeSpec;
        if (!std.math.isFinite(percent)) return error.InvalidSizeSpec;
        return percent / 100.0;
    }
    if (lower[lower.len - 1] == 'c') {
        const prefix = lower[0 .. lower.len - 1];
        const chips = std.fmt.parseFloat(f64, prefix) catch return error.InvalidSizeSpec;
        if (!(chips > 0.0)) return error.InvalidSizeSpec;
        return -chips;
    }
    const fraction = std.fmt.parseFloat(f64, lower) catch return error.InvalidSizeSpec;
    if (!std.math.isFinite(fraction) or fraction < 0.0) return error.InvalidSizeSpec;
    return fraction;
}

pub fn formatSpec(spec: f64, buf: []u8) SpecError![]const u8 {
    var fbs = std.io.fixedBufferStream(buf);
    const w = fbs.writer();
    if (isExplicitEmptySpec(spec)) {
        w.writeAll("-") catch return error.InvalidSizeSpec;
    } else if (isAllInSpec(spec)) {
        w.writeAll("a") catch return error.InvalidSizeSpec;
    } else if (isGeometricSpec(spec)) {
        const streets = geometricStreetsOf(spec);
        if (streets <= 0) {
            w.writeAll("e") catch return error.InvalidSizeSpec;
        } else {
            w.print("{d}e", .{streets}) catch return error.InvalidSizeSpec;
        }
    } else if (isMultipleSpec(spec)) {
        w.print("{d}x", .{multipleOf(spec)}) catch return error.InvalidSizeSpec;
    } else if (spec < 0.0) {
        w.print("{d}c", .{-spec}) catch return error.InvalidSizeSpec;
    } else {
        w.print("{d}", .{spec}) catch return error.InvalidSizeSpec;
    }
    return fbs.getWritten();
}

test "pio tokens" {
    try std.testing.expect(isAllInSpec(try parseSizeToken("a", false)));
    try std.testing.expect(isGeometricSpec(try parseSizeToken("e", false)));
    try std.testing.expect(isGeometricSpec(try parseSizeToken("2e", false)));
    try std.testing.expect(isMultipleSpec(try parseSizeToken("2.5x", true)));
    try std.testing.expect(isChipSpec(try parseSizeToken("20c", false)));
    try std.testing.expectApproxEqAbs(@as(f64, 0.75), try parseSizeToken("75%", false), 1e-12);
    try std.testing.expect(isExplicitEmptySpec(try parseSizeToken("-", false)));
}

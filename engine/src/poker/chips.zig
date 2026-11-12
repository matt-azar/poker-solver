const std = @import("std");

/// Fixed-point chips stored as integer tenths (scale 10).
pub const Chip = i32;
pub const chip_scale: Chip = 10;
pub const min_chip_add: Chip = 1;

pub const ChipError = error{InvalidChipAmount};

pub fn chipUnits(whole_chips: i32) Chip {
    return whole_chips * chip_scale;
}

pub fn chipsToTenths(chips: f64) ChipError!Chip {
    if (!std.math.isFinite(chips)) return error.InvalidChipAmount;
    return @intFromFloat(@round(chips * @as(f64, @floatFromInt(chip_scale))));
}

pub fn tenthsToChips(tenths: Chip) f64 {
    return @as(f64, @floatFromInt(tenths)) / @as(f64, @floatFromInt(chip_scale));
}

pub fn roundChips(fraction: f64, basis_tenths: Chip) ChipError!Chip {
    if (basis_tenths < 0) return error.InvalidChipAmount;
    return @intFromFloat(@round(fraction * @as(f64, @floatFromInt(basis_tenths))));
}

pub fn absoluteChipsToTenths(absolute_chips: f64) ChipError!Chip {
    return chipsToTenths(absolute_chips);
}

pub fn formatChips(tenths: Chip, trim_whole: bool, buf: []u8) ChipError![]const u8 {
    const negative = tenths < 0;
    const magnitude: Chip = if (negative) -tenths else tenths;
    const whole = @divTrunc(magnitude, chip_scale);
    const frac = @mod(magnitude, chip_scale);
    var fbs = std.io.fixedBufferStream(buf);
    const w = fbs.writer();
    if (negative) w.writeByte('-') catch return error.InvalidChipAmount;
    w.print("{d}", .{whole}) catch return error.InvalidChipAmount;
    if (!(trim_whole and frac == 0)) {
        w.print(".{d}", .{frac}) catch return error.InvalidChipAmount;
    }
    return fbs.getWritten();
}

pub fn parseChips(text: []const u8) ChipError!Chip {
    if (text.len == 0) return error.InvalidChipAmount;
    const value = std.fmt.parseFloat(f64, text) catch return error.InvalidChipAmount;
    if (!std.math.isFinite(value)) return error.InvalidChipAmount;
    return chipsToTenths(value);
}

test "chip units" {
    try std.testing.expectEqual(@as(Chip, 1000), chipUnits(100));
    try std.testing.expectEqual(@as(Chip, 1000), try parseChips("100"));
    try std.testing.expectEqual(@as(Chip, 38), try parseChips("3.8"));
}

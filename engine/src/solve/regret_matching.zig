const std = @import("std");

pub fn regretMatching(regrets: []const f32, current: []f32) void {
    std.debug.assert(regrets.len == current.len);
    const n = regrets.len;
    var normalizing: f64 = 0;
    var a: usize = 0;
    while (a < n) : (a += 1) {
        const value: f64 = regrets[a];
        const positive = if (value > 0.0) value else 0.0;
        current[a] = @floatCast(positive);
        normalizing += positive;
    }
    if (normalizing > 0.0) {
        a = 0;
        while (a < n) : (a += 1) {
            current[a] = @floatCast(@as(f64, @floatCast(current[a])) / normalizing);
        }
        return;
    }
    const uniform: f32 = @floatCast(1.0 / @as(f64, @floatFromInt(n)));
    @memset(current, uniform);
}

pub fn accumulateAverage(strategy_sum: []f32, current: []const f32, reach_i: f64) void {
    std.debug.assert(strategy_sum.len == current.len);
    var a: usize = 0;
    while (a < strategy_sum.len) : (a += 1) {
        strategy_sum[a] = @floatCast(@as(f64, @floatCast(strategy_sum[a])) + reach_i * @as(f64, @floatCast(current[a])));
    }
}

pub fn normalizeAverage(strategy_sum: []const f32, out: []f32) void {
    std.debug.assert(strategy_sum.len == out.len);
    var total: f64 = 0;
    for (strategy_sum) |s| total += s;
    if (total > 0.0) {
        var a: usize = 0;
        while (a < out.len) : (a += 1) {
            out[a] = @floatCast(@as(f64, @floatCast(strategy_sum[a])) / total);
        }
        return;
    }
    const uniform: f32 = @floatCast(1.0 / @as(f64, @floatFromInt(out.len)));
    @memset(out, uniform);
}

pub fn floorRegrets(regrets: []f32) void {
    for (regrets) |*r| {
        if (r.* < 0) r.* = 0;
    }
}

test "regret matching positive mass" {
    var current: [2]f32 = undefined;
    regretMatching(&.{ 1.0, 3.0 }, &current);
    try std.testing.expectApproxEqAbs(@as(f32, 0.25), current[0], 1e-6);
    try std.testing.expectApproxEqAbs(@as(f32, 0.75), current[1], 1e-6);
}

test "regret matching uniform when nonpositive" {
    var current: [3]f32 = undefined;
    regretMatching(&.{ -1.0, 0.0, -2.0 }, &current);
    try std.testing.expectApproxEqAbs(@as(f32, 1.0 / 3.0), current[0], 1e-6);
}

const std = @import("std");

/// Debug-only: σ / average rows must be finite, non-negative, and sum≈1 (ZR-125 / Tiger).
/// Tolerance matches Session.validateAveragePolicy (f32 publish), not lock f64 1e-12.
const probability_row_sum_tolerance: f64 = 1e-5;

fn assertProbabilityRow(row: []const f32) void {
    std.debug.assert(row.len > 0);
    var sum: f64 = 0;
    for (row) |p| {
        std.debug.assert(std.math.isFinite(p));
        std.debug.assert(p >= 0);
        sum += p;
    }
    std.debug.assert(@abs(sum - 1.0) <= probability_row_sum_tolerance);
}

pub fn regretMatching(regrets: []const f32, current: []f32) void {
    std.debug.assert(regrets.len == current.len);
    const n = regrets.len;
    std.debug.assert(n > 0);
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
        assertProbabilityRow(current);
        return;
    }
    const uniform: f32 = @floatCast(1.0 / @as(f64, @floatFromInt(n)));
    @memset(current, uniform);
    assertProbabilityRow(current);
}

pub fn accumulateAverage(strategy_sum: []f32, current: []const f32, reach_i: f64) void {
    std.debug.assert(strategy_sum.len == current.len);
    // Own-reach mass used for averaging must stay non-negative (frozen walk invariant).
    std.debug.assert(reach_i >= 0);
    var a: usize = 0;
    while (a < strategy_sum.len) : (a += 1) {
        strategy_sum[a] = @floatCast(@as(f64, @floatCast(strategy_sum[a])) + reach_i * @as(f64, @floatCast(current[a])));
    }
}

pub fn normalizeAverage(strategy_sum: []const f32, out: []f32) void {
    std.debug.assert(strategy_sum.len == out.len);
    std.debug.assert(out.len > 0);
    var total: f64 = 0;
    for (strategy_sum) |s| total += s;
    if (total > 0.0) {
        var a: usize = 0;
        while (a < out.len) : (a += 1) {
            out[a] = @floatCast(@as(f64, @floatCast(strategy_sum[a])) / total);
        }
        assertProbabilityRow(out);
        return;
    }
    const uniform: f32 = @floatCast(1.0 / @as(f64, @floatFromInt(out.len)));
    @memset(out, uniform);
    assertProbabilityRow(out);
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

test "regret matching yields non-negative probability row" {
    // ZR-125: freeze multiplies reach by σ; rows must stay non-neg and sum≈1.
    var current: [4]f32 = undefined;
    regretMatching(&.{ -2.0, 0.5, 1.5, -0.25 }, &current);
    var sum: f64 = 0;
    for (current) |p| {
        try std.testing.expect(p >= 0);
        sum += p;
    }
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), sum, 1e-6);

    regretMatching(&.{ -1.0, -1.0, -1.0, -1.0 }, &current);
    sum = 0;
    for (current) |p| {
        try std.testing.expect(p >= 0);
        sum += p;
    }
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), sum, 1e-6);
}

test "normalizeAverage yields non-negative probability row" {
    var out: [3]f32 = undefined;
    normalizeAverage(&.{ 1.0, 3.0, 0.0 }, &out);
    var sum: f64 = 0;
    for (out) |p| {
        try std.testing.expect(p >= 0);
        sum += p;
    }
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), sum, 1e-6);
}

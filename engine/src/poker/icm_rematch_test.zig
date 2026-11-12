//! ICM rematch pins vs tip C++ `test_icm.cpp` / docs/auxiliary/payoffs/ICM.md.
const std = @import("std");
const icm = @import("icm.zig");
const payoff = @import("payoff.zig");

test "icm equities HU WTA and second-place pins" {
    {
        const stacks = [_]f64{ 1000, 1000 };
        const payouts = [_]f64{ 100, 0 };
        const eq = try icm.icmEquities(std.testing.allocator, &stacks, &payouts);
        defer std.testing.allocator.free(eq);
        try std.testing.expectApproxEqAbs(@as(f64, 50.0), eq[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, 50.0), eq[1], 1e-12);
    }
    {
        const stacks = [_]f64{ 700, 300 };
        const payouts = [_]f64{100};
        const eq = try icm.icmEquities(std.testing.allocator, &stacks, &payouts);
        defer std.testing.allocator.free(eq);
        try std.testing.expectApproxEqAbs(@as(f64, 70.0), eq[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, 30.0), eq[1], 1e-12);
    }
    {
        const stacks = [_]f64{ 1000, 1000 };
        const payouts = [_]f64{ 70, 30 };
        const eq = try icm.icmEquities(std.testing.allocator, &stacks, &payouts);
        defer std.testing.allocator.free(eq);
        try std.testing.expectApproxEqAbs(@as(f64, 50.0), eq[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, 50.0), eq[1], 1e-12);
    }
}

test "icm three-player Malmuth-Harville pin" {
    const stacks = [_]f64{ 5000, 3000, 2000 };
    const payouts = [_]f64{ 50, 30, 20 };
    const eq = try icm.icmEquities(std.testing.allocator, &stacks, &payouts);
    defer std.testing.allocator.free(eq);
    try std.testing.expectApproxEqAbs(1075.0 / 28.0, eq[0], 1e-9);
    try std.testing.expectApproxEqAbs(131.0 / 4.0, eq[1], 1e-9);
    try std.testing.expectApproxEqAbs(202.0 / 7.0, eq[2], 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 100.0), eq[0] + eq[1] + eq[2], 1e-9);
}

test "icm zero-stack seat eliminated" {
    const stacks = [_]f64{ 1000, 0, 1000 };
    const payouts = [_]f64{ 80, 20 };
    const eq = try icm.icmEquities(std.testing.allocator, &stacks, &payouts);
    defer std.testing.allocator.free(eq);
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), eq[0], 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), eq[1], 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), eq[2], 1e-12);
}

test "icm rejects bad inputs" {
    {
        const stacks = [_]f64{};
        const payouts = [_]f64{1};
        try std.testing.expectError(error.InvalidIcm, icm.icmEquities(std.testing.allocator, &stacks, &payouts));
    }
    {
        const stacks = [_]f64{ 100, -1 };
        const payouts = [_]f64{1};
        try std.testing.expectError(error.InvalidIcm, icm.validateInputs(&stacks, &payouts));
    }
    {
        const stacks = [_]f64{ 0, 0 };
        const payouts = [_]f64{1};
        try std.testing.expectError(error.InvalidIcm, icm.icmEquities(std.testing.allocator, &stacks, &payouts));
    }
    {
        const stacks = [_]f64{ 100, 100 };
        const payouts = [_]f64{-1};
        try std.testing.expectError(error.InvalidIcm, icm.icmEquities(std.testing.allocator, &stacks, &payouts));
    }
}

test "applyIcmTerminal chip→ICM delta pins" {
    // WTA: chip (+100,-100) → ICM (+5,-5)
    {
        const stacks = [_]f64{ 1000, 1000 };
        const payouts = [_]f64{ 100, 0 };
        const cfg = icm.IcmConfig{ .stacks = &stacks, .payouts = &payouts };
        const chips = payoff.PlayerPayoff{ .utility = .{ 100, -100 } };
        const delta = try icm.applyIcmTerminal(std.testing.allocator, cfg, chips);
        try std.testing.expectApproxEqAbs(@as(f64, 5.0), delta.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, -5.0), delta.utility[1], 1e-12);
    }
    // Second place 70/30: chip (+100,-100) → (+2,-2)
    {
        const stacks = [_]f64{ 1000, 1000 };
        const payouts = [_]f64{ 70, 30 };
        const cfg = icm.IcmConfig{ .stacks = &stacks, .payouts = &payouts };
        const chips = payoff.PlayerPayoff{ .utility = .{ 100, -100 } };
        const delta = try icm.applyIcmTerminal(std.testing.allocator, cfg, chips);
        try std.testing.expectApproxEqAbs(@as(f64, 2.0), delta.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, -2.0), delta.utility[1], 1e-12);
    }
    // Real ChipPayoff fold (50,-50) + WTA → (+2.5,-2.5)
    {
        const chips = try payoff.chipTerminal(1000, 1000, 0, 1, 0, .{});
        try std.testing.expectApproxEqAbs(@as(f64, 50.0), chips.utility[0], 1e-12);
        const stacks = [_]f64{ 1000, 1000 };
        const payouts = [_]f64{100};
        const cfg = icm.IcmConfig{ .stacks = &stacks, .payouts = &payouts };
        const delta = try icm.applyIcmTerminal(std.testing.allocator, cfg, chips);
        try std.testing.expectApproxEqAbs(@as(f64, 2.5), delta.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, -2.5), delta.utility[1], 1e-12);
    }
    // Negative post-stack rejected.
    {
        const stacks = [_]f64{ 40, 40 };
        const payouts = [_]f64{100};
        const cfg = icm.IcmConfig{ .stacks = &stacks, .payouts = &payouts };
        const chips = payoff.PlayerPayoff{ .utility = .{ 50, -50 } };
        try std.testing.expectError(error.InvalidIcm, icm.applyIcmTerminal(std.testing.allocator, cfg, chips));
    }
}

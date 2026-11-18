//! ICM rematch pins vs tip C++ `test_icm.cpp` / docs/auxiliary/payoffs/ICM.md.
const std = @import("std");
const icm = @import("icm.zig");
const payoff = @import("payoff.zig");
const chips = @import("chips.zig");

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
    // Post-hand equity only: busted seat finishes 3rd unpaid → 0.
    // Solve configs must not start with zeros (see validateStartingStacks).
    const stacks = [_]f64{ 1000, 0, 1000 };
    const payouts = [_]f64{ 80, 20 };
    const eq = try icm.icmEquities(std.testing.allocator, &stacks, &payouts);
    defer std.testing.allocator.free(eq);
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), eq[0], 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 0.0), eq[1], 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 50.0), eq[2], 1e-12);
}

test "icm busted seat receives paid last place" {
    // Post-hand: seat 0 busted this hand → 3rd of remaining field → payouts[2].
    const stacks = [_]f64{ 0, 1650, 8350 };
    const payouts = [_]f64{ 50, 30, 20 };
    const eq = try icm.icmEquities(std.testing.allocator, &stacks, &payouts);
    defer std.testing.allocator.free(eq);
    try std.testing.expectApproxEqAbs(@as(f64, 20.0), eq[0], 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 33.3), eq[1], 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 46.7), eq[2], 1e-9);
    try std.testing.expectApproxEqAbs(@as(f64, 100.0), eq[0] + eq[1] + eq[2], 1e-9);
}

test "starting stacks reject already-out zeros; remaining field bust gets third" {
    // Including an already-out 0 with full payout ladder steals 3rd for seat order.
    {
        const bad_stacks = [_]f64{ 150, 1500, 8350, 0 };
        const bad_payouts = [_]f64{ 50, 30, 15, 5 };
        const cfg = icm.IcmConfig{ .stacks = &bad_stacks, .payouts = &bad_payouts };
        try std.testing.expectError(
            error.InvalidIcm,
            cfg.validate(chips.chipUnits(100), chips.chipUnits(100)),
        );
        try std.testing.expectError(
            error.InvalidIcm,
            icm.validateStartingStacks(&bad_stacks, &bad_payouts),
        );
        // Equity helper still runs (post-hand path) but assigns by seat order —
        // busted 150 would wrongly get 5. That is why solve rejects starting zeros.
        const post = [_]f64{ 0, 1650, 8350, 0 };
        const wrong = try icm.icmEquities(std.testing.allocator, &post, &bad_payouts);
        defer std.testing.allocator.free(wrong);
        try std.testing.expectApproxEqAbs(@as(f64, 5.0), wrong[0], 1e-12);
    }
    // Remaining field only: prizes for seats still in. Bust → 3rd = 15.
    {
        const stacks = [_]f64{ 150, 1500, 8350 };
        const payouts = [_]f64{ 50, 30, 15 };
        const cfg = icm.IcmConfig{ .stacks = &stacks, .payouts = &payouts };
        try cfg.validate(chips.chipUnits(100), chips.chipUnits(100));
        const lose = payoff.PlayerPayoff{ .utility = .{ -150, 150 } };
        const delta = try icm.applyIcmTerminal(std.testing.allocator, cfg, lose);
        const pre = try icm.icmEquities(std.testing.allocator, &stacks, &payouts);
        defer std.testing.allocator.free(pre);
        try std.testing.expectApproxEqAbs(@as(f64, 15.0), pre[0] + delta.utility[0], 1e-12);
        const post = [_]f64{ 0, 1650, 8350 };
        const post_eq = try icm.icmEquities(std.testing.allocator, &post, &payouts);
        defer std.testing.allocator.free(post_eq);
        try std.testing.expectApproxEqAbs(@as(f64, 15.0), post_eq[0], 1e-12);
    }
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
    {
        const stacks = [_]f64{ 100, 0 };
        const payouts = [_]f64{1};
        try std.testing.expectError(error.InvalidIcm, icm.validateStartingStacks(&stacks, &payouts));
    }
}

test "applyIcmTerminal chip→ICM delta pins" {
    // WTA: chip (+100,-100) → ICM (+5,-5)
    {
        const stacks = [_]f64{ 1000, 1000 };
        const payouts = [_]f64{ 100, 0 };
        const cfg = icm.IcmConfig{ .stacks = &stacks, .payouts = &payouts };
        const chip_pay = payoff.PlayerPayoff{ .utility = .{ 100, -100 } };
        const delta = try icm.applyIcmTerminal(std.testing.allocator, cfg, chip_pay);
        try std.testing.expectApproxEqAbs(@as(f64, 5.0), delta.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, -5.0), delta.utility[1], 1e-12);
    }
    // Second place 70/30: chip (+100,-100) → (+2,-2)
    {
        const stacks = [_]f64{ 1000, 1000 };
        const payouts = [_]f64{ 70, 30 };
        const cfg = icm.IcmConfig{ .stacks = &stacks, .payouts = &payouts };
        const chip_pay = payoff.PlayerPayoff{ .utility = .{ 100, -100 } };
        const delta = try icm.applyIcmTerminal(std.testing.allocator, cfg, chip_pay);
        try std.testing.expectApproxEqAbs(@as(f64, 2.0), delta.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, -2.0), delta.utility[1], 1e-12);
    }
    // Real ChipPayoff fold (50,-50) + WTA → (+2.5,-2.5)
    {
        const chip_pay = try payoff.chipTerminal(1000, 1000, 0, 1, 0, .{});
        try std.testing.expectApproxEqAbs(@as(f64, 50.0), chip_pay.utility[0], 1e-12);
        const stacks = [_]f64{ 1000, 1000 };
        const payouts = [_]f64{100};
        const cfg = icm.IcmConfig{ .stacks = &stacks, .payouts = &payouts };
        const delta = try icm.applyIcmTerminal(std.testing.allocator, cfg, chip_pay);
        try std.testing.expectApproxEqAbs(@as(f64, 2.5), delta.utility[0], 1e-12);
        try std.testing.expectApproxEqAbs(@as(f64, -2.5), delta.utility[1], 1e-12);
    }
    // Negative post-stack rejected.
    {
        const stacks = [_]f64{ 40, 40 };
        const payouts = [_]f64{100};
        const cfg = icm.IcmConfig{ .stacks = &stacks, .payouts = &payouts };
        const chip_pay = payoff.PlayerPayoff{ .utility = .{ 50, -50 } };
        try std.testing.expectError(error.InvalidIcm, icm.applyIcmTerminal(std.testing.allocator, cfg, chip_pay));
    }
}
